// Aggregate orders independently: dashboard joins can repeat a sale once
// per listing, agreement, or crop plan. Never SUM(DISTINCT total_amount):
// separate orders may legitimately have the same amount.
function sellerRevenueSql(monthOnly) {
  return `(SELECT COALESCE(SUM(sale.total_amount), 0)
    FROM orders sale
    WHERE sale.seller_id = $1 AND sale.status = 'delivered'
    ${monthOnly ? "AND date_trunc('month', sale.created_at) = date_trunc('month', now())" : ''})`;
}

module.exports = { sellerRevenueSql };
