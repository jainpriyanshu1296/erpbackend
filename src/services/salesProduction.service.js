const { v4: uuid } = require('uuid');
function calculateMRP(demand, onHand, scheduled = 0, safetyStock = 0) {
  const values = [demand, onHand, scheduled, safetyStock].map(Number);
  if (values.some(v => !Number.isFinite(v) || v < 0)) throw invalid('MRP quantities must be non-negative numbers');
  return Math.max(0, values[0] + values[3] - values[1] - values[2]);
}

const transitions = {
  quotations: { draft: ['sent', 'cancelled'], sent: ['accepted', 'rejected', 'expired'], accepted: ['cancelled'] },
  sales_orders: { draft: ['confirmed', 'cancelled'], confirmed: ['partially_delivered', 'delivered', 'cancelled'], partially_delivered: ['delivered', 'cancelled'] },
  invoices: { draft: ['issued', 'cancelled'], issued: ['part_paid', 'paid', 'void'], part_paid: ['paid', 'void'] },
  delivery_challans: { draft: ['dispatched', 'cancelled'], dispatched: ['delivered', 'cancelled'] },
  bom: { draft: ['active', 'archived'], active: ['archived'] },
  work_orders: { draft: ['released', 'cancelled'], released: ['in_progress', 'cancelled'], in_progress: ['completed', 'cancelled'] }
};

function invalid(message, code = 'VALIDATION_ERROR') {
  return Object.assign(new Error(message), { status: code === 'CONFLICT' ? 409 : 400, code });
}

async function transition(db, table, id, next, userId) {
  if (!transitions[table]) throw invalid('Unsupported workflow');
  const tx = await db.transaction();
  try {
    const [rows] = await db.query(`SELECT id,status FROM ${table} WHERE id=? FOR UPDATE`, { replacements: [id], transaction: tx });
    if (!rows.length) throw Object.assign(new Error('Record not found'), { status: 404, code: 'NOT_FOUND' });
    const current = rows[0].status || 'draft';
    if (!(transitions[table][current] || []).includes(next)) throw invalid(`Cannot transition ${table} from ${current} to ${next}`, 'CONFLICT');
    await db.query(`UPDATE ${table} SET status=? WHERE id=?`, { replacements: [next, id], transaction: tx });
    await db.query('INSERT INTO activity_log(id,user_id,module,action,reference_type,reference_id,changes) VALUES(?,?,?,?,?,?,?)', {
      replacements: [uuid(), userId || null, table === 'work_orders' || table === 'bom' ? 'production' : 'sales', `status.${next}`, table, id, JSON.stringify({ from: current, to: next })], transaction: tx
    });
    await tx.commit();
    return { id, status: next };
  } catch (error) { await tx.rollback(); throw error; }
}

