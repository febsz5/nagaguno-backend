const express = require('express');
const request = require('supertest');
jest.mock('../config/database', () => ({ queryAsUser: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  authenticate: (req, res, next) => {
    req.user = { id: 'user1', role: req.headers['x-role'], full_name: 'Seller' };
    next();
  },
  requireVerified: (req, res, next) => next(),
}));
const db = require('../config/database');
const app = express();
app.use(express.json());
app.use('/orders', require('../routes/orders'));
app.use('/agreements', require('../routes/agreement'));
let writes;
beforeEach(() => {
  jest.clearAllMocks();
  writes = [];
  db.withTransaction.mockImplementation(async fn => fn({ query: async (sql, params) => {
    if (sql.includes('FROM users')) return { rows: [{ role: 'farmer' }] };
    if (sql.includes('FROM products')) return { rows: [{ id: 'p1', name: 'Palay', unit: 'kg', stock_qty: 100, price_per_unit: 10, product_seller_id: 'other' }] };
    if (sql.includes('FROM crop_plans')) return { rows: [{ crop_name: 'Palay', unit: 'kg', quantity_kg: 100, farmer_id: 'other', stage: 'planted' }] };
    writes.push({ sql, params });
    return { rows: [{ id: 'created1' }] };
  } }));
});
const flows = [
  ['/orders', { items: [{ product_id: 'p1', quantity: 30 }] }],
  ['/agreements', { product_id: 'p1', quantity: 30, price_per_unit: 10 }],
  ['/agreements', { crop_plan_id: 'c1', quantity: 30, price_per_unit: 10 }],
];
describe.each(['farmer', 'vendor'])('%s ownership restriction', role => {
  test.each(flows)('rejects own listing in %s (%j) without creating anything', async (route, data) => {
    const result = await request(app).post(route).set('x-role', role).send({ ...data, seller_id: 'user1' });
    expect(result.status).toBe(403);
    expect(result.body.message).toBe('You cannot request your own listing.');
    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
  test.each(flows)('preserves another seller transaction in %s (%j)', async (route, data) => {
    const result = await request(app).post(route).set('x-role', role).send({ ...data, seller_id: 'other' });
    expect(result.status).toBe(201);
    expect(writes.some(({ sql }) => sql.includes('INSERT INTO'))).toBe(true);
  });
});
