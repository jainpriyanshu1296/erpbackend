const { v4: uuid } = require('uuid');

const transitions = {
  purchase_requisitions: {
    draft: ['submitted', 'cancelled'],
    submitted: ['approved', 'rejected', 'cancelled'],
    pending: ['approved', 'rejected', 'cancelled'],
    approved: ['cancelled'],
  },
  purchase_orders: {
    draft: ['submitted', 'cancelled'],
    submitted: ['approved', 'rejected', 'cancelled'],
    approved: ['sent', 'confirmed', 'cancelled'],
    sent: ['confirmed', 'cancelled'],
    confirmed: ['cancelled'],
  },
  grn: { draft: ['posted', 'cancelled'], posted: [] },
};

async function audit(
  db,
  userId,
  module,
  eventType,
  entityType,
  entityId,
  payload,
  transaction,
) {
  await db.query(
    'INSERT INTO audit_events(id,user_id,module,event_type,entity_type,entity_id,payload) VALUES(?,?,?,?,?,?,?)',
    {
      replacements: [
        uuid(),
        userId || null,
        module,
        eventType,
        entityType,
        entityId,
        JSON.stringify(payload || {}),
      ],
      transaction,
    },
  );
}

function paging(query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(query.limit, 10) || 20),
  );
  return { page, limit, offset: (page - 1) * limit };
}

