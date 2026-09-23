const cron = require('node-cron');
const { v4: uuid } = require('uuid');
const masterDb = require('../config/db');
const { getOrgDb } = require('../config/orgDb');

async function runJobWorkComplianceCheck() {
  try {
    const [orgs] = await masterDb.query(
      'SELECT db_name FROM organizations WHERE is_active=1 AND is_suspended=0',
    );
    for (const org of orgs) {
      try {
        const orgDb = getOrgDb(org.db_name);
        // Find outward job work challans approaching 300+ days (1 year = 365 days)
        const [agingChallans] = await orgDb.query(`
          SELECT j.id, j.jw_number, j.process_name, j.dispatch_date, j.expected_return_date,
                 DATEDIFF(CURDATE(), COALESCE(j.dispatch_date, j.created_at)) AS days_elapsed,
                 v.company_name vendor_name
          FROM job_work_orders j
          LEFT JOIN vendors v ON v.id = j.vendor_id
          WHERE j.status NOT IN ('completed', 'cancelled')
            AND DATEDIFF(CURDATE(), COALESCE(j.dispatch_date, j.created_at)) >= 300
        `);

        for (const jw of agingChallans) {
          const days = Number(jw.days_elapsed);
          const severity = days >= 365 ? 'critical' : 'warning';
          const title =
            days >= 365
              ? `GST Sec 143 Violation: JW Challan ${jw.jw_number}`
              : `GST Alert: 57F4 Challan ${jw.jw_number} at ${days} days`;

          const description =
            days >= 365
              ? `Challan sent to ${jw.vendor_name || 'Vendor'} exceeded 365 days. Under Sec 143, this is deemed as supply with tax & interest payable.`
              : `Challan sent to ${jw.vendor_name || 'Vendor'} has elapsed ${days} days. Only ${365 - days} days left to return materials under Section 143!`;

          const [exists] = await orgDb.query(
            `
            SELECT id FROM notifications
            WHERE source = 'jobwork_compliance'
              AND title LIKE ?
              AND DATE(created_at) = CURDATE()
            LIMIT 1
          `,
            { replacements: [`%${jw.jw_number}%`] },
          );

          if (!exists.length) {
            await orgDb.query(
              `
              INSERT INTO notifications (id, severity, title, description, source, is_read)
              VALUES (?, ?, ?, ?, 'jobwork_compliance', 0)
            `,
              { replacements: [uuid(), severity, title, description] },
            );
          }
        }
      } catch (orgErr) {
        // Table or columns may be in older migration state
      }
    }
  } catch (err) {
    console.error('[CRON JOBWORK ERROR]:', err.message);
  }
}

module.exports = () => {
  // Runs daily at 8:00 AM
  return cron.schedule('0 8 * * *', () => {
    console.log('[CRON] Running Job Work Section 143 compliance scan...');
    runJobWorkComplianceCheck();
  });
};
