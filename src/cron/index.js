const stockAlerts = require('./stock-alerts.cron');
const paymentReminders = require('./payment-reminders.cron');
const subscriptionExpiry = require('./subscription-expiry.cron');
const jobworkCompliance = require('./jobwork-compliance.cron');

function start() {
  console.log('[CRON] Initializing automated background jobs...');
  stockAlerts();
  paymentReminders();
  subscriptionExpiry();
  jobworkCompliance();
  console.log('[CRON] All background jobs scheduled successfully.');
}

module.exports = { start };
