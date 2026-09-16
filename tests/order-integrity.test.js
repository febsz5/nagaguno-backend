const express = require('express');
const request = require('supertest');
jest.mock('../config/database', () => ({ queryAsUser: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../middleware/auth', () => ({ authenticate: (req, res, next) => {
  req.user = { id: req.headers['x-user'] || 'seller', full_name: 'Test' }; next();
}, requireVerified: (req, res, next) => next() }));
const db = require('../config/database');
const app = express(); app.use(express.json()); app.use('/orders', require('../routes/orders'));
let order, client;
beforeEach(() => {
  jest.clearAllMocks();
  order = { buyer_id: 'buyer', seller_id: 'seller', status: 'pending', payment_method: 'online', proof_status: 'pending', payment_proof_url: null };
  db.queryAsUser.mockImplementation(async () => ({ rows: [{ ...order }] }));
  client = { query: jest.fn(async sql => {
    if (sql.includes('FOR UPDATE')) return { rows: [{ ...order }] };
    if (sql.includes('FROM order_items')) return { rows: [{ product_id: 'p1', quantity: 3 }] };
    if (sql.includes('UPDATE orders SET status')) order.status = 'cancelled';
    return { rows: [] };
  }) };
  db.withTransaction.mockImplementation(fn => fn(client));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
test('generic patch cannot set status or verify missing proof', async () => {
  expect((await request(app).patch('/orders/o1').send({ status: 'confirmed', proof_status: 'verified' })).status).toBe(400);
  expect((await request(app).patch('/orders/o1').send({ proof_status: 'verified' })).status).toBe(409);
});
test.each(['preparing', 'dispatched'])('cannot skip pending to %s', async status => {
  expect((await request(app).patch('/orders/o1/status').send({ status })).status).toBe(409);
});
test('buyer cannot claim delivery before dispatch', async () => {
  expect((await request(app).patch('/orders/o1/status').set('x-user', 'buyer').send({ status: 'delivered' })).status).toBe(409);
});
test('cancellation restores inventory once', async () => {
  expect((await request(app).patch('/orders/o1/status').set('x-user', 'buyer').send({ status: 'cancelled' })).status).toBe(200);
  expect((await request(app).patch('/orders/o1/status').set('x-user', 'buyer').send({ status: 'cancelled' })).status).toBe(400);
  expect(client.query.mock.calls.filter(([sql]) => sql.includes('stock_qty +'))).toHaveLength(1);
});
test('seller can review actual pending proof', async () => {
  order.payment_proof_url = 'https://example.com/proof.png';
  expect((await request(app).patch('/orders/o1').send({ proof_status: 'verified' })).status).toBe(200);
});
test.each([-1, 0, 'invalid'])('rejects invalid quantity %s before transaction', async quantity => {
  expect((await request(app).post('/orders').set('x-user', 'buyer').send({ seller_id: 'seller', items: [{ product_id: 'p1', quantity }] })).status).toBe(400);
  expect(db.withTransaction).not.toHaveBeenCalled();
});
test('cannot replace verified proof', async () => {
  order.proof_status = 'verified';
  expect((await request(app).post('/orders/o1/proof').set('x-user', 'buyer').attach('proof', Buffer.from('test'), 'proof.png')).status).toBe(409);
});
test('duplicate lines are combined and rejected if their total exceeds stock', async () => {
  client.query.mockImplementation(async sql => {
    if (sql.includes('FROM users')) return { rows: [{ role: 'farmer' }] };
    if (sql.includes('FROM products')) return { rows: [{ name: 'Palay', stock_qty: 10, price_per_unit: 20, unit: 'kg' }] };
    return { rows: [] };
  });
  const result = await request(app).post('/orders').set('x-user', 'buyer').send({ seller_id: 'seller', items: [
    { product_id: 'p1', quantity: 6 }, { product_id: 'p1', quantity: 6 },
  ] });
  expect(result.status).toBe(400);
  expect(client.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO orders'))).toBe(false);
  expect(client.query.mock.calls.find(([sql]) => sql.includes('FROM products'))[0]).toContain('FOR UPDATE');
});
test('state changed after initial read is rejected under the row lock', async () => {
  order.status = 'confirmed';
  client.query.mockImplementation(async () => ({ rows: [{ ...order, status: 'cancelled' }] }));
  expect((await request(app).patch('/orders/o1/status').send({ status: 'preparing' })).status).toBe(409);
  expect(client.query.mock.calls.some(([sql]) => sql.includes('UPDATE orders'))).toBe(false);
});
