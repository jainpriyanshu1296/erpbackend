const { v4: uuid } = require('uuid');

const transitions = {
  purchase_requisitions: { pending: ['approved', 'rejected', 'cancelled'], approved: ['cancelled'] },
  purchase_orders: { draft: ['sent', 'confirmed', 'cancelled'], sent: ['confirmed', 'cancelled'], confirmed: ['cancelled'] },
  grn: { draft: ['posted', 'cancelled'], posted: [] }
};

async function audit(db, userId, module, eventType, entityType, entityId, payload, transaction) {
  await db.query(
    'INSERT INTO audit_events(id,user_id,module,event_type,entity_type,entity_id,payload) VALUES(?,?,?,?,?,?,?)',
    { replacements: [uuid(), userId || null, module, eventType, entityType, entityId, JSON.stringify(payload || {})], transaction }
  );
}

function paging(query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

async function list(db, table, query) {
  const { page, limit, offset } = paging(query);
  const conditions = []; const values = [];
  const searchable = table === 'item_master' ? ['item_code', 'item_name', 'category']
    : table === 'vendors' ? ['vendor_code', 'company_name', 'email']
      : table === 'purchase_requisitions' ? ['pr_number', 'notes']
        : table === 'purchase_orders' ? ['po_number', 'vendor_id']
          : ['grn_number', 'vendor_id', 'po_id'];
  if (query.search) { conditions.push(`(${searchable.map(c => `${c} LIKE ?`).join(' OR ')})`); values.push(...searchable.map(() => `%${String(query.search).trim()}%`)); }
  if (query.status && table === 'item_master') { conditions.push('is_active=?'); values.push(query.status === 'active' ? 1 : 0); }
  if (query.status && table !== 'item_master' && table !== 'vendors') { conditions.push('status=?'); values.push(query.status); }
  if (query.is_active !== undefined && table === 'vendors') { conditions.push('is_active=?'); values.push(Number(query.is_active) ? 1 : 0); }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const [[count]] = await db.query(`SELECT COUNT(*) AS total FROM ${table}${where}`, { replacements: values });
  const [rows] = await db.query(`SELECT * FROM ${table}${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, { replacements: [...values, limit, offset] });
  return { rows, meta: { page, limit, total: Number(count.total || 0) } };
}

async function transition(db, table, id, next, userId) {
  const [rows] = await db.query(`SELECT id,status FROM ${table} WHERE id=? LIMIT 1`, { replacements: [id] });
  if (!rows[0]) return { error: 'NOT_FOUND' };
  const current = rows[0].status;
  if (!(transitions[table]?.[current] || []).includes(next)) return { error: 'INVALID_TRANSITION', current };
  await db.transaction(async transaction => {
    await db.query(`UPDATE ${table} SET status=?${table === 'grn' && next === 'posted' ? ', posted_at=NOW()' : ''} WHERE id=? AND status=?`, { replacements: [next, id, current], transaction });
    await audit(db, userId, table === 'grn' ? 'purchase' : 'purchase', 'status_transition', table, id, { from: current, to: next }, transaction);
  });
  return { id, status: next };
}

async function postGrn(db, grnId, userId) {
  return db.transaction(async transaction => {
    const [grns] = await db.query('SELECT * FROM grn WHERE id=? FOR UPDATE', { replacements: [grnId], transaction });
    if (!grns[0]) return { error: 'NOT_FOUND' };
    if (grns[0].status === 'posted' || grns[0].posted_at) return { error: 'ALREADY_POSTED' };
    if (grns[0].status !== 'draft') return { error: 'INVALID_TRANSITION', current: grns[0].status };
    const [items] = await db.query('SELECT * FROM grn_items WHERE grn_id=?', { replacements: [grnId], transaction });
    if (!items.length) return { error: 'EMPTY_GRN' };
    for (const item of items) {
      const warehouse = grns[0].warehouse_id || null;
      await db.query(
        'INSERT INTO stock_ledger(id,item_id,warehouse_id,transaction_type,reference_type,reference_id,qty_in,rate,amount,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)',
        { replacements: [uuid(), item.item_id, warehouse, 'grn', 'grn', grnId, item.quantity, item.rate || 0, Number(item.quantity) * Number(item.rate || 0), userId || null], transaction }
      );
      await db.query(
        `INSERT INTO stock_summary(item_id,warehouse_id,current_qty,avg_rate,total_value)
         VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE
         avg_rate=IF(current_qty+VALUES(current_qty)=0,0,(total_value+VALUES(total_value))/(current_qty+VALUES(current_qty))),
         current_qty=current_qty+VALUES(current_qty), total_value=total_value+VALUES(total_value)`,
        { replacements: [item.item_id, warehouse, item.quantity, item.rate || 0, Number(item.quantity) * Number(item.rate || 0)], transaction }
      );
    }
    await db.query('UPDATE grn SET status=?,posted_at=NOW() WHERE id=? AND status=?', { replacements: ['posted', grnId, 'draft'], transaction });
    await audit(db, userId, 'purchase', 'grn_posted', 'grn', grnId, { itemCount: items.length }, transaction);
    return { id: grnId, status: 'posted', itemCount: items.length };
  });
}

const transferTransitions = {
  draft: ['requested', 'cancelled'], requested: ['approved', 'cancelled'],
  approved: ['in_transit', 'cancelled'], in_transit: ['received', 'cancelled'],
  received: [], cancelled: []
};
const rfqTransitions = {
  draft: ['requested', 'cancelled'], requested: ['quoted', 'cancelled'],
  quoted: ['compared', 'cancelled'], compared: ['selected', 'cancelled'],
  selected: ['approved', 'cancelled'], approved: [], cancelled: []
};

async function transitionEntity(db, table, id, next, userId, transitionsMap) {
  return db.transaction(async transaction => {
    const [rows] = await db.query(`SELECT * FROM ${table} WHERE id=? FOR UPDATE`, { replacements: [id], transaction });
    if (!rows[0]) return { error: 'NOT_FOUND' };
    const current = rows[0].status;
    if (!(transitionsMap[current] || []).includes(next)) return { error: 'INVALID_TRANSITION', current };
    const fields = next === 'requested' ? ',requested_at=NOW()' : next === 'approved' ? ',approved_at=NOW(),approved_by=?'
      : next === 'received' ? ',received_at=NOW(),received_by=?' : '';
    const replacements = fields.includes('approved_by') ? [next, userId || null, id, current]
      : fields.includes('received_by') ? [next, userId || null, id, current] : [next, id, current];
    await db.query(`UPDATE ${table} SET status=?${fields} WHERE id=? AND status=?`, { replacements, transaction });
    await audit(db, userId, table === 'rfqs' ? 'purchase' : 'inventory', 'status_transition', table, id, { from: current, to: next }, transaction);
    return { id, status: next };
  });
}

async function receiveTransfer(db, transferId, userId) {
  return db.transaction(async transaction => {
    const [transfers] = await db.query('SELECT * FROM warehouse_transfers WHERE id=? FOR UPDATE', { replacements: [transferId], transaction });
    if (!transfers[0]) return { error: 'NOT_FOUND' };
    const transfer = transfers[0];
    const [receipts] = await db.query('SELECT id FROM warehouse_transfer_receipts WHERE transfer_id=? FOR UPDATE', { replacements: [transferId], transaction });
    if (receipts.length || transfer.status === 'received') return { id: transferId, status: 'received', alreadyReceived: true };
    if (transfer.status !== 'in_transit') return { error: 'INVALID_TRANSITION', current: transfer.status };
    const [items] = await db.query('SELECT * FROM warehouse_transfer_items WHERE transfer_id=?', { replacements: [transferId], transaction });
    if (!items.length) return { error: 'EMPTY_TRANSFER' };
    for (const item of items) {
      const [sourceRows] = await db.query(
        'SELECT current_qty,avg_rate FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE',
        { replacements: [item.item_id, transfer.from_warehouse_id], transaction }
      );
      const source = sourceRows[0];
      if (!source || Number(source.current_qty) < Number(item.quantity)) return { error: 'INSUFFICIENT_STOCK', item_id: item.item_id };
      await db.query('INSERT INTO stock_ledger(id,item_id,warehouse_id,transaction_type,reference_type,reference_id,qty_out,rate,amount,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)',
        { replacements: [uuid(), item.item_id, transfer.from_warehouse_id, 'transfer', 'warehouse_transfer', transferId, item.quantity, source.avg_rate || item.rate || 0, Number(item.quantity) * Number(item.rate || 0), userId || null], transaction });
      await db.query('INSERT INTO stock_ledger(id,item_id,warehouse_id,transaction_type,reference_type,reference_id,qty_in,rate,amount,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)',
        { replacements: [uuid(), item.item_id, transfer.to_warehouse_id, 'transfer', 'warehouse_transfer', transferId, item.quantity, item.rate || 0, Number(item.quantity) * Number(item.rate || 0), userId || null], transaction });
      for (const [warehouse, direction] of [[transfer.from_warehouse_id, -1], [transfer.to_warehouse_id, 1]]) {
        await db.query(`INSERT INTO stock_summary(item_id,warehouse_id,current_qty,avg_rate,total_value) VALUES(?,?,?,?,?)
          ON DUPLICATE KEY UPDATE current_qty=current_qty+VALUES(current_qty), total_value=total_value+VALUES(total_value)`,
          { replacements: [item.item_id, warehouse, direction * Number(item.quantity), item.rate || 0, direction * Number(item.quantity) * Number(item.rate || 0)], transaction });
      }
    }
    await db.query('INSERT INTO warehouse_transfer_receipts(id,transfer_id,received_by) VALUES(?,?,?)', { replacements: [uuid(), transferId, userId || null], transaction });
    await db.query('UPDATE warehouse_transfers SET status=?,received_by=?,received_at=NOW() WHERE id=? AND status=?', { replacements: ['received', userId || null, transferId, 'in_transit'], transaction });
    await audit(db, userId, 'inventory', 'transfer_received', 'warehouse_transfers', transferId, { itemCount: items.length }, transaction);
    return { id: transferId, status: 'received', itemCount: items.length };
  });
}

async function reserveStock(db, data, userId) {
  const quantity = Number(data.quantity);
  if (!data.item_id || !data.warehouse_id || !Number.isFinite(quantity) || quantity <= 0) return { error: 'VALIDATION_ERROR' };
  return db.transaction(async transaction => {
    const [stock] = await db.query('SELECT current_qty FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE', { replacements: [data.item_id, data.warehouse_id], transaction });
    const onHand = Number(stock[0]?.current_qty || 0);
    const [reservedRows] = await db.query("SELECT quantity FROM stock_reservations WHERE item_id=? AND warehouse_id=? AND status='reserved' FOR UPDATE", { replacements: [data.item_id, data.warehouse_id], transaction });
    const reserved = reservedRows.reduce((total, row) => total + Number(row.quantity || 0), 0);
    if (reserved + quantity > onHand) return { error: 'INSUFFICIENT_AVAILABLE_STOCK', onHand, reserved };
    const id = uuid();
    await db.query('INSERT INTO stock_reservations(id,item_id,warehouse_id,reference_type,reference_id,quantity,status,created_by) VALUES(?,?,?,?,?,?,?,?)',
      { replacements: [id, data.item_id, data.warehouse_id, data.reference_type || null, data.reference_id || null, quantity, 'reserved', userId || null], transaction });
    await audit(db, userId, 'inventory', 'stock_reserved', 'stock_reservations', id, { quantity }, transaction);
    return { id, status: 'reserved', quantity };
  });
}

async function changeReservation(db, id, action, userId) {
  if (!['released', 'consumed'].includes(action)) return { error: 'VALIDATION_ERROR' };
  return db.transaction(async transaction => {
    const [rows] = await db.query('SELECT * FROM stock_reservations WHERE id=? FOR UPDATE', { replacements: [id], transaction });
    if (!rows[0]) return { error: 'NOT_FOUND' };
    if (rows[0].status !== 'reserved') return { id, status: rows[0].status, alreadyChanged: true };
    await db.query('UPDATE stock_reservations SET status=? WHERE id=? AND status=?', { replacements: [action, id, 'reserved'], transaction });
    await audit(db, userId, 'inventory', `stock_${action}`, 'stock_reservations', id, {}, transaction);
    return { id, status: action };
  });
}

async function postStockCount(db, countId, userId) {
  return db.transaction(async transaction => {
    const [counts] = await db.query('SELECT * FROM stock_counts WHERE id=? FOR UPDATE', { replacements: [countId], transaction });
    if (!counts[0]) return { error: 'NOT_FOUND' };
    if (counts[0].status === 'posted') return { id: countId, status: 'posted', alreadyPosted: true };
    if (counts[0].status !== 'draft') return { error: 'INVALID_TRANSITION', current: counts[0].status };
    const [items] = await db.query('SELECT * FROM stock_count_items WHERE count_id=?', { replacements: [countId], transaction });
    if (!items.length) return { error: 'EMPTY_COUNT' };
    for (const item of items) {
      const delta = Number(item.counted_quantity) - Number(item.system_quantity || 0);
      if (!delta) continue;
      const direction = delta > 0 ? 'in' : 'out';
      await db.query('INSERT INTO stock_ledger(id,item_id,warehouse_id,transaction_type,reference_type,reference_id,qty_in,qty_out,rate,amount,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        { replacements: [uuid(), item.item_id, counts[0].warehouse_id, 'count', 'stock_count', countId, delta > 0 ? delta : 0, delta < 0 ? -delta : 0, item.rate || 0, delta * Number(item.rate || 0), userId || null], transaction });
      await db.query(`INSERT INTO stock_summary(item_id,warehouse_id,current_qty,avg_rate,total_value) VALUES(?,?,?,?,?)
        ON DUPLICATE KEY UPDATE current_qty=current_qty+VALUES(current_qty), total_value=total_value+VALUES(total_value)`,
        { replacements: [item.item_id, counts[0].warehouse_id, delta, item.rate || 0, delta * Number(item.rate || 0)], transaction });
    }
    await db.query('UPDATE stock_counts SET status=?,posted_by=?,posted_at=NOW() WHERE id=? AND status=?', { replacements: ['posted', userId || null, countId, 'draft'], transaction });
    await audit(db, userId, 'inventory', 'stock_count_posted', 'stock_counts', countId, { itemCount: items.length }, transaction);
    return { id: countId, status: 'posted', itemCount: items.length };
  });
}

async function reorderSuggestions(db) {
  const [rows] = await db.query(`SELECT i.id AS item_id,i.item_code,i.item_name,i.reorder_level,i.reorder_qty,
    COALESCE(SUM(s.current_qty),0) AS on_hand, GREATEST(i.reorder_level-COALESCE(SUM(s.current_qty),0),0) AS suggested_quantity
    FROM item_master i LEFT JOIN stock_summary s ON s.item_id=i.id WHERE i.is_active=1
    GROUP BY i.id,i.item_code,i.item_name,i.reorder_level,i.reorder_qty
    HAVING on_hand < i.reorder_level ORDER BY suggested_quantity DESC`);
  return rows;
}

module.exports = {
  list, transition, postGrn, audit, transferTransitions, rfqTransitions,
  transitionTransfer: (db, id, next, userId) => transitionEntity(db, 'warehouse_transfers', id, next, userId, transferTransitions),
  transitionRfq: (db, id, next, userId) => transitionEntity(db, 'rfqs', id, next, userId, rfqTransitions),
  receiveTransfer, reserveStock, changeReservation, postStockCount, reorderSuggestions
};
