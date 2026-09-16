// utils/agreementMinimums.js
//
// Real, new logic: a Smart Agreement is a bulk reservation, not a
// regular marketplace order -- it should require a meaningfully
// large quantity, not just "more than zero". Two real considerations
// combined here, matching what was actually asked for:
//
// 1. A sensible ABSOLUTE floor per unit type -- "20kg" means
//    something different from "20 sacks" or "20 pieces", so each
//    unit gets its own realistic bulk floor rather than one number
//    applied to everything.
// 2. PROPORTIONAL to what the seller actually has available -- a
//    flat "20kg minimum" would be an impossible, meaningless
//    requirement against a listing that only has 15kg in stock. The
//    real minimum is the smaller of the unit's floor and half the
//    available stock, so it's always achievable, and a maximum is
//    always the full available stock (an agreement can't reserve
//    more than actually exists).

const UNIT_MINIMUMS = {
  kg: 20,
  g: 2000,
  sack: 5,
  bundle: 10,
  piece: 10,
  liter: 20,
};

function computeAgreementQuantityBounds(stockQty, unit) {
  const floor = UNIT_MINIMUMS[unit] ?? 10; // generic fallback for any unit not listed above
  const min = Math.min(floor, stockQty * 0.5);
  return { min, max: stockQty };
}

module.exports = { computeAgreementQuantityBounds, UNIT_MINIMUMS };