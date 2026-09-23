const { v4: uuid } = require('uuid');
const { nextNumber } = require('./erp.service');
function calculateMRP(demand, onHand, scheduled = 0, safetyStock = 0) {
  const values = [demand, onHand, scheduled, safetyStock].map(Number);
  if (values.some(v => !Number.isFinite(v) || v < 0)) throw invalid('MRP quantities must be non-negative numbers');
  return Math.max(0, values[0] + values[3] - values[1] - values[2]);
}
function resolveOutputQuantity(producedQuantity, plannedQuantity, requestedQuantity = plannedQuantity) {
  const planned = Number(plannedQuantity);
  const produced = Number(producedQuantity);
  const requested = Number(requestedQuantity);
  if (!Number.isFinite(planned) || planned <= 0) throw invalid('Work order planned quantity must be positive');
  const output = Number.isFinite(produced) && produced > 0 ? produced : requested;
  if (!Number.isFinite(output) || output <= 0 || output > planned) throw invalid('Work order output must be positive and cannot exceed planned quantity');
  return output;
}

const transitions = {
  quotations: { draft: ['sent', 'cancelled'], sent: ['accepted', 'rejected', 'expired'], accepted: ['cancelled'] },
  sales_orders: { draft: ['confirmed', 'cancelled'], confirmed: ['cancelled'], partially_delivered: [] },
  invoices: { draft: ['issued', 'cancelled'], issued: [], part_paid: [], paid: [], cancelled: [] },
  delivery_challans: { draft: ['cancelled'], dispatched: ['delivered'] },
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
    if (table === 'invoices' && next === 'issued') await require('./accounting.service').postInvoiceEffect(db, id, userId, tx);
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
    const [challans] = await db.query('SELECT id,status,warehouse_id,so_id,customer_id FROM delivery_challans WHERE id=? FOR UPDATE', { replacements: [challanId], transaction: tx });
    if (!challans.length) throw Object.assign(new Error('Delivery challan not found'), { status: 404, code: 'NOT_FOUND' });
    const challan = challans[0];
    const [effects] = await db.query('SELECT id FROM dispatch_effects WHERE challan_id=? LIMIT 1', { replacements: [challanId], transaction: tx });
    if (effects.length) { await tx.commit(); return { id: challanId, status: 'dispatched', already_applied: true }; }
    if (challan.status !== 'draft') throw invalid(`Cannot dispatch challan from ${challan.status}`, 'CONFLICT');
    const warehouse = warehouseId || challan.warehouse_id;
    if (!warehouse) throw invalid('warehouse_id is required');
    const [items] = await db.query('SELECT id,item_id,quantity,order_item_id FROM delivery_challan_items WHERE challan_id=? ORDER BY item_id,id', { replacements: [challanId], transaction: tx });
    let orderLines = [];
    if (challan.so_id) {
      const [[order]] = await db.query('SELECT id,status,customer_id FROM sales_orders WHERE id=? FOR UPDATE', { replacements: [challan.so_id], transaction: tx });
      if (!order || !['confirmed','approved','partially_delivered'].includes(order.status) || order.customer_id !== challan.customer_id) throw invalid('Challan requires a matching confirmed customer order');
      [orderLines] = await db.query('SELECT id,item_id,quantity FROM sales_order_items WHERE so_id=?', { replacements: [challan.so_id], transaction: tx });
    }
    const allocated = new Map();
    if (!items.length) throw invalid('A delivery challan must contain items');
    for (const item of items) {
      const qty = Number(item.quantity);
      if (!item.item_id || !Number.isFinite(qty) || qty <= 0) throw invalid('Delivery item quantity must be positive');
      if (item.order_item_id && !challan.so_id) throw invalid('An order line requires a matching sales order on the challan');
      if (challan.so_id) {
        const matches = orderLines.filter(line => line.item_id === item.item_id && (!item.order_item_id || line.id === item.order_item_id));
        if (matches.length !== 1) throw invalid('Select an unambiguous matching sales order line');
        item.order_item_id = matches[0].id;
        await db.query('UPDATE delivery_challan_items SET order_item_id=? WHERE id=?', { replacements: [item.order_item_id, item.id], transaction: tx });
      }
      if (item.order_item_id) {
        const [[ordered]] = await db.query('SELECT quantity FROM sales_order_items WHERE id=? FOR UPDATE', { replacements: [item.order_item_id], transaction: tx });
        const [[sent]] = await db.query("SELECT COALESCE(SUM(dci.quantity),0) quantity FROM delivery_challan_items dci JOIN delivery_challans dc ON dc.id=dci.challan_id WHERE dci.order_item_id=? AND dc.status IN ('dispatched','delivered') AND dc.id<>? FOR UPDATE", { replacements: [item.order_item_id, challanId], transaction: tx });
        const cumulative = (allocated.get(item.order_item_id) || 0) + qty;
        allocated.set(item.order_item_id, cumulative);
        if (!ordered || Number(sent.quantity) + cumulative > Number(ordered.quantity)) throw invalid('Dispatch quantity exceeds sales order quantity', 'CONFLICT');
        await db.query('UPDATE sales_order_items SET delivered_qty=? WHERE id=?',{replacements:[Number(sent.quantity)+cumulative,item.order_item_id],transaction:tx});
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
    const challanOrder = challan;
    if (challanOrder?.so_id) {
      const [[remaining]] = await db.query("SELECT COUNT(*) count FROM sales_order_items soi LEFT JOIN (SELECT dci.order_item_id,SUM(dci.quantity) quantity FROM delivery_challan_items dci JOIN delivery_challans dc ON dc.id=dci.challan_id WHERE dc.so_id=? AND dc.status IN ('dispatched','delivered') GROUP BY dci.order_item_id) sent ON sent.order_item_id=soi.id WHERE soi.so_id=? AND COALESCE(sent.quantity,0)<soi.quantity", { replacements: [challanOrder.so_id, challanOrder.so_id], transaction: tx });
      await db.query("UPDATE sales_orders SET status=? WHERE id=?", { replacements: [Number(remaining.count) ? 'partially_delivered' : 'delivered', challanOrder.so_id], transaction: tx });
    }
    await tx.commit();
    return { id: challanId, status: 'dispatched', already_applied: false };
  } catch (error) { await tx.rollback(); throw error; }
}

async function issueMaterials(db, workOrderId, warehouseId, userId, issueKey = workOrderId) {
  const tx = await db.transaction();
  try {
    const [orders] = await db.query('SELECT w.*,b.output_qty FROM work_orders w LEFT JOIN bom b ON b.id=w.bom_id WHERE w.id=? FOR UPDATE', { replacements: [workOrderId], transaction: tx });
    if (!orders.length) throw Object.assign(new Error('Work order not found'), { status: 404, code: 'NOT_FOUND' });
    const [existing] = await db.query('SELECT id FROM material_issue_effects WHERE work_order_id=? FOR UPDATE', { replacements: [workOrderId], transaction: tx });
    if (existing.length) { await tx.commit(); return { work_order_id: workOrderId, already_applied: true }; }
    if (!warehouseId || !['released','in_progress'].includes(orders[0].status)) throw invalid('A released work order and warehouse are required');
    const order = orders[0], [components] = await db.query('SELECT item_id,quantity,scrap_percent FROM bom_components WHERE bom_id=?', { replacements: [order.bom_id], transaction: tx });
    const output = Number(order.planned_qty || 0);
    if (!Number.isFinite(output) || output<=0 || !components.length || !Number.isFinite(Number(order.output_qty)) || Number(order.output_qty)<=0) throw invalid('Valid BOM components, output quantity and planned quantity are required');
    for (const component of components) {
      const qty = Number(component.quantity) * output / Number(order.output_qty || 1) * (1 + Number(component.scrap_percent || 0) / 100);
      if(!Number.isFinite(qty)||qty<=0) throw invalid('Invalid BOM component quantity');
      const [stock] = await db.query('SELECT current_qty,avg_rate FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE', { replacements: [component.item_id, warehouseId], transaction: tx });
      const current = Number(stock[0]?.current_qty || 0);
      if (current < qty) throw invalid('Insufficient component stock', 'CONFLICT');
      await db.query('UPDATE stock_summary SET current_qty=?,total_value=? WHERE item_id=? AND warehouse_id=?', { replacements: [current - qty, (current - qty) * Number(stock[0]?.avg_rate || 0), component.item_id, warehouseId], transaction: tx });
      await db.query('INSERT INTO stock_ledger(id,item_id,warehouse_id,transaction_type,reference_type,reference_id,qty_out,balance_qty,rate,amount,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)', { replacements: [uuid(), component.item_id, warehouseId, 'material_issue', 'work_order', workOrderId, qty, current - qty, stock[0]?.avg_rate || 0, qty * Number(stock[0]?.avg_rate || 0), userId || null], transaction: tx });
    }
    await db.query('INSERT INTO material_issue_effects(id,issue_key,work_order_id,warehouse_id) VALUES(?,?,?,?)', { replacements: [uuid(), `work-order:${workOrderId}`, workOrderId, warehouseId], transaction: tx });
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

async function completeWorkOrder(db, workOrderId, warehouseId, userId, requestedOutputId = null) {
  const tx = await db.transaction();
  try {
    const [orders] = await db.query('SELECT w.*,b.output_qty FROM work_orders w LEFT JOIN bom b ON b.id=w.bom_id WHERE w.id=? FOR UPDATE', { replacements: [workOrderId], transaction: tx });
    if (!orders.length) throw Object.assign(new Error('Work order not found'), { status: 404, code: 'NOT_FOUND' });
    const order = orders[0];
    const [effects] = await db.query('SELECT id FROM production_effects WHERE work_order_id=? LIMIT 1', { replacements: [workOrderId], transaction: tx });
    if (effects.length) {
      if (requestedOutputId) {
        const [[posted]]=await db.query('SELECT id FROM stock_effects WHERE operation_key=?',{replacements:[`production-output:${requestedOutputId}`],transaction:tx});
        if (!posted) throw invalid('This work order already has a posted production output','CONFLICT');
      }
      await tx.commit(); return { id: workOrderId, status: 'completed', already_applied: true };
    }
    if (order.status !== 'in_progress') throw invalid(`Cannot complete work order from ${order.status}`, 'CONFLICT');
    if (!warehouseId) throw invalid('warehouse_id is required');
    const planned = Number(order.planned_qty);
    let [[link]]=await db.query("SELECT source_id FROM related_documents WHERE source_type='production_order' AND target_type='work_order' AND target_id=? AND relation='execution' LIMIT 1",{replacements:[workOrderId],transaction:tx});
    if (!link) {
      const productionId=uuid();
      await db.query("INSERT INTO production_orders(id,production_number,so_id,bom_id,item_id,planned_qty,status,created_by) VALUES(?,?,?,?,?,?,'in_progress',?)",{replacements:[productionId,`PROD-${productionId}`,order.so_id || null,order.bom_id,order.finished_item_id,order.planned_qty,userId],transaction:tx});
      await db.query("INSERT INTO related_documents(id,source_type,source_id,target_type,target_id,relation,created_by) VALUES(?,'production_order',?,'work_order',?,'execution',?)",{replacements:[uuid(),productionId,workOrderId,userId],transaction:tx});
      link={source_id:productionId};
    }
    const outputId=requestedOutputId || uuid();
    let requested = null;
    if (requestedOutputId) {
      [[requested]]=await db.query('SELECT * FROM production_outputs WHERE id=? FOR UPDATE',{replacements:[requestedOutputId],transaction:tx});
      if (!requested || requested.production_order_id!==link.source_id || requested.item_id!==order.finished_item_id || requested.warehouse_id!==warehouseId) throw invalid('Output must match the work order and warehouse');
    }
    const output = resolveOutputQuantity(order.produced_qty, planned, requested ? requested.quantity : planned);
    const [issued] = await db.query('SELECT id FROM material_issue_effects WHERE work_order_id=?',{replacements:[workOrderId],transaction:tx});
    if (!issued.length) throw invalid('Issue materials before completing production');
    const [finished] = await db.query('SELECT current_qty,avg_rate FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE', { replacements: [order.finished_item_id, warehouseId], transaction: tx });
    const currentFinished = Number(finished[0]?.current_qty || 0);
    await db.query('INSERT INTO stock_summary(item_id,warehouse_id,current_qty,avg_rate,total_value) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE current_qty=?,total_value=?', { replacements: [order.finished_item_id, warehouseId, currentFinished + output, finished[0]?.avg_rate || 0, (currentFinished + output) * Number(finished[0]?.avg_rate || 0), currentFinished + output, (currentFinished + output) * Number(finished[0]?.avg_rate || 0)], transaction: tx });
    await db.query('INSERT INTO stock_ledger(id,item_id,warehouse_id,transaction_type,reference_type,reference_id,qty_in,balance_qty,rate,amount,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)', { replacements: [uuid(), order.finished_item_id, warehouseId, 'production_output', 'work_order', workOrderId, output, currentFinished + output, finished[0]?.avg_rate || 0, output * Number(finished[0]?.avg_rate || 0), userId || null], transaction: tx });
    await db.query('INSERT INTO production_effects(id,work_order_id) VALUES(?,?)', { replacements: [uuid(), workOrderId], transaction: tx });
    if(link) {
      if (!requestedOutputId) await db.query('INSERT INTO production_outputs(id,production_order_id,item_id,quantity,warehouse_id,recorded_by) VALUES(?,?,?,?,?,?)',{replacements:[outputId,link.source_id,order.finished_item_id,output,warehouseId,userId],transaction:tx});
      await db.query('INSERT INTO stock_effects(id,operation_key,reference_type,reference_id) VALUES(?,?,?,?)',{replacements:[uuid(),`production-output:${outputId}`,'production_output',outputId],transaction:tx});
      await db.query("UPDATE production_outputs SET status='posted' WHERE id=?",{replacements:[outputId],transaction:tx});
      await db.query("UPDATE production_orders SET status='completed' WHERE id=?",{replacements:[link.source_id],transaction:tx});
    }
    await db.query('UPDATE work_orders SET status=?,produced_qty=? WHERE id=?', { replacements: ['completed', output, workOrderId], transaction: tx });
    await tx.commit();
    return { id: workOrderId, output_id:outputId, production_order_id:link.source_id, status: 'completed', already_applied: false };
  } catch (error) { await tx.rollback(); throw error; }
}

async function releaseProductionOrder(db,id,userId) {
  const tx=await db.transaction();
  try {
    const query=(sql,replacements=[])=>db.query(sql,{replacements,transaction:tx});
    const [[order]]=await query('SELECT * FROM production_orders WHERE id=? FOR UPDATE',[id]);
    if(!order) throw invalid('Production order not found');
    const [[existing]]=await query("SELECT target_id FROM related_documents WHERE source_type='production_order' AND source_id=? AND target_type='work_order' AND relation='execution'",[id]);
    if(existing){await tx.commit();return {id,work_order_id:existing.target_id,already_released:true};}
    if(order.status!=='draft') throw invalid('Only draft production orders can be released');
    const [[bom]]=await query('SELECT * FROM bom WHERE id=? AND finished_item_id=? AND is_active=1',[order.bom_id,order.item_id]);
    const [components]=await query('SELECT item_id,quantity FROM bom_components WHERE bom_id=?',[order.bom_id]);
    if(!bom || !components.length || Number(order.planned_qty)<=0) throw invalid('Production requires a matching active BOM with components');
    const workId=uuid(),cardId=uuid();
    await query("INSERT INTO work_orders(id,wo_number,finished_item_id,bom_id,planned_qty,status,so_id) VALUES(?,?,?,?,?,'released',?)",[workId,`WO-${workId}`,order.item_id,order.bom_id,order.planned_qty,order.so_id || null]);
    await query("INSERT INTO job_cards(id,production_order_id,status,planned_qty) VALUES(?,?,'queued',?)",[cardId,id,order.planned_qty]);
    await query("INSERT INTO related_documents(id,source_type,source_id,target_type,target_id,relation,created_by) VALUES(?,'production_order',?,'work_order',?,'execution',?)",[uuid(),id,workId,userId]);
    await query("UPDATE production_orders SET status='released' WHERE id=?",[id]);
    await tx.commit();return {id,work_order_id:workId,job_card_id:cardId,status:'released'};
  } catch(cause){await tx.rollback();throw cause;}
}

async function createSalesOrderFromQuotation(db, quotationId) {
  if (!quotationId) throw invalid('quotation_id is required');
  const tx = await db.transaction();
  try {
    const [[quote]] = await db.query('SELECT * FROM quotations WHERE id=? FOR UPDATE', { replacements: [quotationId], transaction: tx });
    if (!quote) throw Object.assign(new Error('Quotation not found'), { status: 404, code: 'NOT_FOUND' });
    const [[existing]] = await db.query('SELECT id,so_number,status FROM sales_orders WHERE quotation_id=? LIMIT 1 FOR UPDATE', { replacements: [quotationId], transaction: tx });
    if (existing) { await tx.commit(); return { id: existing.id, so_number: existing.so_number, quotation_id: quotationId, status: existing.status, already_converted: true }; }
    if (!['accepted', 'approved'].includes(quote.status)) throw invalid('Only an accepted quotation can create an order', 'CONFLICT');
    const [source] = await db.query('SELECT * FROM quotation_items WHERE quotation_id=? ORDER BY id', { replacements: [quotationId], transaction: tx });
    if (!source.length) throw invalid('Quotation has no items');
    const id = uuid(), number = await nextNumber(db, 'sales_order', 'SO-', 5, tx);
    await db.query("INSERT INTO sales_orders(id,so_number,quotation_id,customer_id,status,total_amount) VALUES(?,?,?,?,'confirmed',?)", { replacements: [id, number, quotationId, quote.customer_id, Number(quote.total_amount || 0)], transaction: tx });
    for (const item of source) await db.query('INSERT INTO sales_order_items(id,so_id,item_id,quantity,rate,discount_percent,gst_rate,quotation_item_id) VALUES(?,?,?,?,?,?,?,?)', { replacements: [uuid(), id, item.item_id, item.quantity, item.rate, item.discount_percent || 0, item.gst_rate ?? 0, item.id], transaction: tx });
    await db.query("UPDATE quotations SET status='converted' WHERE id=?", { replacements: [quotationId], transaction: tx });
    await tx.commit();
    return { id, so_number: number, quotation_id: quotationId, status: 'confirmed', already_converted: false };
  } catch (error) { await tx.rollback(); throw error; }
}

module.exports = { transition, dispatch, completeWorkOrder, issueMaterials, transitionJobCard, calculateMRP, resolveOutputQuantity, releaseProductionOrder, createSalesOrderFromQuotation };
