const cron = require('node-cron');
const masterDb = require('../config/db');

async function checkExpiries() {
  try {
    // Flag orgs expiring in 7 days or less
    const [expiring] = await masterDb.query(`
      SELECT id, slug, company_name, owner_email, plan, plan_expires_at, trial_ends_at, is_trial
      FROM organizations
      WHERE is_active = 1
        AND is_suspended = 0
        AND (
          (is_trial = 1 AND trial_ends_at <= DATE_ADD(NOW(), INTERVAL 3 DAY))
          OR (is_trial = 0 AND plan_expires_at <= DATE_ADD(NOW(), INTERVAL 7 DAY))
        )
    `);

    for (const org of expiring) {
      console.log(
        `[SUBSCRIPTION ALERT] Org ${org.company_name} (${org.slug}) plan ${org.plan} expiring soon.`,
      );
    }
  } catch (err) {
    console.error('[CRON SUBSCRIPTION ERROR]:', err.message);
  }
}

module.exports = () => {
  // Runs daily at 7:00 AM
  return cron.schedule('0 7 * * *', () => {
    console.log('[CRON] Running subscription & trial expiry check...');
    checkExpiries();
  });
};
