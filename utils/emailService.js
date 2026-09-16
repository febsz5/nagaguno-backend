// utils/emailService.js
const nodemailer = require('nodemailer');

let transporter;

const getTransporter = () => {
  if (transporter) return transporter;

  if (!process.env.RESEND_API_KEY && process.env.DEV_EMAIL_USER && process.env.DEV_EMAIL_PASS && process.env.NODE_ENV !== 'production') {
    // Use Ethereal for development (fake SMTP)
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      auth: {
        user: process.env.DEV_EMAIL_USER,
        pass: process.env.DEV_EMAIL_PASS,
      },
    });
  } else {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('Email delivery is not configured.');
    }
    // Production: Resend SMTP
    transporter = nodemailer.createTransport({
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
      auth: {
        user: 'resend',
        pass: process.env.RESEND_API_KEY,
      },
    });
  }

  return transporter;
};

const sendEmail = async ({ to, subject, html, text }) => {
  try {
    const info = await getTransporter().sendMail({
      from: `"${process.env.EMAIL_FROM_NAME || 'NagaGuno'}" <${process.env.EMAIL_FROM || 'noreply@nagaguno.com'}>`,
      to,
      subject,
      html,
      text,
    });
    console.log(`✉️ Email sent to ${to}: ${info.messageId}`);
    return info;
  } catch (err) {
    console.error('Email send failed:', err.code || 'EMAIL_DELIVERY_FAILED');
    err.code = 'EMAIL_DELIVERY_FAILED';
    throw err;
  }
};

module.exports = { sendEmail };

// ─────────────────────────────────────────────
// utils/smsService.js (in same file for brevity)
// ─────────────────────────────────────────────