async function dispatch(db, challanId, warehouseId, userId) {
  const tx = await db.transaction();
  try {
    const [challans] = await db.query('SELECT id,status,warehouse_id FROM delivery_challans WHERE id=? FOR UPDATE', { replacements: [challanId], transaction: tx });
    if (!challans.length) throw Object.assign(new Error('Delivery challan not found'), { status: 404, code: 'NOT_FOUND' });
    const challan = challans[0];
    const [effects] = await db.query('SELECT id FROM dispatch_effects WHERE challan_id=? LIMIT 1', { replacements: [challanId], transaction: tx });
    if (effects.length) { await tx.commit(); return { id: challanId, status: 'dispatched', already_applied: true }; }
    if (challan.status !== 'draft') throw invalid(`Cannot dispatch challan from ${challan.status}`, 'CONFLICT');
    const warehouse = warehouseId || challan.warehouse_id;
    if (!warehouse) throw invalid('warehouse_id is required');
    const [items] = await db.query('SELECT item_id,quantity FROM delivery_challan_items WHERE challan_id=?', { replacements: [challanId], transaction: tx });
    let itemLinks = [];
    try { [itemLinks] = await db.query('SELECT item_id,order_item_id FROM delivery_challan_items WHERE challan_id=?', { replacements: [challanId], transaction: tx }); } catch (_) { itemLinks = []; }
    items.forEach(item => { item.order_item_id = itemLinks.find(link => link.item_id === item.item_id)?.order_item_id || null; });
    if (!items.length) throw invalid('A delivery challan must contain items');
    for (const item of items) {
      const qty = Number(item.quantity);
      if (!item.item_id || !Number.isFinite(qty) || qty <= 0) throw invalid('Delivery item quantity must be positive');
      if (item.order_item_id) {
        const [[ordered]] = await db.query('SELECT quantity FROM sales_order_items WHERE id=? FOR UPDATE', { replacements: [item.order_item_id], transaction: tx });
        const [[sent]] = await db.query("SELECT COALESCE(SUM(dci.quantity),0) quantity FROM delivery_challan_items dci JOIN delivery_challans dc ON dc.id=dci.challan_id WHERE dci.order_item_id=? AND dc.status IN ('dispatched','delivered') AND dc.id<>?", { replacements: [item.order_item_id, challanId], transaction: tx });
        if (ordered && Number(sent.quantity) + qty > Number(ordered.quantity)) throw invalid('Dispatch quantity exceeds sales order quantity', 'CONFLICT');
      }
      const [stock] = await db.query('SELECT current_qty,avg_rate FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE', { replacements: [item.item_id, warehouse], transaction: tx });
      const current = Number(stock[0]?.current_qty || 0);
      if (current < qty) throw invalid('Insufficient stock', 'CONFLICT');
      const next = current - qty;
      await db.query('UPDATE stock_summary SET current_qty=?,total_value=? WHERE item_id=? AND warehouse_id=?', { replacements: [next, next * Number(stock[0]?.avg_rate || 0), item.item_id, warehouse], transaction: tx });
      await db.query('INSERT INTO stock_ledger(id,item_id,warehouse_id,transaction_type,reference_type,reference_id,qty_out,balance_qty,rate,amount,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)', {
        replacements: [uuid(), item.item_id, warehouse, 'dispatch', 'delivery_challan', challanId, qty, next, stock[0]?.avg_rate || 0, qty * Number(stock[0]?.avg_rate || 0), userId || null], transaction: tx
      });
    }
    await db.query('INSERT INTO dispatch_effects(id,challan_id) VALUES(?,?)', { replacements: [uuid(), challanId], transaction: tx });
    await db.query('UPDATE delivery_challans SET status=?,warehouse_id=?,dispatched_at=NOW() WHERE id=?', { replacements: ['dispatched', warehouse, challanId], transaction: tx });
    let challanOrder = null;
    try { [[challanOrder]] = await db.query('SELECT sales_order_id FROM delivery_challans WHERE id=?', { replacements: [challanId], transaction: tx }); } catch (_) { challanOrder = null; }
    if (challanOrder?.sales_order_id) {
      const [[remaining]] = await db.query("SELECT COUNT(*) count FROM sales_order_items soi LEFT JOIN (SELECT dci.order_item_id,SUM(dci.quantity) quantity FROM delivery_challan_items dci JOIN delivery_challans dc ON dc.id=dci.challan_id WHERE dc.sales_order_id=? AND dc.status IN ('dispatched','delivered') GROUP BY dci.order_item_id) sent ON sent.order_item_id=soi.id WHERE soi.order_id=? AND COALESCE(sent.quantity,0)<soi.quantity", { replacements: [challanOrder.sales_order_id, challanOrder.sales_order_id], transaction: tx });
      await db.query("UPDATE sales_orders SET status=? WHERE id=?", { replacements: [Number(remaining.count) ? 'partially_delivered' : 'delivered', challanOrder.sales_order_id], transaction: tx });
    }
    await tx.commit();
    return { id: challanId, status: 'dispatched', already_applied: false };
  } catch (error) { await tx.rollback(); throw error; }
}

