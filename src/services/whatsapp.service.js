/**
 * WhatsApp Business Notification Service (WATI & Meta Cloud API)
 * Supports dynamic tenant credentials stored in company_settings
 */

async function getWhatsAppSettings(orgDb) {
  const [rows] = await orgDb.query(`
    SELECT setting_key, setting_value 
    FROM company_settings 
    WHERE setting_key IN (
      'wati_endpoint',
      'wati_token',
      'whatsapp_po_enabled',
      'whatsapp_invoice_enabled',
      'whatsapp_overdue_enabled',
      'whatsapp_low_stock_enabled',
      'whatsapp_admin_phone'
    )
  `);

  const map = Object.fromEntries(
    rows.map((r) => [r.setting_key, r.setting_value]),
  );

  return {
    wati_endpoint: map.wati_endpoint || process.env.WATI_API_URL || '',
    wati_token: map.wati_token || process.env.WATI_API_TOKEN || '',
    whatsapp_po_enabled: map.whatsapp_po_enabled !== '0',
    whatsapp_invoice_enabled: map.whatsapp_invoice_enabled !== '0',
    whatsapp_overdue_enabled: map.whatsapp_overdue_enabled !== '0',
    whatsapp_low_stock_enabled: map.whatsapp_low_stock_enabled !== '0',
    whatsapp_admin_phone:
      map.whatsapp_admin_phone || process.env.WHATSAPP_ADMIN_PHONE || '',
  };
}

async function saveWhatsAppSettings(orgDb, settings = {}) {
  for (const [key, value] of Object.entries(settings)) {
    const valStr =
      typeof value === 'boolean' ? (value ? '1' : '0') : String(value || '');
    await orgDb.query(
      `
      INSERT INTO company_settings (setting_key, setting_value)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE setting_value = ?
    `,
      { replacements: [key, valStr, valStr] },
    );
  }
  return getWhatsAppSettings(orgDb);
}

