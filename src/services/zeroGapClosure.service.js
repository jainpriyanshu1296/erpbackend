const { v4: uuid } = require('uuid');
const { postReturnEffect } = require('./accounting.service');

const TABLES = {
  approval: 'approval_requests', rfqSupplier: 'rfq_suppliers', quotationLine: 'rfq_quotation_lines',
  purchaseReturn: 'purchase_returns', purchaseReturnLine: 'purchase_return_lines', batch: 'stock_batches',
  serial: 'stock_serials', count: 'physical_counts', countLine: 'physical_count_lines',
  location: 'warehouse_locations', importJob: 'import_jobs', exportJob: 'export_jobs',
  enquiry: 'sales_enquiries', allocation: 'payment_allocations', salesReturn: 'sales_returns',
  creditNote: 'credit_notes', output: 'production_outputs', downtime: 'production_downtime',
  scrap: 'production_scrap', related: 'related_documents'
};

function assert(condition, message) { if (!condition) { const e = new Error(message); e.status = 400; e.code = 'VALIDATION_ERROR'; throw e; } }
function conflict(message) { const e = new Error(message); e.status = 409; e.code = 'CONFLICT'; return e; }
async function audit(db, userId, action, entityType, entityId, data, transaction) {
  await db.query(
    'INSERT INTO audit_events(id,user_id,module,event_type,entity_type,entity_id,payload) VALUES(?,?,?,?,?,?,?)',
    { replacements: [uuid(), userId || null, 'zero_gap_closure', action, entityType, entityId, JSON.stringify(data || {})], transaction }
  );
}
async function write(db, table, data, userId, operationKey) {
  assert(TABLES[table], 'Unsupported resource');
  if (['batch','serial'].includes(table)) assert(data.item_id, 'item_id is required');
  if (['batch','serial','purchaseReturnLine','countLine','allocation','output','downtime','scrap'].includes(table)) {
    const quantity = data.quantity ?? data.allocated_amount ?? data.counted_qty ?? data.minutes;
    if (quantity !== undefined) assert(Number(quantity) > 0, 'quantity must be greater than zero');
  }
  const tx = await db.transaction();
  try {
    let result;
    if (operationKey) {
      const [existing] = await db.query('SELECT result_json FROM operation_keys WHERE operation_key=? FOR UPDATE', { replacements: [operationKey], transaction: tx });
      if (existing.length) { await tx.commit(); return JSON.parse(existing[0].result_json); }
    }
    const id = data.id || uuid();
    const columns = Object.keys(data).filter(k => k !== 'id');
    const values = columns.map(k => data[k] === undefined ? null : data[k]);
    await db.query(`INSERT INTO ${TABLES[table]} (id,${columns.join(',')}) VALUES (?,${columns.map(() => '?').join(',')})`, { replacements: [id, ...values], transaction: tx });
    result = { id, ...data };
    await audit(db, userId, 'created', table, id, result, tx);
    if (operationKey) await db.query('INSERT INTO operation_keys(id,operation_key,result_json) VALUES(?,?,?)', { replacements: [uuid(), operationKey, JSON.stringify(result)], transaction: tx });
    await tx.commit(); return result;
  } catch (e) { await tx.rollback(); throw e; }
}
async function transition(db, table, id, status, userId) {
  assert(['approval','count','purchaseReturn','salesReturn','creditNote'].includes(table), 'Transition is not supported');
  const statusMap = { approval: ['pending','approved','rejected','cancelled'], count: ['draft','open','submitted','approved','posted','cancelled'], purchaseReturn: ['draft','cancelled'], salesReturn: ['draft','cancelled'], creditNote: ['draft','issued','cancelled'] };
  assert(statusMap[table].includes(status), 'Invalid status');
  const tx = await db.transaction();
  try {
    const [rows] = await db.query(`SELECT status FROM ${TABLES[table]} WHERE id=? FOR UPDATE`, { replacements: [id], transaction: tx });
    assert(rows.length, 'Record not found');
    if (table === 'approval') {
      const [steps] = await db.query('SELECT * FROM approval_steps WHERE approval_id=? ORDER BY step_no FOR UPDATE', { replacements: [id], transaction: tx });
      if (status === 'approved') {
        assert(steps.length === 0 || steps.every(step => step.status === 'approved'), 'All approval steps must be approved first');
      }
      await db.query('UPDATE approval_requests SET decided_by=?,decided_at=NOW() WHERE id=?', { replacements: [userId || null, id], transaction: tx });
    }
    await db.query(`UPDATE ${TABLES[table]} SET status=? WHERE id=?`, { replacements: [status, id], transaction: tx });
    await audit(db, userId, `status.${status}`, table, id, { from: rows[0].status, to: status }, tx);
    await tx.commit(); return { id, status };
  } catch (e) { await tx.rollback(); throw e; }
}

