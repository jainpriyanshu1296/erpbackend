/**
 * WhatsApp Notification Service
 * Dispatches automated WhatsApp messages using WhatsApp Cloud API or WATI
 */

async function sendWhatsApp({ to, templateName, parameters = [], mediaUrl = null }) {
  const token = process.env.WATI_API_TOKEN || process.env.WHATSAPP_TOKEN;
  const endpoint = process.env.WATI_API_URL || process.env.WHATSAPP_API_URL;

  // If no WhatsApp token configured in .env, gracefully skip and log
  if (!token || !endpoint) {
    console.log(`[WHATSAPP SKIPPED] No credentials. Would send template ${templateName} to ${to}`);
    return { status: 'skipped', reason: 'NO_CREDENTIALS', to, templateName };
  }

  try {
    const payload = {
      template_name: templateName,
      broadcast_name: `broadcast_${Date.now()}`,
      receivers: [
        {
          whatsappNumber: to.replace(/\D/g, ''),
          customParams: parameters
        }
      ]
    };

    if (mediaUrl) payload.media = { url: mediaUrl };

    const response = await fetch(`${endpoint}/api/v1/sendTemplateMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    return { status: 'sent', data };
  } catch (err) {
    console.error(`[WHATSAPP ERROR] Failed to send to ${to}:`, err.message);
    return { status: 'error', error: err.message };
  }
}

async function sendPoWhatsApp(phone, poNumber, companyName) {
  return sendWhatsApp({
    to: phone,
    templateName: 'po_dispatch_notification',
    parameters: [
      { name: 'po_number', value: poNumber },
      { name: 'company_name', value: companyName }
    ]
  });
}

async function sendInvoiceReminderWhatsApp(phone, invoiceNumber, amount, dueDate) {
  return sendWhatsApp({
    to: phone,
    templateName: 'invoice_payment_reminder',
    parameters: [
      { name: 'invoice_number', value: invoiceNumber },
      { name: 'amount', value: String(amount) },
      { name: 'due_date', value: dueDate || 'Immediate' }
    ]
  });
}

async function sendJobWorkAlertWhatsApp(phone, challanNumber, daysElapsed) {
  return sendWhatsApp({
    to: phone,
    templateName: 'jobwork_statutory_alert',
    parameters: [
      { name: 'challan_number', value: challanNumber },
      { name: 'days_elapsed', value: String(daysElapsed) }
    ]
  });
}

module.exports = {
  sendWhatsApp,
  sendPoWhatsApp,
  sendInvoiceReminderWhatsApp,
  sendJobWorkAlertWhatsApp
};
