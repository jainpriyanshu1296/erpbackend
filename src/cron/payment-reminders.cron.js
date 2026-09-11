const cron = require('node-cron');
const { v4: uuid } = require('uuid');
const masterDb = require('../config/db');
const { getOrgDb } = require('../config/orgDb');

async function runPaymentCheck() {
  try {
    const [orgs] = await masterDb.query('SELECT db_name FROM organizations WHERE is_active=1 AND is_suspended=0');
    for (const org of orgs) {
      try {
        const orgDb = getOrgDb(org.db_name);
        const [overdueInvoices] = await orgDb.query(`
          SELECT i.id, i.invoice_number, i.total_amount, i.balance_amount, i.due_date, c.company_name customer_name
          FROM invoices i
          LEFT JOIN customers c ON c.id = i.customer_id
          WHERE i.status NOT IN ('paid', 'cancelled')
            AND i.due_date IS NOT NULL
            AND i.due_date < CURDATE()
            AND i.balance_amount > 0
        `);

        for (const inv of overdueInvoices) {
          const [exists] = await orgDb.query(`
            SELECT id FROM notifications
            WHERE source = 'payment_reminder'
              AND title LIKE ?
              AND DATE(created_at) = CURDATE()
            LIMIT 1
          `, { replacements: [`%${inv.invoice_number}%`] });

          if (!exists.length) {
            await orgDb.query(`
              INSERT INTO notifications (id, severity, title, description, source, is_read)
              VALUES (?, 'warning', ?, ?, 'payment_reminder', 0)
            `, {
              replacements: [
                uuid(),
                `Payment Overdue: Invoice ${inv.invoice_number}`,
                `Customer ${inv.customer_name || 'N/A'} has pending balance ₹${inv.balance_amount} overdue since ${inv.due_date}.`
              ]
            });
          }
        }
      } catch (orgErr) {
        console.error(`[CRON PAYMENT ERROR] ${org.db_name}:`, orgErr.message);
      }
    }
  } catch (err) {
    console.error('[CRON PAYMENT MASTER ERROR]:', err.message);
  }
}

module.exports = () => {
  // Runs daily at 9:00 AM
  return cron.schedule('0 9 * * *', () => {
    console.log('[CRON] Running payment overdue reminder scan...');
    runPaymentCheck();
  });
};
