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
  data={...data};
  const initial={count:'draft',purchaseReturn:'draft',salesReturn:'draft',creditNote:'draft',approval:'pending',serial:'available'};
  if(initial[table]) {assert(!data.status || data.status===initial[table],'Records must be created in their initial state');data.status=initial[table];}
  if(table==='batch') {assert(data.quantity===undefined || Number(data.quantity)===0,'Batch quantities are maintained only by stock movements');data.quantity=0;assert(data.batch_no,'Batch number is required');}
  if(table==='serial') assert(data.serial_no,'Serial number is required');
  if(table==='count') assert(data.count_number && data.warehouse_id,'Count number and warehouse are required');
  if (['batch','serial'].includes(table)) assert(data.item_id, 'item_id is required');
  if (['batch','serial','purchaseReturnLine','countLine','allocation','output','downtime','scrap'].includes(table)) {
    const quantity = data.quantity ?? data.allocated_amount ?? data.counted_qty ?? data.minutes;
    if (quantity !== undefined) assert(Number.isFinite(Number(quantity)) && (['countLine','batch'].includes(table)?Number(quantity)>=0:Number(quantity)>0), 'quantity must be a finite valid number');
  }
  const tx = await db.transaction();
  try {
    let result;
    if(table==='rfqSupplier') {
      const [[rfq]]=await db.query('SELECT id,status FROM rfqs WHERE id=? FOR UPDATE',{replacements:[data.rfq_id || null],transaction:tx});
      const [[vendor]]=await db.query('SELECT id FROM vendors WHERE id=? AND is_active=1',{replacements:[data.supplier_id || null],transaction:tx});
      assert(rfq && ['draft','requested'].includes(rfq.status) && vendor,'Choose an active vendor and open RFQ');
      data.status='invited';
    }
    if(table==='quotationLine') {
      const [[source]]=await db.query('SELECT s.rfq_id,r.status FROM rfq_suppliers s JOIN rfqs r ON r.id=s.rfq_id WHERE s.id=? FOR UPDATE',{replacements:[data.rfq_supplier_id || null],transaction:tx});
      assert(source && ['requested','quoted'].includes(source.status),'RFQ must be requested or quoted');
      const [[item]]=await db.query('SELECT quantity FROM rfq_items WHERE rfq_id=? AND item_id=?',{replacements:[source.rfq_id,data.item_id || null],transaction:tx});
      assert(item && Number(data.quantity)===Number(item.quantity),'Quote the requested item and quantity');
      assert(Number.isFinite(Number(data.unit_price)) && Number(data.unit_price)>=0 && Number.isFinite(Number(data.tax_rate || 0)) && Number(data.tax_rate || 0)>=0 && Number(data.tax_rate || 0)<=100,'Invalid price or tax rate');
      data.is_selected=0;
    }
    if (['batch','serial','countLine','output','scrap'].includes(table)) {
      const [[item]]=await db.query('SELECT id FROM item_master WHERE id=? AND is_active=1',{replacements:[data.item_id || null],transaction:tx});
      assert(item,'An active Item Master record is required');
    }
    if (data.warehouse_id) {
      const [[warehouse]]=await db.query('SELECT id FROM warehouses WHERE id=? AND is_active=1',{replacements:[data.warehouse_id],transaction:tx});
      assert(warehouse,'An active warehouse is required');
    }
    if (['output','scrap','downtime'].includes(table)) {
      const [[order]]=await db.query('SELECT * FROM production_orders WHERE id=? FOR UPDATE',{replacements:[data.production_order_id || null],transaction:tx});
      assert(order && ['released','in_progress'].includes(order.status),'A released production order is required');
      if(table==='output') assert(order.item_id===data.item_id && Number(data.quantity)<=Number(order.planned_qty),'Output must match the production item and planned quantity');
    }
    if(table==='countLine') {
      const [[count]]=await db.query('SELECT * FROM physical_counts WHERE id=? FOR UPDATE',{replacements:[data.count_id || null],transaction:tx});
      assert(count && ['draft','open'].includes(count.status),'Lines can only be recorded on a draft or open count');
      assert(data.counted_qty!==undefined && Number.isFinite(Number(data.counted_qty)) && Number(data.counted_qty)>=0,'Counted quantity must be non-negative');
      const [[existing]]=await db.query('SELECT id FROM physical_count_lines WHERE count_id=? AND item_id=?',{replacements:[data.count_id,data.item_id],transaction:tx});
      assert(!existing,'Item is already recorded in this count');
      const [[stock]]=await db.query('SELECT current_qty FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE',{replacements:[data.item_id,count.warehouse_id],transaction:tx});
      data.system_qty=Number(stock?.current_qty || 0);
    }
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
  const statusMap = { approval: ['pending','approved','rejected','cancelled'], count: ['draft','open','submitted','approved','cancelled'], purchaseReturn: ['draft','cancelled'], salesReturn: ['draft','cancelled'], creditNote: ['draft','cancelled'] };
  assert(statusMap[table].includes(status), 'Invalid status');
  const tx = await db.transaction();
  try {
    const [rows] = await db.query(`SELECT status FROM ${TABLES[table]} WHERE id=? FOR UPDATE`, { replacements: [id], transaction: tx });
    assert(rows.length, 'Record not found');
    if (table==='count') {
      const allowed={draft:['open','cancelled'],open:['submitted','cancelled'],submitted:['approved','cancelled'],approved:[],posted:[],cancelled:[]};
      assert((allowed[rows[0].status] || []).includes(status),'Invalid physical count transition');
    } else assert(!['posted','issued','cancelled','rejected','approved'].includes(rows[0].status),'Terminal records cannot be changed');
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
    const averageRate = direction === 'in' && next > 0 ? totalValue / next : Number(stockRows[0]?.avg_rate || rate || 0);
    await db.query(
      `INSERT INTO stock_summary(item_id,warehouse_id,current_qty,avg_rate,total_value)
       VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE current_qty=?,avg_rate=?,total_value=?`,
      { replacements: [itemId, warehouseId, next, averageRate, totalValue, next, averageRate, totalValue], transaction: tx }
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
    if(counts[0].status==='posted'){await tx.commit();return {id:countId,status:'posted',already_applied:true};}
    assert(['approved', 'submitted'].includes(counts[0].status), 'Count must be submitted or approved before posting');
    const [lines] = await db.query('SELECT * FROM physical_count_lines WHERE count_id=? FOR UPDATE', { replacements: [countId], transaction: tx });
    assert(lines.length && lines.every(line => line.counted_qty !== null), 'All physical count lines must be counted');
    for (const line of lines) {
      assert(Number.isFinite(Number(line.counted_qty)) && Number(line.counted_qty)>=0,'Counted quantity must be non-negative');
      const [[stock]]=await db.query('SELECT current_qty FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE',{replacements:[line.item_id,counts[0].warehouse_id],transaction:tx});
      assert(Number(stock?.current_qty || 0)===Number(line.system_qty),'Stock changed after counting; cancel this count and recount before posting');
      const variance = Number(line.counted_qty) - Number(line.system_qty);
      if (!variance) continue;
      await applyStockEffect(db, { operationKey: `physical-count:${countId}:${line.id}`, referenceType: 'physical_count', referenceId: countId, itemId: line.item_id, warehouseId: counts[0].warehouse_id, quantity: Math.abs(variance), rate: 0, direction: variance > 0 ? 'in' : 'out', userId, transaction: tx });
    }

    await db.query("UPDATE physical_counts SET status='posted',posted_at=NOW(),approved_by=COALESCE(approved_by,?) WHERE id=?", { replacements: [userId || null, countId], transaction: tx });
    await audit(db, userId, 'physical_count_posted', 'physical_count', countId, { lines: lines.length }, tx);
    await tx.commit();
    return { id: countId, status: 'posted' };
  } catch (error) { await tx.rollback(); throw error; }
}

async function postProductionEffect(db, kind, id, userId, warehouseId) {
  if (kind === 'output') {
    const [[output]]=await db.query('SELECT * FROM production_outputs WHERE id=?',{replacements:[id]});
    assert(output,'Production output not found');
    const [[link]]=await db.query("SELECT target_id FROM related_documents WHERE source_type='production_order' AND source_id=? AND target_type='work_order' AND relation='execution'",{replacements:[output.production_order_id]});
    assert(link,'Release the production order and issue its materials before posting output');
    return require('./salesProduction.service').completeWorkOrder(db,link.target_id,warehouseId || output.warehouse_id,userId,id);
  }
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
      await db.query('INSERT INTO import_rows(id,import_job_id,row_no,payload,status) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload),status="processed",error_message=NULL', { replacements: [uuid(), id, index + 1, JSON.stringify(payload[index]), 'processed'], transaction: tx });
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
    const [line] = await db.query('SELECT q.rfq_supplier_id,q.item_id,s.rfq_id FROM rfq_quotation_lines q JOIN rfq_suppliers s ON s.id=q.rfq_supplier_id WHERE q.id=? FOR UPDATE', { replacements: [lineId], transaction: tx });
    assert(line.length, 'Quotation line not found');
    const [[rfq]]=await db.query('SELECT status FROM rfqs WHERE id=? FOR UPDATE',{replacements:[line[0].rfq_id],transaction:tx});
    assert(rfq && ['quoted','compared','selected'].includes(rfq.status),'Compare quotations before selecting a vendor');
    await db.query('UPDATE rfq_quotation_lines q JOIN rfq_suppliers s ON s.id=q.rfq_supplier_id SET q.is_selected=0 WHERE s.rfq_id=? AND q.item_id=?', { replacements: [line[0].rfq_id, line[0].item_id], transaction: tx });
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
module.exports = {
  TABLES, assert, audit, write, transition, actOnApproval, applyStockEffect,
  allocatePayment, postPhysicalCount, postProductionEffect, issueCreditNote, processImport, processExport, selectQuotation,
  compareQuotations
};
