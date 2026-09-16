jest.mock('twilio', () => jest.fn());
const env = { ...process.env };
let create;
beforeEach(() => {
  jest.resetModules();
  process.env = { ...env, TWILIO_ACCOUNT_SID: 'test', TWILIO_AUTH_TOKEN: 'test', TWILIO_PHONE_NUMBER: '+15555555555' };
  create = jest.fn().mockResolvedValue({ sid: 'test' });
  require('twilio').mockReturnValue({ messages: { create } });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { process.env = { ...env }; jest.restoreAllMocks(); });
test('normalizes local Philippine recipient', async () => {
  await require('../utils/smsService').sendSMS({ to: '09123456789', body: 'test' });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ to: '+639123456789' }));
});
test('preserves international recipient', async () => {
  await require('../utils/smsService').sendSMS({ to: '+639123456789', body: 'test' });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ to: '+639123456789' }));
});
test('missing configuration does not pretend delivery succeeded', async () => {
  delete process.env.TWILIO_AUTH_TOKEN;
  await expect(require('../utils/smsService').sendSMS({ to: '09123456789', body: 'test' })).rejects.toMatchObject({ code: 'SMS_DELIVERY_FAILED' });
  expect(create).not.toHaveBeenCalled();
});
test('provider rejection has a safe delivery error code', async () => {
  create.mockRejectedValue({ code: 21211, status: 400 });
  await expect(require('../utils/smsService').sendSMS({ to: '09123456789', body: 'test' })).rejects.toMatchObject({ code: 'SMS_DELIVERY_FAILED' });
});