async function actOnApproval(db, approvalId, action, userId, role, notes) {
  assert(['approved', 'rejected'].includes(action), 'Invalid approval action');
  const tx = await db.transaction();
  try {
    const [rows] = await db.query('SELECT * FROM approval_requests WHERE id=? FOR UPDATE', { replacements: [approvalId], transaction: tx });
    assert(rows.length, 'Approval request not found');
    assert(rows[0].status === 'pending', 'Approval request is already closed');
    const [steps] = await db.query('SELECT * FROM approval_steps WHERE approval_id=? ORDER BY step_no FOR UPDATE', { replacements: [approvalId], transaction: tx });
    const current = steps.find(step => step.status === 'pending');
    if (current) {
      assert(!current.approver_role || current.approver_role === role, 'User is not an approver for the current step');
      await db.query('UPDATE approval_steps SET status=?,acted_by=?,acted_at=NOW() WHERE id=? AND status=?', {
        replacements: [action, userId || null, current.id, 'pending'], transaction: tx
      });
      await db.query('INSERT INTO approval_step_events(id,approval_step_id,action,acted_by,notes) VALUES(?,?,?,?,?)', {
        replacements: [uuid(), current.id, action, userId || null, notes || null], transaction: tx
      });
    }
    const remainingPending = steps.filter(step => step.id !== current?.id && step.status === 'pending').length;
    const nextStatus = action === 'rejected' ? 'rejected' : (remainingPending ? 'pending' : 'approved');
    await db.query('UPDATE approval_requests SET status=?,decided_by=?,decided_at=IF(? IN ("approved","rejected"),NOW(),decided_at) WHERE id=?', {
      replacements: [nextStatus, userId || null, nextStatus, approvalId], transaction: tx
    });
    await audit(db, userId, `approval.${action}`, 'approval', approvalId, { role, step_id: current?.id || null }, tx);
    await tx.commit();
    return { id: approvalId, status: nextStatus, step_id: current?.id || null };
  } catch (error) { await tx.rollback(); throw error; }
}