async function issueMaterials(db, workOrderId, warehouseId, userId, issueKey = workOrderId) {
  const tx = await db.transaction();
  try {
    const [existing] = await db.query('SELECT id FROM material_issue_effects WHERE issue_key=? FOR UPDATE', { replacements: [issueKey], transaction: tx });
    if (existing.length) { await tx.commit(); return { work_order_id: workOrderId, already_applied: true }; }
    const [orders] = await db.query('SELECT w.*,b.output_qty FROM work_orders w LEFT JOIN bom b ON b.id=w.bom_id WHERE w.id=? FOR UPDATE', { replacements: [workOrderId], transaction: tx });
    if (!orders.length) throw Object.assign(new Error('Work order not found'), { status: 404, code: 'NOT_FOUND' });
    const order = orders[0], [components] = await db.query('SELECT item_id,quantity,scrap_percent FROM bom_components WHERE bom_id=?', { replacements: [order.bom_id], transaction: tx });
    const output = Number(order.planned_qty || 0);
    for (const component of components) {
      const qty = Number(component.quantity) * output / Number(order.output_qty || 1) * (1 + Number(component.scrap_percent || 0) / 100);
      const [stock] = await db.query('SELECT current_qty,avg_rate FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE', { replacements: [component.item_id, warehouseId], transaction: tx });
      const current = Number(stock[0]?.current_qty || 0);
      if (current < qty) throw invalid('Insufficient component stock', 'CONFLICT');
      await db.query('UPDATE stock_summary SET current_qty=?,total_value=? WHERE item_id=? AND warehouse_id=?', { replacements: [current - qty, (current - qty) * Number(stock[0]?.avg_rate || 0), component.item_id, warehouseId], transaction: tx });
      await db.query('INSERT INTO stock_ledger(id,item_id,warehouse_id,transaction_type,reference_type,reference_id,qty_out,balance_qty,rate,amount,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)', { replacements: [uuid(), component.item_id, warehouseId, 'material_issue', 'work_order', workOrderId, qty, current - qty, stock[0]?.avg_rate || 0, qty * Number(stock[0]?.avg_rate || 0), userId || null], transaction: tx });
    }
    await db.query('INSERT INTO material_issue_effects(id,issue_key,work_order_id,warehouse_id) VALUES(?,?,?,?)', { replacements: [uuid(), issueKey, workOrderId, warehouseId], transaction: tx });
    await tx.commit(); return { work_order_id: workOrderId, already_applied: false };
  } catch (error) { await tx.rollback(); throw error; }
}

const jobCardTransitions = { queued: ['started','cancelled'], started: ['paused','completed','cancelled'], paused: ['started','cancelled'], completed: [] };
async function transitionJobCard(db, id, next, userId) {
  const tx = await db.transaction();
  try {
    const [rows] = await db.query('SELECT id,status FROM job_cards WHERE id=? FOR UPDATE', { replacements: [id], transaction: tx });
    if (!rows.length) throw Object.assign(new Error('Job card not found'), { status: 404, code: 'NOT_FOUND' });
    const current = rows[0].status;
    if (!(jobCardTransitions[current] || []).includes(next)) throw invalid(`Cannot transition job card from ${current} to ${next}`, 'CONFLICT');
    await db.query('UPDATE job_cards SET status=? WHERE id=?', { replacements: [next, id], transaction: tx });
    await db.query('INSERT INTO activity_log(id,user_id,module,action,reference_type,reference_id,changes) VALUES(?,?,?,?,?,?,?)', { replacements: [uuid(), userId || null, 'production', `job_card.${next}`, 'job_card', id, JSON.stringify({ from: current, to: next })], transaction: tx });
    await tx.commit(); return { id, status: next };
  } catch (error) { await tx.rollback(); throw error; }
}

