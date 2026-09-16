// jobs/spoilageAutoDiscount.js
//
// Real gap closed: spoilage STAGE detection was already fully
// automatic (product_spoilage_status is a live database view,
// recalculated on every query from real harvest dates and category
// shelf-life defaults -- verified directly against the live
// database). But turning that into an actual price change required
// two manual steps that were never wired up: a farmer/vendor
// manually reporting spoilage themselves (no automatic scan ever
// existed, despite a code comment elsewhere referencing "the
// automatic cron job" as if it did), and then manually accepting the
// resulting suggestion before the price actually changed.
//
// This job closes both gaps: runs on a schedule, finds live listings
// that have automatically crossed a spoilage threshold and were NOT
// manually reported by their seller (manual reports already have
// their own, separate discount-creation logic in routes/spoilage.js
// -- this job intentionally leaves those alone so the two paths
// don't conflict), applies the matching discount tier immediately
// (no accept step), and notifies the seller afterward so they're
// never surprised by their own price changing.
//
// Uses the plain, privileged `query` (not queryAsUser) throughout --
// this is a background job with no single logged-in user behind it,
// and it needs to write rows on behalf of many different sellers in
// one run. This matches an already-existing, documented pattern in
// this exact codebase (see routes/admin.js's own-account-status
// notification) for precisely this situation: verified live against
// the database that the `notifications` table's RLS policy has no
// admin-write exception at all (unlike products and
// spoilage_price_recommendations, which do) -- a synthetic/fake
// admin user id for queryAsUser's RLS context would have failed
// there specifically. Using the privileged connection consistently
// for the whole job avoids relying on a fake user id trick that
// has no precedent anywhere else in this codebase.

const { query } = require('../config/database');

// Same discount tiers as the existing manual-report flow in
// routes/spoilage.js -- kept in sync intentionally, not duplicated
// by coincidence.
const DISCOUNT_TIERS = { near_spoilage: 0.15, critical: 0.30 };

// Uses source='system' -- the only two valid values for this column
// are 'system' and 'seller' (a real, live enum constraint, verified
// against the actual database before relying on it -- an earlier
// draft of this file invented a third value that didn't exist and
// would have failed outright). Reusing 'system' here, the same value
// the manual-report flow already uses, is safe specifically because
// this job's own candidate query below excludes anything with
// is_manually_reported = true, and manual reports are the only other
// path that ever writes source='system' -- so any 'system' row found
// on a product that ISN'T manually reported can only be this job's
// own prior run.