async function applyStockEffect(db, { operationKey, referenceType, referenceId, itemId, warehouseId, quantity, rate = 0, direction, userId, batchId, serialId, transaction }) {
  assert(operationKey && referenceType && referenceId && itemId && warehouseId, 'Stock effect context is required');
  const qty = Number(quantity);
  assert(Number.isFinite(qty) && qty > 0, 'Stock quantity must be greater than zero');
  const tx = transaction || await db.transaction();
  const ownsTransaction = !transaction;
  try {
    const [existing] = await db.query('SELECT id FROM stock_effects WHERE operation_key=? FOR UPDATE', { replacements: [operationKey], transaction: tx });
    if (existing.length) { if (ownsTransaction) await tx.commit(); return { already_applied: true, operation_key: operationKey }; }
    const [stockRows] = await db.query('SELECT current_qty,avg_rate,total_value FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE', { replacements: [itemId, warehouseId], transaction: tx });
    const current = Number(stockRows[0]?.current_qty || 0);
    if (direction === 'out') assert(current >= qty, 'Insufficient stock');
    if (batchId) {
      const [batches] = await db.query('SELECT item_id,quantity FROM stock_batches WHERE id=? FOR UPDATE', { replacements: [batchId], transaction: tx });
      assert(batches.length && batches[0].item_id === itemId, 'Batch does not belong to item');
      if (direction === 'out') assert(Number(batches[0].quantity) >= qty, 'Insufficient batch stock');
      await db.query('UPDATE stock_batches SET quantity=quantity+? WHERE id=?', { replacements: [direction === 'in' ? qty : -qty, batchId], transaction: tx });
    }
    if (serialId) {
      assert(qty === 1, 'Serialised stock movements must have quantity one');
      const [serials] = await db.query('SELECT item_id,status FROM stock_serials WHERE id=? FOR UPDATE', { replacements: [serialId], transaction: tx });
      assert(serials.length && serials[0].item_id === itemId, 'Serial does not belong to item');
      if (direction === 'out') assert(serials[0].status === 'available', 'Serial is not available');
      await db.query('UPDATE stock_serials SET status=? WHERE id=?', { replacements: [direction === 'in' ? 'available' : 'issued', serialId], transaction: tx });
    }
    const next = direction === 'out' ? current - qty : current + qty;
    const oldValue = Number(stockRows[0]?.total_value || 0);
    const value = qty * Number(rate || stockRows[0]?.avg_rate || 0);
    const totalValue = direction === 'out' ? oldValue - value : oldValue + value;
    await db.query(
      `INSERT INTO stock_summary(item_id,warehouse_id,current_qty,avg_rate,total_value)
       VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE current_qty=?,avg_rate=IF(?=0,avg_rate,?/?),total_value=?`,
      { replacements: [itemId, warehouseId, next, rate || 0, totalValue, next, next, totalValue, next, totalValue], transaction: tx }
    );
    await db.query(
      'INSERT INTO stock_ledger(id,item_id,warehouse_id,transaction_type,reference_type,reference_id,qty_in,qty_out,balance_qty,rate,amount,created_by,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      { replacements: [uuid(), itemId, warehouseId, referenceType, referenceType, referenceId, direction === 'in' ? qty : 0, direction === 'out' ? qty : 0, next, rate || 0, value, userId || null, JSON.stringify({ batchId: batchId || null, serialId: serialId || null })], transaction: tx }
    );
    await db.query('INSERT INTO stock_effects(id,operation_key,reference_type,reference_id) VALUES(?,?,?,?)', { replacements: [uuid(), operationKey, referenceType, referenceId], transaction: tx });
    if (ownsTransaction) await tx.commit();
    return { operation_key: operationKey, quantity: qty, balance_qty: next, already_applied: false };
  } catch (error) { if (ownsTransaction) await tx.rollback(); throw error; }
}

async function postReturn(db, type, id, userId, warehouseId) {
  const table = type === 'purchase' ? 'purchase_returns' : 'sales_returns';
  const lineTable = type === 'purchase' ? 'purchase_return_lines' : 'sales_return_lines';
  const direction = type === 'purchase' ? 'out' : 'in';
  const tx = await db.transaction();
  try {
    const [returns] = await db.query(`SELECT * FROM ${table} WHERE id=? FOR UPDATE`, { replacements: [id], transaction: tx });
    assert(returns.length, 'Return not found');
    assert(returns[0].status === 'draft', 'Only draft returns can be posted');
    warehouseId = warehouseId || returns[0].warehouse_id;
    assert(warehouseId, 'warehouse_id is required');
    const [lines] = await db.query(`SELECT * FROM ${lineTable} WHERE ${type === 'purchase' ? 'return_id' : 'return_id'}=?`, { replacements: [id], transaction: tx });
    assert(lines.length, 'Return must contain at least one line');
    for (const line of lines) {
      await applyStockEffect(db, { operationKey: `${type}-return:${id}:${line.id}`, referenceType: `${type}_return`, referenceId: id, itemId: line.item_id, warehouseId, quantity: line.quantity, rate: line.unit_price, direction, userId, batchId: line.batch_id, serialId: line.serial_id, transaction: tx });
    }
    const total = Number(returns[0].total_amount || lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unit_price || 0), 0));
    await postReturnEffect(db, type, id, total, userId, tx, {
      taxable: returns[0].taxable_amount || total, cgst: returns[0].cgst || 0,
      sgst: returns[0].sgst || 0, igst: returns[0].igst || 0
    });
    await db.query(`UPDATE ${table} SET status='posted' WHERE id=? AND status='draft'`, { replacements: [id], transaction: tx });
    await audit(db, userId, type, 'return_posted', type === 'purchase' ? 'purchase_return' : 'sales_return', id, { line_count: lines.length }, tx);
    await tx.commit();
    return { id, status: 'posted', line_count: lines.length };
  } catch (error) { await tx.rollback(); throw error; }
}

