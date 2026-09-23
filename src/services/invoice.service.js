const { v4: uuid } = require('uuid');
const { createHash } = require('node:crypto');
const error = message => Object.assign(new Error(message), { status: 409, code: 'INVOICE_CONFLICT' });
function salesOrderId(body) {
  const ids = [body.so_id, body.sales_order_id, body.order_id].filter(Boolean);
  if (new Set(ids).size > 1) throw error('Conflicting sales order identifiers');
  return ids[0] || null;
}
function priceLines(items, interstate) {
  if (!Array.isArray(items) || !items.length) throw error('Invoice items are required');
  return items.map(item => {
    const quantity = Number(item.quantity), rate = Number(item.rate);
    const discount = Number(item.discount_percent || 0), gst = Number(item.gst_rate || 0);
    if (!item.item_id || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(rate) || rate < 0 || !Number.isFinite(discount) || discount < 0 || discount > 100 || !Number.isFinite(gst) || gst < 0 || gst > 100) throw error('Invalid invoice item quantity, rate, discount or tax');
    const round = value => Math.round(value * 100) / 100;
    const taxable = round(quantity * rate * (1 - discount / 100));
    const cgst = interstate ? 0 : round(taxable * gst / 200), sgst = cgst;
    const igst = interstate ? round(taxable * gst / 100) : 0;
    return { ...item, quantity, rate, discount_percent: discount, gst_rate: gst, taxable, cgst, sgst, igst, total: round(taxable + cgst + sgst + igst) };
  });
}
function assertFullyDispatched(ordered, sent) {
  if (!ordered.length) throw error('Sales order has no items');
  const required = new Map(), delivered = new Map();
  for (const line of ordered) required.set(line.item_id, (required.get(line.item_id) || 0) + Number(line.quantity));
  for (const line of sent) {
    if(!Number.isFinite(Number(line.quantity)) || Number(line.quantity)<0) throw error('Invalid dispatched quantity');
    delivered.set(line.item_id, (delivered.get(line.item_id) || 0) + Number(line.quantity));
  }
  for (const [item, quantity] of required) if (!Number.isFinite(quantity) || quantity <= 0 || (delivered.get(item) || 0) + 0.000001 < quantity) throw error('All order quantities must be dispatched before creating a full-order invoice');
}
async function createInvoice(db, body, userId) {
  const tx = await db.transaction();
  try {
    const query = (sql, replacements = []) => db.query(sql, { replacements, transaction: tx });
    let soId = salesOrderId(body), customerId = body.customer_id;
    if (body.challan_id) {
      const [[challan]] = await query('SELECT * FROM delivery_challans WHERE id=?', [body.challan_id]);
      if (!challan || !['dispatched', 'delivered'].includes(challan.status) || !challan.so_id) throw error('A dispatched order-linked challan is required');
      if (soId && soId !== challan.so_id) throw error('Challan belongs to another order');
      soId = challan.so_id;
    }
    let items = body.items;
    if (soId) {
      const [[order]] = await query('SELECT * FROM sales_orders WHERE id=? FOR UPDATE', [soId]);
      if (!order || ['draft', 'cancelled'].includes(order.status)) throw error('An active confirmed sales order is required');
      if (customerId && customerId !== order.customer_id) throw error('Customer does not own this order');
      customerId = order.customer_id;
      const [[existing]] = await query('SELECT * FROM invoices WHERE so_id=? LIMIT 1', [soId]);
      if (existing) { await tx.commit(); return { ...existing, already_created: true }; }
      [items] = await query('SELECT * FROM sales_order_items WHERE so_id=? ORDER BY id', [soId]);
      const [sent] = await query("SELECT dci.item_id,SUM(dci.quantity) quantity FROM delivery_challan_items dci JOIN delivery_challans dc ON dc.id=dci.challan_id WHERE dc.so_id=? AND dc.status IN ('dispatched','delivered') GROUP BY dci.item_id", [soId]);
      assertFullyDispatched(items, sent);
    }
    if (!customerId) throw error('Customer is required');
    const [[customer]] = await query('SELECT id,state FROM customers WHERE id=? FOR UPDATE', [customerId]);
    if (!customer) throw error('Customer not found');
    const key = soId ? `order:${soId}` : body.idempotency_key;
    if (!key || key.length > 150) throw error('A stable Idempotency-Key is required for manual invoices');
    const fingerprint = createHash('sha256').update(JSON.stringify({ customerId, soId, invoice_number: body.invoice_number || null, invoice_date: body.invoice_date || null, due_date: body.due_date || null, items })).digest('hex');
    const [[existing]] = await query('SELECT * FROM invoices WHERE creation_key=? LIMIT 1', [key]);
    if (existing) {
      if (existing.customer_id !== customerId) throw error('Idempotency key belongs to another customer');
      if (!soId && existing.creation_hash !== fingerprint) throw error('Idempotency key was already used for a different invoice payload');
      await tx.commit(); return { ...existing, already_created: true };
    }
    const [[company]] = await query("SELECT setting_value FROM company_settings WHERE setting_key='state' LIMIT 1");
    if (!company?.setting_value || !customer.state) throw error('Company and customer states are required for tax calculation');
    const priced = priceLines(items, String(company.setting_value).trim().toLowerCase() !== String(customer.state).trim().toLowerCase());
    for (const item of priced) {
      const [[master]] = await query('SELECT id FROM item_master WHERE id=?', [item.item_id]);
      if (!master) throw error('Invoice item does not exist');
    }
    const id = uuid(), number = body.invoice_number || `INV-${id}`;
    const total = Math.round(priced.reduce((sum, line) => sum + line.total, 0) * 100) / 100;
    await query("INSERT INTO invoices(id,invoice_number,so_id,customer_id,invoice_date,due_date,status,total_amount,balance_amount,creation_key,creation_hash) VALUES(?,?,?,?,COALESCE(?,CURDATE()),?,'draft',?,?,?,?)", [id, number, soId, customerId, body.invoice_date || null, body.due_date || null, total, total, key, fingerprint]);
    for (const line of priced) await query('INSERT INTO invoice_item_lines(id,invoice_id,item_id,description,quantity,rate,discount_percent,gst_rate,taxable,cgst,sgst,igst,total) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [uuid(), id, line.item_id, line.description || null, line.quantity, line.rate, line.discount_percent, line.gst_rate, line.taxable, line.cgst, line.sgst, line.igst, line.total]);
    await tx.commit();
    return { id, invoice_number: number, so_id: soId, total_amount: total, balance_amount: total, status: 'draft' };
  } catch (cause) { await tx.rollback(); throw cause; }
}
module.exports = { createInvoice, salesOrderId, priceLines, assertFullyDispatched };
