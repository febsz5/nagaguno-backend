const express = require('express');
const request = require('supertest');

jest.mock('../config/database', () => ({ queryAsUser: jest.fn(), withTransaction: jest.fn() }));
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ storage: { from: () => ({
    upload: async () => ({ error: null }),
    getPublicUrl: () => ({ data: { publicUrl: 'https://example.com/proof.png' } }),
  }) } }),
}));
jest.mock('../middleware/auth', () => ({
  authenticate: (req, res, next) => {
    req.user = { id: req.headers['x-user'] || 'seller', full_name: 'Test User' };
    next();
  },
  requireVerified: (req, res, next) => next(),
}));

const db = require('../config/database');
const app = express();
app.use(express.json());
app.use('/agreements', require('../routes/agreement'));
let agreement;
let client;

beforeEach(() => {
  jest.clearAllMocks();
  agreement = { id: 'ag1', buyer_id: 'buyer', seller_id: 'seller', status: 'active', proof_status: 'none', payment_proof_url: null, quantity: 30 };
  db.queryAsUser.mockImplementation(async () => ({ rows: [agreement] }));
  client = { query: jest.fn(async () => ({ rows: [agreement] })) };
  db.withTransaction.mockImplementation(fn => fn(client));
});

test.each(['confirm', 'reject'])('cannot %s missing payment proof', async action => {
  const result = await request(app).patch('/agreements/ag1/proof').send({ action });
  expect(result.status).toBe(400);
  expect(db.withTransaction).not.toHaveBeenCalled();
});

test.each(['pending', 'cancelled', 'fulfilled'])('cannot confirm proof for %s agreement', async status => {
  Object.assign(agreement, { status, proof_status: 'pending', payment_proof_url: 'https://example.com/proof.jpg' });
  expect((await request(app).patch('/agreements/ag1/proof').send({ action: 'confirm' })).status).toBe(400);
});

test.each(['confirm', 'reject'])('seller can %s uploaded proof on approved agreement', async action => {
  Object.assign(agreement, { proof_status: 'pending', payment_proof_url: 'https://example.com/proof.jpg' });
  expect((await request(app).patch('/agreements/ag1/proof').send({ action })).status).toBe(200);
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), ['ag1']);
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE agreements'), expect.any(Array));
});

test('buyer cannot self-verify using generic update', async () => {
  Object.assign(agreement, { proof_status: 'pending', payment_proof_url: 'https://example.com/proof.jpg' });
  expect((await request(app).patch('/agreements/ag1').set('x-user', 'buyer').send({ proof_status: 'verified' })).status).toBe(403);
});

test.each([{ proof_status: 'verified' }, { status: 'fulfilled' }, { status: 'active', proof_status: 'verified' }])('generic update cannot bypass payment requirement: %j', async body => {
  expect([400, 403]).toContain((await request(app).patch('/agreements/ag1').send(body)).status);
});

test('approval is separate from payment confirmation', async () => {
  agreement.status = 'pending';
  expect((await request(app).patch('/agreements/ag1').send({ status: 'active' })).status).toBe(200);
  const update = client.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE agreements'));
  expect(update[0]).not.toContain('proof_status =');
});

test.each(['pending', 'verified'])('buyer cannot overwrite %s proof', async proof_status => {
  agreement.proof_status = proof_status;
  agreement.payment_proof_url = 'https://example.com/existing-proof.png';
  expect((await request(app).post('/agreements/ag1/proof').set('x-user', 'buyer')
    .attach('proof', Buffer.from('test'), 'proof.png')).status).toBe(400);
});

test('buyer cannot upload before approval', async () => {
  agreement.status = 'pending';
  expect((await request(app).post('/agreements/ag1/proof').set('x-user', 'buyer')
    .attach('proof', Buffer.from('test'), 'proof.png')).status).toBe(400);
});

test.each(['none', 'rejected', 'pending'])('buyer can upload proof after approval with %s proof status and no file', async proof_status => {
  agreement.proof_status = proof_status;
  const response = await request(app).post('/agreements/ag1/proof').set('x-user', 'buyer')
    .attach('proof', Buffer.from('test'), 'proof.png');
  expect(response.status).toBe(200);
  expect(response.body.data.url).toBe('https://example.com/proof.png');
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining("proof_status      = 'pending'"),
    ['https://example.com/proof.png', 'ag1']);
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO notifications'),
    expect.arrayContaining(['seller', 'proof_uploaded']));
});

test.each([null, '', '   '])('pending proof without a file (%j) cannot be confirmed', async payment_proof_url => {
  Object.assign(agreement, { proof_status: 'pending', payment_proof_url });
  expect((await request(app).patch('/agreements/ag1/proof').send({ action: 'confirm' })).status).toBe(400);
});

test('only the buyer can complete a paid agreement', async () => {
  Object.assign(agreement, { proof_status: 'verified', payment_proof_url: 'https://example.com/proof.png' });
  expect((await request(app).patch('/agreements/ag1').send({ status: 'fulfilled' })).status).toBe(403);
  expect((await request(app).patch('/agreements/ag1').set('x-user', 'buyer').send({ status: 'fulfilled' })).status).toBe(200);
});

test('product agreement approval reserves stock under a lock', async () => {
  Object.assign(agreement, { status: 'pending', product_id: 'p1', quantity: 30 });
  client.query.mockImplementation(async sql => ({ rows: sql.includes('FROM products') ? [{ stock_qty: 40 }] : [agreement] }));
  expect((await request(app).patch('/agreements/ag1').send({ status: 'active' })).status).toBe(200);
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining('stock_qty = stock_qty -'), [30, 'p1']);
});

test('crop approval rejects commitments exceeding available yield', async () => {
  Object.assign(agreement, { status: 'pending', crop_plan_id: 'c1', quantity: 30 });
  client.query.mockImplementation(async sql => ({ rows: sql.includes('FROM crop_plans') ? [{ quantity_kg: 40 }] : sql.includes('SUM(quantity)') ? [{ reserved: 30 }] : [agreement] }));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await request(app).patch('/agreements/ag1').send({ status: 'active' })).status).toBe(409);
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE agreements'))).toBe(false);
  } finally { log.mockRestore(); }
});