async function allocatePayment(db, paymentId, invoiceId, amount, userId) {
  const value = Number(amount);
  assert(Number.isFinite(value) && value > 0, 'allocated_amount must be greater than zero');
  const tx = await db.transaction();
  try {
    const [invoices] = await db.query('SELECT total_amount,balance_amount,status FROM invoices WHERE id=? FOR UPDATE', { replacements: [invoiceId], transaction: tx });
    assert(invoices.length, 'Invoice not found');
    const [[allocated]] = await db.query('SELECT COALESCE(SUM(allocated_amount),0) total FROM payment_allocations WHERE invoice_id=? FOR UPDATE', { replacements: [invoiceId], transaction: tx });
    const [[paid]] = await db.query('SELECT COALESCE(SUM(amount),0) total FROM invoice_payments WHERE invoice_id=? FOR UPDATE', { replacements: [invoiceId], transaction: tx });
    const balance = Math.max(0, Number(invoices[0].total_amount || 0) - Number(paid.total || 0) - Number(allocated.total || 0));
    if (value > balance) throw conflict('Payment allocation exceeds invoice balance');
    await db.query('INSERT INTO payment_allocations(id,payment_id,invoice_id,allocated_amount) VALUES(?,?,?,?)', { replacements: [uuid(), paymentId, invoiceId, value], transaction: tx });
    const remaining = Math.max(0, balance - value);
    await db.query('UPDATE invoices SET balance_amount=?,status=CASE WHEN ?=0 THEN "paid" WHEN ?<total_amount THEN "part_paid" ELSE status END WHERE id=?', { replacements: [remaining, remaining, remaining, invoiceId], transaction: tx });
    await audit(db, userId, 'sales', 'payment_allocated', 'invoice', invoiceId, { payment_id: paymentId, amount: value }, tx);
    await tx.commit();
    return { payment_id: paymentId, invoice_id: invoiceId, allocated_amount: value, remaining_balance: remaining };
  } catch (error) { await tx.rollback(); throw error; }
}

async function postPhysicalCount(db, countId, userId) {
  const tx = await db.transaction();
  try {
    const [counts] = await db.query('SELECT * FROM physical_counts WHERE id=? FOR UPDATE', { replacements: [countId], transaction: tx });
    assert(counts.length, 'Physical count not found');
    assert(['approved', 'submitted'].includes(counts[0].status), 'Count must be submitted or approved before posting');
    const [lines] = await db.query('SELECT * FROM physical_count_lines WHERE count_id=? FOR UPDATE', { replacements: [countId], transaction: tx });
    assert(lines.length && lines.every(line => line.counted_qty !== null), 'All physical count lines must be counted');
    for (const line of lines) {
      const variance = Number(line.counted_qty) - Number(line.system_qty);
      if (!variance) continue;
      await applyStockEffect(db, { operationKey: `physical-count:${countId}:${line.id}`, referenceType: 'physical_count', referenceId: countId, itemId: line.item_id, warehouseId: counts[0].warehouse_id, quantity: Math.abs(variance), rate: 0, direction: variance > 0 ? 'in' : 'out', userId, transaction: tx });
    }

    await db.query("UPDATE physical_counts SET status='posted',posted_at=NOW(),approved_by=COALESCE(approved_by,?) WHERE id=?", { replacements: [userId || null, countId], transaction: tx });
    await audit(db, userId, 'inventory', 'physical_count_posted', 'physical_count', countId, { lines: lines.length }, tx);
    await tx.commit();
    return { id: countId, status: 'posted' };
  } catch (error) { await tx.rollback(); throw error; }
}

