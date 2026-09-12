const cron = require('node-cron');
const { v4: uuid } = require('uuid');
const masterDb = require('../config/db');
const { getOrgDb } = require('../config/orgDb');

async function runStockCheck() {
  try {
    const [orgs] = await masterDb.query('SELECT db_name, company_name FROM organizations WHERE is_active=1 AND is_suspended=0');
    for (const org of orgs) {
      try {
        const orgDb = getOrgDb(org.db_name);
        const [lowStockItems] = await orgDb.query(`
          SELECT im.id, im.item_code, im.item_name, im.reorder_level, ss.current_qty, ss.warehouse_id
          FROM item_master im
          JOIN stock_summary ss ON ss.item_id = im.id
          WHERE im.is_active = 1
            AND im.reorder_level > 0
            AND ss.current_qty <= im.reorder_level
        `);

        for (const item of lowStockItems) {
          // Check if notification already logged today
          const [exists] = await orgDb.query(`
            SELECT id FROM notifications 
            WHERE source = 'stock_alert' 
              AND title LIKE ? 
              AND DATE(created_at) = CURDATE()
            LIMIT 1
          `, { replacements: [`%${item.item_code}%`] });

          if (!exists.length) {
            await orgDb.query(`
              INSERT INTO notifications (id, severity, title, description, source, is_read)
              VALUES (?, 'warning', ?, ?, 'stock_alert', 0)
            `, {
              replacements: [
                uuid(),
                `Low Stock: ${item.item_name} (${item.item_code})`,
                `Current stock is ${item.current_qty} which is below reorder level ${item.reorder_level}.`
              ]
            });
          }
        }

        // Trigger Daily WhatsApp Low Stock Summary to Business Owner
        const { sendLowStockAlertToOwner } = require('../services/whatsapp.service');
        await sendLowStockAlertToOwner(orgDb).catch(err => console.warn(`[WHATSAPP LOW STOCK] ${org.db_name}:`, err.message));
      } catch (orgErr) {
        console.error(`[CRON STOCK ERROR] ${org.db_name}:`, orgErr.message);
      }
    }
  } catch (err) {
    console.error('[CRON STOCK MASTER ERROR]:', err.message);
  }
}

module.exports = () => {
  // Runs every 6 hours
  return cron.schedule('0 */6 * * *', () => {
    console.log('[CRON] Running automated stock level check...');
    runStockCheck();
  });
};
