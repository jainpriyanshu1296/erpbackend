const Razorpay = require('razorpay');
const crypto = require('crypto');
function client() { if (!process.env.RAZORPAY_KEY_ID) return null; return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET }); }
async function createOrder(options) { const r = client(); return r ? r.orders.create(options) : { id: `dev_order_${Date.now()}`, ...options }; }
async function fetchPayment(paymentId) { const r = client(); return r ? r.payments.fetch(paymentId) : null; }
function verifyPayment({ razorpay_order_id, razorpay_payment_id, razorpay_signature } = {}) {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !process.env.RAZORPAY_KEY_SECRET) return false;
  const payload = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(payload).digest('hex');
  const actual = Buffer.from(String(razorpay_signature));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && crypto.timingSafeEqual(wanted, actual);
}
function verifyWebhook(rawBody, signature) {
  if (!rawBody || !signature || !process.env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  const actual = Buffer.from(String(signature));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && crypto.timingSafeEqual(wanted, actual);
}
module.exports = { createOrder, fetchPayment, verifyPayment, verifyWebhook };
