jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
const savedEnv = { ...process.env };
let mailer;
let sendMail;
beforeEach(() => {
  jest.resetModules();
  process.env = { ...savedEnv, NODE_ENV: 'development' };
  delete process.env.RESEND_API_KEY;
  delete process.env.DEV_EMAIL_USER;
  delete process.env.DEV_EMAIL_PASS;
  mailer = require('nodemailer');
  sendMail = jest.fn().mockResolvedValue({ messageId: 'test' });
  mailer.createTransport.mockReturnValue({ sendMail });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { process.env = { ...savedEnv }; jest.restoreAllMocks(); });
const send = () => require('../utils/emailService').sendEmail({ to: 'test@example.com', subject: 'Reset', text: 'Test' });
test('development uses configured Resend instead of fake credentials', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  await send();
  expect(mailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.resend.com', secure: true, auth: { user: 'resend', pass: 'test-key' } }));
});
test('explicit development mailbox is supported when Resend is absent', async () => {
  process.env.DEV_EMAIL_USER = 'dev'; process.env.DEV_EMAIL_PASS = 'test';
  await send();
  expect(mailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.ethereal.email' }));
});
test('missing configuration fails clearly without attempting delivery', async () => {
  await expect(send()).rejects.toMatchObject({ code: 'EMAIL_DELIVERY_FAILED' });
  expect(sendMail).not.toHaveBeenCalled();
});
test('SMTP failures carry a safe delivery error code', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  sendMail.mockRejectedValue(new Error('SMTP rejected'));
  await expect(send()).rejects.toMatchObject({ code: 'EMAIL_DELIVERY_FAILED' });
});