async function sendWhatsApp(
  orgDb,
  { to, templateName, parameters = [], mediaUrl = null },
) {
  if (!to) return { status: 'skipped', reason: 'NO_PHONE_NUMBER' };

  let token = process.env.WATI_API_TOKEN || process.env.WHATSAPP_TOKEN;
  let endpoint = process.env.WATI_API_URL || process.env.WHATSAPP_API_URL;

  if (orgDb) {
    const settings = await getWhatsAppSettings(orgDb);
    if (settings.wati_token) token = settings.wati_token;
    if (settings.wati_endpoint) endpoint = settings.wati_endpoint;
  }

  // Graceful fallback if no credentials are configured
  if (!token || !endpoint) {
    console.log(
      `[WHATSAPP MOCK/SIMULATION] Template: ${templateName} | Recipient: ${to} | Params:`,
      JSON.stringify(parameters),
    );
    return { status: 'simulated', reason: 'SANDBOX_MODE', to, templateName };
  }

  try {
    const cleanPhone = to.replace(/\D/g, '');
    const payload = {
      template_name: templateName,
      broadcast_name: `broadcast_${Date.now()}`,
      receivers: [
        {
          whatsappNumber: cleanPhone.startsWith('91')
            ? cleanPhone
            : `91${cleanPhone}`,
          customParams: parameters,
        },
      ],
    };

    if (mediaUrl) payload.media = { url: mediaUrl };

    const cleanEndpoint = endpoint.replace(/\/+$/, '');
    const response = await fetch(
      `${cleanEndpoint}/api/v1/sendTemplateMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      },
    );

    const data = await response.json();
    return { status: 'sent', data };
  } catch (err) {
    console.error(`[WHATSAPP ERROR] Failed to send to ${to}:`, err.message);
    return { status: 'error', error: err.message };
  }
}

/**
 * 4.1 PO to Vendor on PO Status = 'sent'
 */
async function sendPoToVendor(orgDb, poId) {
  const settings = await getWhatsAppSettings(orgDb);
  if (!settings.whatsapp_po_enabled) return { status: 'disabled' };

  const [pos] = await orgDb.query(
    `
    SELECT po.*, v.company_name as vendor_name, v.phone as vendor_phone
    FROM purchase_orders po
    JOIN vendors v ON v.id = po.vendor_id
    WHERE po.id = ?
  `,
    { replacements: [poId] },
  );

  if (!pos.length || !pos[0].vendor_phone) return { status: 'no_recipient' };
  const po = pos[0];

  return sendWhatsApp(orgDb, {
    to: po.vendor_phone,
    templateName: 'vendor_po_issued',
    parameters: [
      { name: 'vendor_name', value: po.vendor_name },
      { name: 'po_number', value: po.po_number },
      { name: 'amount', value: String(po.total_amount || 0) },
      {
        name: 'delivery_date',
        value: po.delivery_date
          ? String(po.delivery_date).substring(0, 10)
          : 'Immediate',
      },
    ],
  });
}

/**
 * 4.2 Tax Invoice to Customer on Invoice Status = 'sent'
 */
async function sendInvoiceToCustomer(orgDb, invoiceId) {
  const settings = await getWhatsAppSettings(orgDb);
  if (!settings.whatsapp_invoice_enabled) return { status: 'disabled' };

  const [invs] = await orgDb.query(
    `
    SELECT i.*, c.company_name as customer_name, c.phone as customer_phone
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.id = ?
  `,
    { replacements: [invoiceId] },
  );

  if (!invs.length || !invs[0].customer_phone)
    return { status: 'no_recipient' };
  const inv = invs[0];

  return sendWhatsApp(orgDb, {
    to: inv.customer_phone,
    templateName: 'customer_tax_invoice',
    parameters: [
      { name: 'customer_name', value: inv.customer_name },
      { name: 'invoice_number', value: inv.invoice_number },
      { name: 'total_amount', value: String(inv.total_amount || 0) },
      {
        name: 'invoice_date',
        value: String(inv.invoice_date || '').substring(0, 10),
      },
    ],
  });
}

/**
 * 4.3 Daily Payment Overdue Reminders (Triggered by Cron at 10 AM)
 * Reminds customers whose invoices are overdue by 3, 7, 15, 30 days
 */
async function sendOverdueRemindersBatch(orgDb) {
  const settings = await getWhatsAppSettings(orgDb);
  if (!settings.whatsapp_overdue_enabled) return { status: 'disabled' };

  const [overdueInvoices] = await orgDb.query(`
    SELECT 
      i.id, i.invoice_number, i.balance_amount, i.invoice_date,
      c.company_name as customer_name, c.phone as customer_phone,
      DATEDIFF(CURDATE(), i.invoice_date) as days_overdue
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status != 'paid' 
      AND i.balance_amount > 0 
      AND c.phone IS NOT NULL
      AND DATEDIFF(CURDATE(), i.invoice_date) IN (3, 7, 15, 30)
  `);

  const results = [];
  for (const inv of overdueInvoices) {
    const res = await sendWhatsApp(orgDb, {
      to: inv.customer_phone,
      templateName: 'invoice_payment_reminder',
      parameters: [
        { name: 'customer_name', value: inv.customer_name },
        { name: 'invoice_number', value: inv.invoice_number },
        { name: 'balance_amount', value: String(inv.balance_amount) },
        { name: 'days_overdue', value: String(inv.days_overdue) },
      ],
    });
    results.push({ invoice_id: inv.id, result: res });
  }

  return { dispatched_count: results.length, details: results };
}

/**
 * 4.4 Daily Low Stock Alert to Business Owner (Triggered by Cron at 8 AM)
 */
async function sendLowStockAlertToOwner(orgDb) {
  const settings = await getWhatsAppSettings(orgDb);
  if (!settings.whatsapp_low_stock_enabled || !settings.whatsapp_admin_phone) {
    return { status: 'skipped' };
  }

  const [shortItems] = await orgDb.query(`
    SELECT im.item_name, im.reorder_level, COALESCE(ss.current_stock, 0) as current_stock
    FROM item_master im
    LEFT JOIN (SELECT item_id, SUM(current_qty) as current_stock FROM stock_summary GROUP BY item_id) ss ON ss.item_id = im.id
    WHERE im.is_active = 1 AND im.reorder_level > 0 AND COALESCE(ss.current_stock, 0) < im.reorder_level
    LIMIT 10
  `);

  if (!shortItems.length) return { status: 'no_low_stock' };

  const itemListText = shortItems
    .map((i) => `${i.item_name}: ${i.current_stock}/${i.reorder_level}`)
    .join(', ');

  return sendWhatsApp(orgDb, {
    to: settings.whatsapp_admin_phone,
    templateName: 'daily_low_stock_summary',
    parameters: [
      { name: 'item_count', value: String(shortItems.length) },
      { name: 'items_summary', value: itemListText.substring(0, 200) },
    ],
  });
}

module.exports = {
  getWhatsAppSettings,
  saveWhatsAppSettings,
  sendWhatsApp,
  sendPoToVendor,
  sendInvoiceToCustomer,
  sendOverdueRemindersBatch,
  sendLowStockAlertToOwner,
};