async function postProductionEffect(db, kind, id, userId, warehouseId) {
  const table = kind === 'output' ? 'production_outputs' : 'production_scrap';
  const direction = kind === 'output' ? 'in' : 'out';
  const tx = await db.transaction();
  try {
    const [rows] = await db.query(`SELECT * FROM ${table} WHERE id=? FOR UPDATE`, { replacements: [id], transaction: tx });
    assert(rows.length, 'Production record not found');
    const row = rows[0];
    warehouseId = warehouseId || row.warehouse_id;
    assert(warehouseId, 'warehouse_id is required');
    const result = await applyStockEffect(db, {
      operationKey: `production-${kind}:${id}`,
      referenceType: `production_${kind}`,
      referenceId: id,
      itemId: row.item_id,
      warehouseId,
      quantity: row.quantity,
      direction,
      userId,
      batchId: row.batch_id,
      transaction: tx
    });
    await db.query(`UPDATE ${table} SET status='posted' WHERE id=?`, { replacements: [id], transaction: tx }).catch(() => {});
    await audit(db, userId, 'production', `${kind}.posted`, table, id, { warehouse_id: warehouseId }, tx);
    await tx.commit();
    return { id, status: 'posted', ...result };
  } catch (error) { await tx.rollback(); throw error; }
}

async function issueCreditNote(db, id, userId) {
  const tx = await db.transaction();
  try {
    const [notes] = await db.query('SELECT * FROM credit_notes WHERE id=? FOR UPDATE', { replacements: [id], transaction: tx });
    assert(notes.length, 'Credit note not found');
    assert(notes[0].status === 'draft', 'Only draft credit notes can be issued');
    assert(notes[0].invoice_id, 'invoice_id is required before issuing a credit note');
    const [invoices] = await db.query('SELECT total_amount,balance_amount,status FROM invoices WHERE id=? FOR UPDATE', { replacements: [notes[0].invoice_id], transaction: tx });
    assert(invoices.length, 'Invoice not found');
    const amount = Number(notes[0].amount);
    const balance = Number(invoices[0].balance_amount ?? invoices[0].total_amount);
    assert(amount > 0 && amount <= Number(invoices[0].total_amount), 'Credit note amount is invalid');
    const nextBalance = Math.min(Number(invoices[0].total_amount), balance + amount);
    await db.query('UPDATE invoices SET balance_amount=?,status=CASE WHEN ?>=total_amount THEN "draft" ELSE "part_paid" END WHERE id=?', { replacements: [nextBalance, nextBalance, notes[0].invoice_id], transaction: tx });
    await db.query("UPDATE credit_notes SET status='issued' WHERE id=? AND status='draft'", { replacements: [id], transaction: tx });
    await postReturnEffect(db, 'sales', id, amount, userId, tx);
    await audit(db, userId, 'sales', 'credit_note.issued', 'credit_note', id, { invoice_id: notes[0].invoice_id, amount }, tx);
    await tx.commit();
    return { id, status: 'issued', invoice_id: notes[0].invoice_id, amount };
  } catch (error) { await tx.rollback(); throw error; }
}

async function processImport(db, id, userId) {
  const tx = await db.transaction();
  try {
    const [jobs] = await db.query('SELECT * FROM import_jobs WHERE id=? FOR UPDATE', { replacements: [id], transaction: tx });
    assert(jobs.length, 'Import job not found');
    const payload = jobs[0].payload_json ? (typeof jobs[0].payload_json === 'string' ? JSON.parse(jobs[0].payload_json) : jobs[0].payload_json) : [];
    assert(Array.isArray(payload), 'Import payload must be an array');
    const importTargets = { item_master: ['item_code', 'item_name', 'category', 'is_active'], vendors: ['vendor_code', 'company_name', 'email', 'phone', 'is_active'], customers: ['customer_code', 'company_name', 'email', 'phone', 'is_active'] };
    const targetColumns = importTargets[jobs[0].entity_type];
    assert(targetColumns, 'This entity is not supported by the import pipeline');
    await db.query('UPDATE import_jobs SET status="processing",total_rows=?,processed_rows=0,error_json=NULL WHERE id=?', { replacements: [payload.length, id], transaction: tx });
    for (let index = 0; index < payload.length; index += 1) {
      const row = payload[index];
      assert(row && typeof row === 'object' && !Array.isArray(row), `Row ${index + 1} must be an object`);
      const columns = targetColumns.filter(column => row[column] !== undefined);
      assert(columns.length > 0, `Row ${index + 1} has no supported fields`);
      const values = columns.map(column => row[column]);
      await db.query(`INSERT INTO ${jobs[0].entity_type} (id,${columns.join(',')}) VALUES (?,${columns.map(() => '?').join(',')})`, { replacements: [uuid(), ...values], transaction: tx });
      await db.query('INSERT INTO import_rows(id,import_job_id,row_number,payload,status) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload),status="processed",error_message=NULL', { replacements: [uuid(), id, index + 1, JSON.stringify(payload[index]), 'processed'], transaction: tx });
    }
    await db.query('UPDATE import_jobs SET status="completed",processed_rows=?,error_json=NULL WHERE id=?', { replacements: [payload.length, id], transaction: tx });
    await audit(db, userId, 'inventory', 'import.completed', 'import_job', id, { rows: payload.length }, tx);
    await tx.commit();
    return { id, status: 'completed', processed_rows: payload.length };
  } catch (error) { await tx.rollback(); throw error; }
}