async function list(db, table, query) {
  const { page, limit, offset } = paging(query);
  const conditions = [];
  const values = [];
  const searchable =
    table === 'item_master'
      ? ['item_code', 'item_name', 'category']
      : table === 'vendors'
        ? ['vendor_code', 'company_name', 'email']
        : table === 'purchase_requisitions'
          ? ['pr_number', 'notes']
          : table === 'purchase_orders'
            ? ['po_number', 'vendor_id']
            : ['grn_number', 'vendor_id', 'po_id'];
  if (query.search) {
    conditions.push(`(${searchable.map((c) => `${c} LIKE ?`).join(' OR ')})`);
    values.push(...searchable.map(() => `%${String(query.search).trim()}%`));
  }
  if (query.status && table === 'item_master') {
    conditions.push('is_active=?');
    values.push(query.status === 'active' ? 1 : 0);
  }
  if (query.status && table !== 'item_master' && table !== 'vendors') {
    conditions.push('status=?');
    values.push(query.status);
  }
  if (query.is_active !== undefined && table === 'vendors') {
    conditions.push('is_active=?');
    values.push(Number(query.is_active) ? 1 : 0);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const [[count]] = await db.query(
    `SELECT COUNT(*) AS total FROM ${table}${where}`,
    { replacements: values },
  );
  const [rows] = await db.query(
    `SELECT * FROM ${table}${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    { replacements: [...values, limit, offset] },
  );
  return { rows, meta: { page, limit, total: Number(count.total || 0) } };
}

async function transition(db, table, id, next, userId) {
  if (table === 'grn' && next === 'posted') return postGrn(db, id, userId);
  return db.transaction(async (transaction) => {
    const [rows] = await db.query(
      `SELECT id,status FROM ${table} WHERE id=? FOR UPDATE`,
      { replacements: [id], transaction },
    );
    if (!rows[0]) return { error: 'NOT_FOUND' };
    const current = rows[0].status;
    if (!(transitions[table]?.[current] || []).includes(next))
      return { error: 'INVALID_TRANSITION', current };
    await db.query(
      `UPDATE ${table} SET status=?${table === 'grn' && next === 'posted' ? ', posted_at=NOW()' : ''} WHERE id=? AND status=?`,
      { replacements: [next, id, current], transaction },
    );
    await audit(
      db,
      userId,
      table === 'grn' ? 'purchase' : 'purchase',
      'status_transition',
      table,
      id,
      { from: current, to: next },
      transaction,
    );
    return { id, status: next };
  });
}

async function postGrn(db, grnId, userId, input = {}) {
  return db.transaction(async (transaction) => {
    const query = (sql, replacements = []) =>
      db.query(sql, { replacements, transaction });
    const [[grn]] = await query('SELECT * FROM grn WHERE id=? FOR UPDATE', [
      grnId,
    ]);
    if (!grn) return { error: 'NOT_FOUND' };
    if (grn.status === 'posted')
      return { id: grnId, status: 'posted', already_posted: true };
    if (grn.status !== 'draft') return { error: 'INVALID_TRANSITION' };
    let order;
    if (grn.po_id) {
      [[order]] = await query(
        'SELECT * FROM purchase_orders WHERE id=? FOR UPDATE',
        [grn.po_id],
      );
      if (
        !order ||
        !['approved', 'confirmed', 'part_received'].includes(order.status) ||
        order.vendor_id !== grn.vendor_id
      )
        return { error: 'INVALID_PURCHASE_ORDER' };
    }
    const warehouse =
      input.warehouse_id || grn.warehouse_id || order?.warehouse_id;
    const [[wh]] = await query(
      'SELECT id FROM warehouses WHERE id=? AND is_active=1',
      [warehouse || null],
    );
    if (!wh) return { error: 'INVALID_WAREHOUSE' };
    const [items] = await query(
      'SELECT * FROM grn_items WHERE grn_id=? ORDER BY item_id,id',
      [grnId],
    );
    if (!items.length) return { error: 'EMPTY_GRN' };
    const pending = new Map();
    for (const item of items) {
      if (
        !item.item_id ||
        !Number.isFinite(Number(item.quantity)) ||
        Number(item.quantity) <= 0 ||
        !Number.isFinite(Number(item.rate || 0)) ||
        Number(item.rate || 0) < 0
      )
        throw Object.assign(
          new Error('Invalid receipt item quantity or rate'),
          { status: 400 },
        );
      const [[master]] = await query(
        'SELECT id FROM item_master WHERE id=? AND is_active=1',
        [item.item_id],
      );
      if (!master)
        throw Object.assign(
          new Error('Receipt requires an active Item Master record'),
          { status: 400 },
        );
      if (order) {
        const [matches] = await query(
          'SELECT id,quantity FROM purchase_order_items WHERE order_id=? AND item_id=?' +
            (item.po_item_id ? ' AND id=?' : ''),
          [
            order.id,
            item.item_id,
            ...(item.po_item_id ? [item.po_item_id] : []),
          ],
        );
        if (matches.length !== 1)
          throw Object.assign(
            new Error(
              'Receipt item must identify a matching purchase order line',
            ),
            { status: 400 },
          );
        const line = matches[0];
        const [[received]] = await query(
          "SELECT COALESCE(SUM(gi.quantity),0) quantity FROM grn_items gi JOIN grn g ON g.id=gi.grn_id WHERE gi.po_item_id=? AND g.status='posted'",
          [line.id],
        );
        const quantity = (pending.get(line.id) || 0) + Number(item.quantity);
        pending.set(line.id, quantity);
        if (Number(received.quantity) + quantity > Number(line.quantity))
          throw Object.assign(new Error('Receipt exceeds ordered quantity'), {
            status: 409,
          });
        await query('UPDATE grn_items SET po_item_id=? WHERE id=?', [
          line.id,
          item.id,
        ]);
      }
    }
    await query(
      "UPDATE grn SET status='posted',warehouse_id=?,posted_at=NOW() WHERE id=?",
      [warehouse, grnId],
    );
    if (order)
      await query(
        "UPDATE purchase_orders SET status='part_received' WHERE id=?",
        [order.id],
      );
    await audit(
      db,
      userId,
      'purchase',
      'grn_posted',
      'grn',
      grnId,
      { itemCount: items.length, awaiting_qc: true },
      transaction,
    );
    return {
      id: grnId,
      status: 'posted',
      itemCount: items.length,
      awaiting_qc: true,
    };
  });
}

const transferTransitions = {
  draft: ['requested', 'cancelled'],
  requested: ['approved', 'cancelled'],
  approved: ['in_transit', 'cancelled'],
  in_transit: ['cancelled'],
  received: [],
  cancelled: [],
};
const rfqTransitions = {
  draft: ['requested', 'cancelled'],
  requested: ['quoted', 'cancelled'],
  quoted: ['compared', 'cancelled'],
  compared: ['selected', 'cancelled'],
  selected: ['approved', 'cancelled'],
  approved: [],
  cancelled: [],
};

async function transitionEntity(db, table, id, next, userId, transitionsMap) {
  return db.transaction(async (transaction) => {
    const [rows] = await db.query(
      `SELECT * FROM ${table} WHERE id=? FOR UPDATE`,
      { replacements: [id], transaction },
    );
    if (!rows[0]) return { error: 'NOT_FOUND' };
    const current = rows[0].status;
    if (!(transitionsMap[current] || []).includes(next))
      return { error: 'INVALID_TRANSITION', current };
    const fields =
      next === 'requested'
        ? ',requested_at=NOW()'
        : next === 'approved'
          ? ',approved_at=NOW(),approved_by=?'
          : next === 'received'
            ? ',received_at=NOW(),received_by=?'
            : '';
    const replacements = fields.includes('approved_by')
      ? [next, userId || null, id, current]
      : fields.includes('received_by')
        ? [next, userId || null, id, current]
        : [next, id, current];
    await db.query(
      `UPDATE ${table} SET status=?${fields} WHERE id=? AND status=?`,
      { replacements, transaction },
    );
    await audit(
      db,
      userId,
      table === 'rfqs' ? 'purchase' : 'inventory',
      'status_transition',
      table,
      id,
      { from: current, to: next },
      transaction,
    );
    return { id, status: next };
  });
}

async function receiveTransfer(db, transferId, userId) {
  return db.transaction(async (transaction) => {
    const [transfers] = await db.query(
      'SELECT * FROM warehouse_transfers WHERE id=? FOR UPDATE',
      { replacements: [transferId], transaction },
    );
    if (!transfers[0]) return { error: 'NOT_FOUND' };
    const transfer = transfers[0];
    const [receipts] = await db.query(
      'SELECT id FROM warehouse_transfer_receipts WHERE transfer_id=? FOR UPDATE',
      { replacements: [transferId], transaction },
    );
    if (receipts.length || transfer.status === 'received')
      return { id: transferId, status: 'received', alreadyReceived: true };
    if (!['approved', 'in_transit'].includes(transfer.status))
      return { error: 'INVALID_TRANSITION', current: transfer.status };
    if (transfer.from_warehouse_id === transfer.to_warehouse_id)
      return { error: 'INVALID_WAREHOUSES' };
    const [items] = await db.query(
      'SELECT * FROM warehouse_transfer_items WHERE transfer_id=? ORDER BY item_id',
      { replacements: [transferId], transaction },
    );
    if (!items.length) return { error: 'EMPTY_TRANSFER' };
    for (const item of items) {
      if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0)
        throw Object.assign(new Error('Transfer quantity must be positive'), {
          status: 400,
          code: 'INVALID_QUANTITY',
        });
      const [sourceRows] = await db.query(
        'SELECT current_qty,avg_rate FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE',
        {
          replacements: [item.item_id, transfer.from_warehouse_id],
          transaction,
        },
      );
      const source = sourceRows[0];
      if (!source || Number(source.current_qty) < Number(item.quantity))
        throw Object.assign(
          new Error(`Insufficient stock for item ${item.item_id}`),
          { status: 409, code: 'INSUFFICIENT_STOCK' },
        );
      const rate = Number(source.avg_rate || 0);
      await db.query(
        'INSERT INTO stock_ledger(id,item_id,warehouse_id,transaction_type,reference_type,reference_id,qty_out,rate,amount,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)',
        {
          replacements: [
            uuid(),
            item.item_id,
            transfer.from_warehouse_id,
            'transfer',
            'warehouse_transfer',
            transferId,
            item.quantity,
            rate,
            Number(item.quantity) * rate,
            userId || null,
          ],
          transaction,
        },
      );
      await db.query(
        'INSERT INTO stock_ledger(id,item_id,warehouse_id,transaction_type,reference_type,reference_id,qty_in,rate,amount,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)',
        {
          replacements: [
            uuid(),
            item.item_id,
            transfer.to_warehouse_id,
            'transfer',
            'warehouse_transfer',
            transferId,
            item.quantity,
            rate,
            Number(item.quantity) * rate,
            userId || null,
          ],
          transaction,
        },
      );
      for (const [warehouse, direction] of [
        [transfer.from_warehouse_id, -1],
        [transfer.to_warehouse_id, 1],
      ]) {
        await db.query(
          `INSERT INTO stock_summary(item_id,warehouse_id,current_qty,avg_rate,total_value) VALUES(?,?,?,?,?)
          ON DUPLICATE KEY UPDATE avg_rate=IF(current_qty+VALUES(current_qty)>0,(total_value+VALUES(total_value))/(current_qty+VALUES(current_qty)),avg_rate), current_qty=current_qty+VALUES(current_qty), total_value=total_value+VALUES(total_value)`,
          {
            replacements: [
              item.item_id,
              warehouse,
              direction * Number(item.quantity),
              rate,
              direction * Number(item.quantity) * rate,
            ],
            transaction,
          },
        );
      }
    }
    await db.query(
      'INSERT INTO warehouse_transfer_receipts(id,transfer_id,received_by) VALUES(?,?,?)',
      { replacements: [uuid(), transferId, userId || null], transaction },
    );
    await db.query(
      'UPDATE warehouse_transfers SET status=?,received_by=?,received_at=NOW() WHERE id=? AND status=?',
      {
        replacements: ['received', userId || null, transferId, transfer.status],
        transaction,
      },
    );
    await audit(
      db,
      userId,
      'inventory',
      'transfer_received',
      'warehouse_transfers',
      transferId,
      { itemCount: items.length },
      transaction,
    );
    return { id: transferId, status: 'received', itemCount: items.length };
  });
}

async function reserveStock(db, data, userId) {
  const quantity = Number(data.quantity);
  if (
    !data.item_id ||
    !data.warehouse_id ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  )
    return { error: 'VALIDATION_ERROR' };
  return db.transaction(async (transaction) => {
    const [stock] = await db.query(
      'SELECT current_qty FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE',
      { replacements: [data.item_id, data.warehouse_id], transaction },
    );
    const onHand = Number(stock[0]?.current_qty || 0);
    const [reservedRows] = await db.query(
      "SELECT quantity FROM stock_reservations WHERE item_id=? AND warehouse_id=? AND status='reserved' FOR UPDATE",
      { replacements: [data.item_id, data.warehouse_id], transaction },
    );
    const reserved = reservedRows.reduce(
      (total, row) => total + Number(row.quantity || 0),
      0,
    );
    if (reserved + quantity > onHand)
      return { error: 'INSUFFICIENT_AVAILABLE_STOCK', onHand, reserved };
    const id = uuid();
    await db.query(
      'INSERT INTO stock_reservations(id,item_id,warehouse_id,reference_type,reference_id,quantity,status,created_by) VALUES(?,?,?,?,?,?,?,?)',
      {
        replacements: [
          id,
          data.item_id,
          data.warehouse_id,
          data.reference_type || null,
          data.reference_id || null,
          quantity,
          'reserved',
          userId || null,
        ],
        transaction,
      },
    );
    await audit(
      db,
      userId,
      'inventory',
      'stock_reserved',
      'stock_reservations',
      id,
      { quantity },
      transaction,
    );
    return { id, status: 'reserved', quantity };
  });
}

async function changeReservation(db, id, action, userId) {
  if (!['released', 'consumed'].includes(action))
    return { error: 'VALIDATION_ERROR' };
  return db.transaction(async (transaction) => {
    const [rows] = await db.query(
      'SELECT * FROM stock_reservations WHERE id=? FOR UPDATE',
      { replacements: [id], transaction },
    );
    if (!rows[0]) return { error: 'NOT_FOUND' };
    if (rows[0].status !== 'reserved')
      return { id, status: rows[0].status, alreadyChanged: true };
    await db.query(
      'UPDATE stock_reservations SET status=? WHERE id=? AND status=?',
      { replacements: [action, id, 'reserved'], transaction },
    );
    await audit(
      db,
      userId,
      'inventory',
      `stock_${action}`,
      'stock_reservations',
      id,
      {},
      transaction,
    );
    return { id, status: action };
  });
}

async function reorderSuggestions(db) {
  const [rows] =
    await db.query(`SELECT i.id AS item_id,i.item_code,i.item_name,i.reorder_level,i.reorder_qty,
    COALESCE(SUM(s.current_qty),0) AS on_hand, GREATEST(i.reorder_level-COALESCE(SUM(s.current_qty),0),0) AS suggested_quantity
    FROM item_master i LEFT JOIN stock_summary s ON s.item_id=i.id WHERE i.is_active=1
    GROUP BY i.id,i.item_code,i.item_name,i.reorder_level,i.reorder_qty
    HAVING on_hand < i.reorder_level ORDER BY suggested_quantity DESC`);
  return rows;
}

async function rfqFromRequisition(db, requisitionId, userId) {
  return db.transaction(async (transaction) => {
    const query = (sql, replacements = []) =>
      db.query(sql, { replacements, transaction });
    const [[requisition]] = await query(
      'SELECT * FROM purchase_requisitions WHERE id=? FOR UPDATE',
      [requisitionId],
    );
    if (!requisition || requisition.status !== 'approved')
      throw Object.assign(
        new Error('Approve the requisition before sourcing'),
        { status: 409 },
      );
    const [[existing]] = await query(
      "SELECT target_id FROM related_documents WHERE source_type='purchase_requisition' AND source_id=? AND target_type='rfq' AND relation='sourcing'",
      [requisitionId],
    );
    if (existing) return { id: existing.target_id, already_created: true };
    const [items] = await query(
      'SELECT item_id,SUM(quantity) quantity FROM purchase_requisition_items WHERE requisition_id=? GROUP BY item_id',
      [requisitionId],
    );
    if (!items.length)
      throw Object.assign(new Error('Requisition requires items'), {
        status: 400,
      });
    const id = uuid(),
      number = `RFQ-${id}`;
    await query('INSERT INTO rfqs(id,rfq_number,requested_by) VALUES(?,?,?)', [
      id,
      number,
      userId,
    ]);
    for (const item of items)
      await query(
        'INSERT INTO rfq_items(id,rfq_id,item_id,quantity) VALUES(?,?,?,?)',
        [uuid(), id, item.item_id, item.quantity],
      );
    await query(
      "INSERT INTO related_documents(id,source_type,source_id,target_type,target_id,relation,created_by) VALUES(?,'purchase_requisition',?,'rfq',?,'sourcing',?)",
      [uuid(), requisitionId, id, userId],
    );
    return { id, rfq_number: number, status: 'draft' };
  });
}
async function orderFromRfq(db, rfqId, vendorId, warehouseId, userId) {
  return db.transaction(async (transaction) => {
    const query = (sql, replacements = []) =>
      db.query(sql, { replacements, transaction });
    const [[rfq]] = await query('SELECT * FROM rfqs WHERE id=? FOR UPDATE', [
      rfqId,
    ]);
    if (!rfq || rfq.status !== 'approved')
      throw Object.assign(
        new Error('Approve the selected RFQ before creating a PO'),
        { status: 409 },
      );
    const [[existing]] = await query(
      "SELECT po.id,po.po_number FROM related_documents rd JOIN purchase_orders po ON po.id=rd.target_id WHERE rd.source_type='rfq' AND rd.source_id=? AND rd.target_type='purchase_order' AND rd.relation='awarded' AND po.vendor_id=?",
      [rfqId, vendorId],
    );
    if (existing) return { ...existing, already_created: true };
    const [[vendor]] = await query(
      'SELECT id FROM vendors WHERE id=? AND is_active=1',
      [vendorId],
    );
    const [[warehouse]] = await query(
      'SELECT id FROM warehouses WHERE id=? AND is_active=1',
      [warehouseId],
    );
    if (!vendor || !warehouse)
      throw Object.assign(new Error('Choose an active vendor and warehouse'), {
        status: 400,
      });
    const [items] = await query(
      'SELECT q.* FROM rfq_quotation_lines q JOIN rfq_suppliers s ON s.id=q.rfq_supplier_id WHERE s.rfq_id=? AND s.supplier_id=? AND q.is_selected=1 ORDER BY q.item_id',
      [rfqId, vendorId],
    );
    if (!items.length)
      throw Object.assign(
        new Error('Select quotation lines for this vendor first'),
        { status: 400 },
      );
    const [[link]] = await query(
      "SELECT source_id FROM related_documents WHERE source_type='purchase_requisition' AND target_type='rfq' AND target_id=? AND relation='sourcing'",
      [rfqId],
    );
    const id = uuid(),
      number = `PO-${id}`;
    const total = items.reduce(
      (sum, item) =>
        sum +
        Number(item.quantity) *
          Number(item.unit_price) *
          (1 + Number(item.tax_rate || 0) / 100),
      0,
    );
    if (!Number.isFinite(total) || total < 0)
      throw Object.assign(new Error('Invalid supplier pricing'), {
        status: 400,
      });
    await query(
      "INSERT INTO purchase_orders(id,po_number,vendor_id,warehouse_id,requisition_id,status,total_amount,created_by) VALUES(?,?,?,?,?,'draft',?,?)",
      [
        id,
        number,
        vendorId,
        warehouseId,
        link?.source_id || null,
        total,
        userId,
      ],
    );
    for (const item of items)
      await query(
        'INSERT INTO purchase_order_items(id,order_id,item_id,quantity,rate,tax_percent) VALUES(?,?,?,?,?,?)',
        [
          uuid(),
          id,
          item.item_id,
          item.quantity,
          item.unit_price,
          item.tax_rate || 0,
        ],
      );
    await query(
      "INSERT INTO related_documents(id,source_type,source_id,target_type,target_id,relation,created_by) VALUES(?,'rfq',?,'purchase_order',?,'awarded',?)",
      [uuid(), rfqId, id, userId],
    );
    return { id, po_number: number, status: 'draft', total_amount: total };
  });
}

module.exports = {
  rfqFromRequisition,
  orderFromRfq,
  list,
  transition,
  postGrn,
  audit,
  transferTransitions,
  rfqTransitions,
  transitionTransfer: (db, id, next, userId) =>
    transitionEntity(
      db,
      'warehouse_transfers',
      id,
      next,
      userId,
      transferTransitions,
    ),
  transitionRfq: (db, id, next, userId) =>
    transitionEntity(db, 'rfqs', id, next, userId, rfqTransitions),
  receiveTransfer,
  reserveStock,
  changeReservation,
  reorderSuggestions,
};
