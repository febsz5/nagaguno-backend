const express = require('express');
const request = require('supertest');
jest.mock('../config/database', () => ({ queryAsUser: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  authenticate: (req, res, next) => {
    req.user = { id: 'seller1', role: req.headers['x-role'] };
    next();
  },
  authorize: (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.sendStatus(403),
  requireVerified: (req, res, next) => next(),
}));
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const { queryAsUser } = require('../config/database');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(express.json());
app.use('/products', require('../routes/products'));
let upload;
beforeEach(() => {
  jest.clearAllMocks();
  queryAsUser.mockImplementation(async (user, sql) => ({ rows: sql.includes('SELECT barangay')
    ? [{ barangay: 'Cararayan' }] : [{ id: 'p1', image_url: 'https://example.com/product.png' }] }));
  upload = jest.fn(async () => ({ error: null }));
  createClient.mockReturnValue({ storage: { from: () => ({ upload,
    getPublicUrl: () => ({ data: { publicUrl: 'https://example.com/product.png' } }),
  }) } });
});
describe.each(['farmer', 'vendor'])('%s product photo requirement', role => {
  const submit = () => request(app).post('/products').set('x-role', role)
    .field('name', 'Palay').field('category', 'Grains').field('price_per_unit', '100');
  test('missing photo creates no listing', async () => {
    const response = await submit();
    expect(response.status).toBe(400);
    expect(response.body.message).toContain('product photo');
    expect(queryAsUser).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });
  test('a URL in the request cannot substitute for uploading a photo', async () => {
    expect((await submit().field('image_url', 'https://example.com/product.png')).status).toBe(400);
    expect(queryAsUser).not.toHaveBeenCalled();
  });
  test('empty upload creates no listing', async () => {
    expect((await submit().attach('photo', Buffer.alloc(0), 'product.png')).status).toBe(400);
    expect(queryAsUser).not.toHaveBeenCalled();
  });
  test('successful upload is saved with the listing', async () => {
    expect((await submit().attach('photo', Buffer.from('test image'), 'product.png')).status).toBe(201);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(queryAsUser).toHaveBeenCalledWith(expect.objectContaining({ role }),
      expect.stringContaining('INSERT INTO products'), expect.arrayContaining(['https://example.com/product.png']));
  });
  test('failed storage upload creates no listing', async () => {
    upload.mockResolvedValue({ error: { message: 'Storage unavailable' } });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await submit().attach('photo', Buffer.from('test image'), 'product.png')).status).toBe(500);
      expect(queryAsUser.mock.calls.some(([, sql]) => sql.includes('INSERT INTO products'))).toBe(false);
    } finally { log.mockRestore(); }
  });
});
