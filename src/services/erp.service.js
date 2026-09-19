const { v4: uuid } = require('uuid');
const { calculateGST } = require('../utils/gst-calculator');
const { postPaymentEffect } = require('./accounting.service');

async function nextNumber(db, key, prefix = key.toUpperCase(), padding = 5, transaction) {
  const [rows] = await db.query('SELECT * FROM number_series WHERE series_key=? FOR UPDATE', { replacements: [key], transaction });
  let n = rows[0] && Number(rows[0].next_number);
  if (!n) {
    n = 1;
    await db.query('INSERT INTO number_series(series_key,prefix,next_number,padding) VALUES(?,?,2,?)', { replacements: [key, prefix, padding], transaction });
  } else await db.query('UPDATE number_series SET next_number=next_number+1 WHERE series_key=?', { replacements: [key], transaction });
  return `${rows[0]?.prefix || prefix}${new Date().getFullYear()}-${String(n).padStart(Number(rows[0]?.padding || padding), '0')}`;
}

async function postStockAdjustment(db, input, userId) {
  const tx = await db.transaction();
  try {
    const id = input.id || uuid();
    const number = input.adjustment_number || await nextNumber(db, 'stock_adjustment', 'ADJ-', 5, tx);
    await db.query('INSERT INTO stock_adjustments(id,adjustment_number,warehouse_id,reason,created_by,status) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE status=?', {
      replacements: [id, number, input.warehouse_id, input.reason || null, userId, 'posted', 'posted'], transaction: tx
    });
    for (const item of input.items || []) {
      const qty = Number(item.quantity); if (!item.item_id || !Number.isFinite(qty) || qty <= 0) throw Object.assign(new Error('Invalid stock adjustment item'), { status: 400, code: 'VALIDATION_ERROR' });
      const inQty = item.direction === 'out' ? 0 : qty, outQty = item.direction === 'out' ? qty : 0;
      const [summary] = await db.query('SELECT current_qty,avg_rate FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE', { replacements: [item.item_id, input.warehouse_id], transaction: tx });
      const current = Number(summary[0]?.current_qty || 0); if (current - outQty < 0) throw Object.assign(new Error('Insufficient stock'), { status: 409, code: 'INSUFFICIENT_STOCK' });
      const next = current + inQty - outQty;
      await db.query('INSERT INTO stock_summary(item_id,warehouse_id,current_qty,avg_rate,total_value) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE current_qty=?, total_value=?', { replacements: [item.item_id, input.warehouse_id, next, item.rate || summary[0]?.avg_rate || 0, next * Number(item.rate || summary[0]?.avg_rate || 0), next, next * Number(item.rate || summary[0]?.avg_rate || 0)], transaction: tx });
      await db.query('INSERT INTO stock_ledger(id,item_id,warehouse_id,transaction_type,reference_type,reference_id,qty_in,qty_out,balance_qty,rate,amount,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', { replacements: [uuid(), item.item_id, input.warehouse_id, 'adjustment', 'stock_adjustment', id, inQty, outQty, next, item.rate || 0, qty * Number(item.rate || 0), userId], transaction: tx });
    }
    await db.query('UPDATE stock_adjustments SET status="posted",posted_at=NOW() WHERE id=?', { replacements: [id], transaction: tx });
    await tx.commit(); return { id, adjustment_number: number, status: 'posted' };
  } catch (e) { await tx.rollback(); throw e; }
}

async function recordInvoicePayment(db, invoiceId, amount, details, userId) {
  const tx = await db.transaction();
  try {
    const operationKey = details?.idempotency_key;
    if (operationKey) {
      const [existing] = await db.query('SELECT result_json FROM operation_keys WHERE operation_key=? FOR UPDATE', { replacements: [operationKey], transaction: tx });
      if (existing.length) { await tx.commit(); return JSON.parse(existing[0].result_json); }
    }
    const [rows] = await db.query('SELECT total_amount,balance_amount FROM invoices WHERE id=? FOR UPDATE', { replacements: [invoiceId], transaction: tx });
    if (!rows.length || !Number.isFinite(Number(amount)) || Number(amount) <= 0) throw Object.assign(new Error('Invoice or amount is invalid'), { status: 400, code: 'VALIDATION_ERROR' });
    const balance = Number(rows[0].balance_amount ?? rows[0].total_amount); if (Number(amount) > balance) throw Object.assign(new Error('Payment exceeds invoice balance'), { status: 409, code: 'OVERPAYMENT' });
    const paymentId = uuid();
    await db.query('INSERT INTO invoice_payments(id,invoice_id,amount,method,reference,created_by) VALUES(?,?,?,?,?,?)', { replacements: [paymentId, invoiceId, amount, details?.method || 'bank', details?.reference || null, userId], transaction: tx });
    await postPaymentEffect(db, paymentId, invoiceId, amount, details?.method || 'bank', userId, tx);
    const next = balance - Number(amount); await db.query('UPDATE invoices SET balance_amount=?,status=? WHERE id=?', { replacements: [next, next === 0 ? 'paid' : 'part_paid', invoiceId], transaction: tx });
    const result = { invoice_id: invoiceId, payment_id: paymentId, paid: Number(amount), balance_amount: next };
    if (operationKey) await db.query('INSERT INTO operation_keys(id,operation_key,result_json) VALUES(?,?,?)', { replacements: [uuid(), operationKey, JSON.stringify(result)], transaction: tx });
    await tx.commit(); return result;
  } catch (e) { await tx.rollback(); throw e; }
}

function calculatePayroll(employee, attendance = {}, deductions = {}) {
  const monthly = Number(employee.basic_salary || 0) + Number(employee.allowances || 0);
  const days = Math.max(1, Number(attendance.working_days || 26));
  const payable = Math.min(days, Math.max(0, Number(attendance.present_days ?? days) + Number(attendance.paid_leave || 0)));
  const gross = monthly * payable / days;
  const totalDeductions = Number(deductions.pf || 0) + Number(deductions.esi || 0) + Number(deductions.tax || 0) + Number(deductions.other || 0);
  return { gross: Math.round(gross * 100) / 100, deductions: Math.round(totalDeductions * 100) / 100, net: Math.round((gross - totalDeductions) * 100) / 100 };
}
function calculateMRP(demand, onHand, scheduled = 0, safetyStock = 0) {
  return Math.max(0, Number(demand || 0) + Number(safetyStock || 0) - Number(onHand || 0) - Number(scheduled || 0));
}
module.exports = { nextNumber, postStockAdjustment, recordInvoicePayment, calculateGST, calculatePayroll, calculateMRP };