async function runSpoilageAutoDiscount() {
  const results = { scanned: 0, discounted: 0, expired: 0, errors: 0 };

  try {
    const { rows: candidates } = await query(
      `SELECT product_id, seller_id, stage
       FROM product_spoilage_status
       WHERE stage IN ('near_spoilage', 'critical') AND NOT is_manually_reported`
    );
    results.scanned = candidates.length;

    for (const candidate of candidates) {
      try {
        // Skip if an automatic discount for this EXACT stage was
        // already applied to this product -- without this check, a
        // product sitting in the same stage across multiple runs of
        // this job would get discounted again each time, compounding
        // incorrectly (100 -> 85 -> 72.25 -> ...) instead of once.
        const { rows: existing } = await query(
          `SELECT id FROM spoilage_price_recommendations
           WHERE product_id = $1 AND stage = $2 AND source = 'system'`,
          [candidate.product_id, candidate.stage]
        );
        if (existing.length) continue;

        // The TRUE original price -- if this product was already
        // auto-discounted once before (e.g. near_spoilage already
        // applied, now escalating to critical), the discount for the
        // new, more severe tier must still be calculated from the
        // product's real original price, not from the
        // already-reduced current price_per_unit. Falls back to the
        // current price only if this is the product's first-ever
        // automatic discount.
        const { rows: priorAuto } = await query(
          `SELECT original_price FROM spoilage_price_recommendations
           WHERE product_id = $1 AND source = 'system'
           ORDER BY created_at ASC LIMIT 1`,
          [candidate.product_id]
        );

        const { rows: prodRows } = await query(
          `SELECT price_per_unit, name FROM products WHERE id = $1 AND status = 'live'`,
          [candidate.product_id]
        );
        if (!prodRows.length) continue; // delisted between the scan and now

        const originalPrice = priorAuto.length ? Number(priorAuto[0].original_price) : Number(prodRows[0].price_per_unit);
        const discountPct = DISCOUNT_TIERS[candidate.stage];
        const newPrice = Math.round(originalPrice * (1 - discountPct) * 100) / 100;

        await query(
          `INSERT INTO spoilage_price_recommendations
             (product_id, stage, original_price, recommended_discount_pct, recommended_price, source, status, responded_at)
           VALUES ($1, $2, $3, $4, $5, 'system', 'accepted', NOW())`,
          [candidate.product_id, candidate.stage, originalPrice, discountPct, newPrice]
        );

        await query(`UPDATE products SET price_per_unit = $1 WHERE id = $2`, [newPrice, candidate.product_id]);

        await query(
          `INSERT INTO notifications (user_id, type, title, message)
           VALUES ($1, $2, 'Price automatically reduced', $3)`,
          [
            candidate.seller_id,
            // These two enum values already existed in the schema
            // for exactly this purpose (verified live) but were
            // never actually used anywhere in the codebase until now
            // -- another sign this whole feature was anticipated but
            // never finished being wired up.
            candidate.stage === 'critical' ? 'spoilage_critical' : 'spoilage_warning',
            `"${prodRows[0].name}" was automatically discounted ${Math.round(discountPct * 100)}% (to \u20b1${newPrice}) because it's ${candidate.stage === 'critical' ? 'close to spoiling' : 'nearing its shelf-life estimate'}. You can adjust the price anytime from your listings.`,
          ]
        );

        results.discounted += 1;
      } catch (err) {
        results.errors += 1;
        console.error(`spoilageAutoDiscount: failed for product ${candidate.product_id}`, err);
      }
    }

    // Real, new feature: expired listings were previously left alone
    // entirely -- no discount tier exists for 'expired' in either
    // this job or the manual-report flow (verified directly against
    // both this session), so a fully expired product just stayed
    // live at its original price with nothing stopping a purchase.
    // This hides it from the marketplace automatically and notifies
    // the seller, rather than silently discounting something already
    // past its estimated shelf life -- the seller can review, edit,
    // and either unhide it (if the estimate was simply wrong for
    // this specific batch) or report a corrected status/start a sale
    // once they've actually checked it.
    const { rows: expiredCandidates } = await query(
      `SELECT product_id, seller_id, name
       FROM product_spoilage_status
       WHERE stage = 'expired' AND NOT is_manually_reported AND product_status = 'live'`
    );

    for (const candidate of expiredCandidates) {
      try {
        await query(`UPDATE products SET status = 'hidden', auto_hidden_reason = 'expired' WHERE id = $1`, [candidate.product_id]);
        await query(
          `INSERT INTO notifications (user_id, type, title, message)
           VALUES ($1, 'spoilage_expired', 'Listing automatically hidden', $2)`,
          [
            candidate.seller_id,
            `"${candidate.name}" was automatically hidden from the marketplace because it's past its estimated shelf life. If this estimate doesn't match the actual condition of this batch, you can unhide it, update its status, or start a sale from your listings.`,
          ]
        );
        results.expired += 1;
      } catch (err) {
        results.errors += 1;
        console.error(`spoilageAutoDiscount: failed to hide expired product ${candidate.product_id}`, err);
      }
    }
  } catch (err) {
    console.error('spoilageAutoDiscount: scan failed', err);
    results.errors += 1;
  }

  return results;
}

module.exports = { runSpoilageAutoDiscount, DISCOUNT_TIERS };