async function processExport(db, id, userId) {
  const tx = await db.transaction();
  try {
    const [jobs] = await db.query('SELECT * FROM export_jobs WHERE id=? FOR UPDATE', { replacements: [id], transaction: tx });
    assert(jobs.length, 'Export job not found');
    const exportTargets = ['item_master', 'vendors', 'customers', 'stock_ledger', 'purchase_orders', 'sales_orders', 'invoices'];
    const entity = String(jobs[0].entity_type);
    assert(exportTargets.includes(entity), 'This entity is not supported by the export pipeline');
    const [rows] = await db.query(`SELECT * FROM ${entity} LIMIT 10000`, { transaction: tx });
    const content = JSON.stringify(rows);
    await db.query('UPDATE export_jobs SET status="completed",result_json=?,result_content=? WHERE id=?', { replacements: [JSON.stringify({ row_count: rows.length }), content, id], transaction: tx });
    await audit(db, userId, 'reports', 'export.completed', 'export_job', id, { rows: rows.length }, tx);
    await tx.commit();
    return { id, status: 'completed', row_count: rows.length, content };
  } catch (error) { await tx.rollback(); throw error; }
}
async function selectQuotation(db, lineId, userId) {
  const tx = await db.transaction();
  try {
    const [line] = await db.query('SELECT rfq_supplier_id,item_id FROM rfq_quotation_lines WHERE id=? FOR UPDATE', { replacements: [lineId], transaction: tx });
    assert(line.length, 'Quotation line not found');
    await db.query('UPDATE rfq_quotation_lines SET is_selected=0 WHERE rfq_supplier_id=? AND item_id=?', { replacements: [line[0].rfq_supplier_id, line[0].item_id], transaction: tx });
    await db.query('UPDATE rfq_quotation_lines SET is_selected=1 WHERE id=?', { replacements: [lineId], transaction: tx });
    await audit(db, userId, 'quotation.selected', 'rfq_quotation_line', lineId, line[0], tx);
    await tx.commit(); return { id: lineId, selected: true };
  } catch (e) { await tx.rollback(); throw e; }
}
async function compareQuotations(db, rfqId) {
  const [rows] = await db.query(
    `SELECT q.*,s.supplier_id FROM rfq_quotation_lines q
     INNER JOIN rfq_suppliers s ON s.id=q.rfq_supplier_id
     WHERE s.rfq_id=? ORDER BY q.item_id,q.unit_price,q.delivery_days`,
    { replacements: [rfqId] }
  );
  return rows;
}
async function matchPurchaseReturn(db, id, invoiceId, userId) {
  assert(invoiceId, 'purchase_invoice_id is required');
  const tx = await db.transaction();
  try {
    const [rows] = await db.query('SELECT id,status FROM purchase_returns WHERE id=? FOR UPDATE', { replacements: [id], transaction: tx });
    assert(rows.length, 'Purchase return not found');
    assert(rows[0].status === 'draft', 'Only draft returns can be matched');
    await db.query('UPDATE purchase_returns SET purchase_invoice_id=? WHERE id=?', { replacements: [invoiceId, id], transaction: tx });
    await audit(db, userId, 'matched', 'purchase_return', id, { purchase_invoice_id: invoiceId }, tx);
    await tx.commit(); return { id, purchase_invoice_id: invoiceId };
  } catch (e) { await tx.rollback(); throw e; }
}
module.exports = {
  TABLES, assert, audit, write, transition, actOnApproval, applyStockEffect, postReturn,
  allocatePayment, postPhysicalCount, postProductionEffect, issueCreditNote, processImport, processExport, selectQuotation,
  compareQuotations, matchPurchaseReturn
};