async function completeWorkOrder(db, workOrderId, warehouseId, userId) {
  const tx = await db.transaction();
  try {
    const [orders] = await db.query('SELECT w.*,b.output_qty FROM work_orders w LEFT JOIN bom b ON b.id=w.bom_id WHERE w.id=? FOR UPDATE', { replacements: [workOrderId], transaction: tx });
    if (!orders.length) throw Object.assign(new Error('Work order not found'), { status: 404, code: 'NOT_FOUND' });
    const order = orders[0];
    const [effects] = await db.query('SELECT id FROM production_effects WHERE work_order_id=? LIMIT 1', { replacements: [workOrderId], transaction: tx });
    if (effects.length) { await tx.commit(); return { id: workOrderId, status: 'completed', already_applied: true }; }
    if (order.status !== 'in_progress') throw invalid(`Cannot complete work order from ${order.status}`, 'CONFLICT');
    if (!warehouseId) throw invalid('warehouse_id is required');
    const output = Number(order.produced_qty || order.planned_qty || 0);
    if (output <= 0) throw invalid('Work order quantity must be positive');
    const [components] = await db.query('SELECT item_id,quantity,scrap_percent FROM bom_components WHERE bom_id=?', { replacements: [order.bom_id], transaction: tx });
    for (const component of components) {
      const qty = Number(component.quantity) * output / Number(order.output_qty || 1) * (1 + Number(component.scrap_percent || 0) / 100);
      const [stock] = await db.query('SELECT current_qty,avg_rate FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE', { replacements: [component.item_id, warehouseId], transaction: tx });
      const current = Number(stock[0]?.current_qty || 0);
      if (current < qty) throw invalid('Insufficient component stock', 'CONFLICT');
      await db.query('UPDATE stock_summary SET current_qty=?,total_value=? WHERE item_id=? AND warehouse_id=?', { replacements: [current - qty, (current - qty) * Number(stock[0]?.avg_rate || 0), component.item_id, warehouseId], transaction: tx });
      await db.query('INSERT INTO stock_ledger(id,item_id,warehouse_id,transaction_type,reference_type,reference_id,qty_out,balance_qty,rate,amount,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)', { replacements: [uuid(), component.item_id, warehouseId, 'production_consume', 'work_order', workOrderId, qty, current - qty, stock[0]?.avg_rate || 0, qty * Number(stock[0]?.avg_rate || 0), userId || null], transaction: tx });
    }
    const [finished] = await db.query('SELECT current_qty,avg_rate FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE', { replacements: [order.finished_item_id, warehouseId], transaction: tx });
    const currentFinished = Number(finished[0]?.current_qty || 0);
    await db.query('INSERT INTO stock_summary(item_id,warehouse_id,current_qty,avg_rate,total_value) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE current_qty=?,total_value=?', { replacements: [order.finished_item_id, warehouseId, currentFinished + output, finished[0]?.avg_rate || 0, (currentFinished + output) * Number(finished[0]?.avg_rate || 0), currentFinished + output, (currentFinished + output) * Number(finished[0]?.avg_rate || 0)], transaction: tx });
    await db.query('INSERT INTO stock_ledger(id,item_id,warehouse_id,transaction_type,reference_type,reference_id,qty_in,balance_qty,rate,amount,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)', { replacements: [uuid(), order.finished_item_id, warehouseId, 'production_output', 'work_order', workOrderId, output, currentFinished + output, finished[0]?.avg_rate || 0, output * Number(finished[0]?.avg_rate || 0), userId || null], transaction: tx });
    await db.query('INSERT INTO production_effects(id,work_order_id) VALUES(?,?)', { replacements: [uuid(), workOrderId], transaction: tx });
    await db.query('UPDATE work_orders SET status=?,produced_qty=? WHERE id=?', { replacements: ['completed', output, workOrderId], transaction: tx });
    await tx.commit();
    return { id: workOrderId, status: 'completed', already_applied: false };
  } catch (error) { await tx.rollback(); throw error; }
}

module.exports = { transition, dispatch, completeWorkOrder, issueMaterials, transitionJobCard, calculateMRP };
