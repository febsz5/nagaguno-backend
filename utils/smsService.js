// SMS delivery for account recovery.
const twilio = require('twilio');
let twilioClient;

const sendSMS = async ({ to, body }) => {
  try {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
      throw new Error('SMS delivery is not configured.');
    }
    twilioClient ||= twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const recipient = /^09\d{9}$/.test(to) ? '+63' + to.slice(1) : to;
    return await twilioClient.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to: recipient });
  } catch (err) {
    console.error('SMS delivery failed:', { providerCode: err.code, status: err.status });
    const error = new Error('SMS delivery failed.');
    error.code = 'SMS_DELIVERY_FAILED';
    throw error;
  }
};
module.exports = { sendSMS };
