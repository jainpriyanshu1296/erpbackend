const nodemailer = require('nodemailer');
function transporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}
async function sendEmail(options) {
  if (!process.env.SMTP_HOST) return { skipped: true };
  return transporter().sendMail({ from: process.env.FROM_EMAIL, ...options });
}
module.exports = { sendEmail };
