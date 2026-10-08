const { v4: uuid } = require('uuid');
const { resources, resolve } = require('../modules/fourModuleResources');
const { nextNumber } = require('./erp.service');
const { audit } = require('../modules/inventoryPurchase.service');
const fail = (message, status = 400) =>
  Object.assign(new Error(message), {
    status,
    code:
      status === 404
        ? 'NOT_FOUND'
        : status === 409
          ? 'CONFLICT'
          : 'VALIDATION_ERROR',
  });
const numeric = new Set([
  'quantity',
  'planned_qty',
  'output_qty',
  'rate',
  'standard_cost',
  'reorder_qty',
  'reorder_level',
  'gst_rate',
  'scrap_percent',
  'discount_percent',
  'tax_percent',
  'counted_qty',
  'payment_terms',
  'uom_id',
  'minutes',
  'amount',
  'taxable_amount',
  'cgst',
  'sgst',
  'igst',
  'unit_price',
  'tax_rate',
  'delivery_days',
  'sequence_no',
  'completed_qty',
  'rejected_qty',
]);
const positive = new Set([
  'quantity',
  'planned_qty',
  'output_qty',
  'amount',
  'minutes',
]);
const refs = {
  item_id: 'item_master',
  finished_item_id: 'item_master',
  vendor_id: 'vendors',
  customer_id: 'customers',
  warehouse_id: 'warehouses',
  from_warehouse_id: 'warehouses',
  to_warehouse_id: 'warehouses',
  uom_id: 'uom_master',
};
function definition(endpoint) {
  const def = resolve(endpoint);
  if (!def) throw fail('Unsupported resource', 404);
  return def;
}
function clean(fields, input, required = [], creating = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw fail('An object is required');
  const result = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!fields.includes(key)) throw fail(`Field ${key} cannot be changed`);
    let value = raw;
    if (
      numeric.has(key) &&
      !(raw === null && key === 'uom_id' && !required.includes(key))
    ) {
      if (
        raw === '' ||
        raw === null ||
        !['string', 'number'].includes(typeof raw)
      )
        throw fail(`Invalid ${key}`);
      value = Number(raw);
      if (
        !Number.isFinite(value) ||
        value < 0 ||
        (positive.has(key) && value <= 0) ||
        value > 999999999
      )
        throw fail(`Invalid ${key}`);
      if (
        ['planned_qty', 'output_qty', 'reorder_qty', 'reorder_level'].includes(
          key,
        ) &&
        value > 9999999.999
      )
        throw fail(`Invalid ${key}`);
      if (key.endsWith('_percent') || ['gst_rate', 'tax_rate'].includes(key)) {
        if (value > 100) throw fail(`${key} must be between 0 and 100`);
      }
      if (
        ['uom_id', 'minutes', 'payment_terms', 'delivery_days'].includes(key) &&
        !Number.isSafeInteger(value)
      )
        throw fail(`${key} must be an integer`);
      if (
        ['quantity', 'planned_qty', 'output_qty'].includes(key) &&
        Math.round(value * 1000) === 0
      )
        throw fail(`${key} is below the supported precision`);
    } else if (['is_active', 'is_default'].includes(key)) {
      if (![0, 1, '0', '1', true, false].includes(raw))
        throw fail(`Invalid ${key}`);
      value = Number(raw);
    } else if (value !== null) {
      if (typeof value !== 'string') throw fail(`Invalid ${key}`);
      value = value.trim();
      const limit = ['notes', 'reason', 'description', 'address'].includes(key)
        ? 5000
        : key.endsWith('_id')
          ? 36
          : 255;
      const lengths = {
        item_code: 50,
        item_name: 200,
        category: 30,
        uom_code: 20,
        uom_name: 100,
        hsn_code: 10,
        vendor_code: 50,
        customer_code: 50,
        company_name: 200,
        contact_person: 200,
        phone: 20,
        email: 200,
        gstin: 15,
        state: 100,
        warehouse_code: 50,
        warehouse_name: 200,
        process_name: 200,
        bom_code: 50,
        batch_no: 100,
        serial_no: 150,
        count_number: 50,
        production_number: 50,
        wo_number: 50,
        document_number: 60,
        stage_name: 100,
        pass_number: 50,
        pass_type: 20,
        code: 80,
        name: 150,
      };
      if (lengths[key] && value.length > lengths[key])
        throw fail(`${key} is too long`);
      if (value.length > limit) throw fail(`${key} is too long`);
      if (key.endsWith('_date') || key === 'expiry_date') {
        if (
          value &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
            Number.isNaN(Date.parse(value)) ||
            new Date(value).toISOString().slice(0, 10) !== value)
        )
          throw fail(`Invalid ${key}`);
        if (!value) value = null;
      }
      if (key === 'direction' && !['in', 'out'].includes(value))
        throw fail('Direction must be in or out');
      if (
        key === 'priority' &&
        !['low', 'normal', 'high', 'urgent'].includes(value)
      )
        throw fail('Invalid priority');
      if (key === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
        throw fail('Invalid email');
      if (value === '' && key.endsWith('_id')) value = null;
    }
    if (required.includes(key) && (value === null || value === ''))
      throw fail(`${key} is required`);
    result[key] = value;
  }
  if (creating)
    for (const key of required)
      if (
        result[key] === undefined ||
        result[key] === null ||
        result[key] === ''
      )
        throw fail(`${key} is required`);
  return result;
}
function inTransaction(req, work) {
  return req.transaction ? work(req.transaction) : req.orgDb.transaction(work);
}
async function query(db, tx, sql, replacements = []) {
  return db.query(sql, { replacements, transaction: tx });
}
async function load(db, def, id, tx, lock = false) {
  const [[record]] = await query(
    db,
    tx,
    `SELECT * FROM ${def.table} WHERE id=?${def.filter ? ` AND ${def.filter}` : ''}${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  if (!record) throw fail('Record not found', 404);
  return record;
}
async function references(db, tx, record, keys) {
  for (const key of keys)
    if (refs[key] && record[key]) {
      const [[found]] = await query(
        db,
        tx,
        `SELECT id FROM ${refs[key]} WHERE id=? AND is_active=1 FOR UPDATE`,
        [record[key]],
      );
      if (!found)
        throw fail(
          `Choose an active ${key.replace(/_id$/, '').replaceAll('_', ' ')}`,
        );
    }
}
const dependents = {
  purchase_requisitions: [['purchase_orders', 'requisition_id']],
  purchase_orders: [['grn', 'po_id']],
  grn: [['purchase_returns', 'grn_id']],
  rfqs: [
    ['supplier_quotations', 'rfq_id'],
    ['rfq_suppliers', 'rfq_id'],
  ],
  bom: [
    ['work_orders', 'bom_id'],
    ['production_orders', 'bom_id'],
  ],
  production_orders: [
    ['job_cards', 'production_order_id'],
    ['production_outputs', 'production_order_id'],
    ['production_scrap', 'production_order_id'],
    ['production_downtime', 'production_order_id'],
  ],
  work_orders: [
    ['material_issue_effects', 'work_order_id'],
    ['production_effects', 'work_order_id'],
    ['wo_routing_operations', 'wo_id'],
  ],
};
async function assertNoDependents(db, tx, def, id, editing = false) {
  for (const [table, column] of dependents[def.table] || []) {
    const [[row]] = await query(
      db,
      tx,
      `SELECT id FROM ${table} WHERE ${column}=? LIMIT 1 FOR UPDATE`,
      [id],
    );
    if (row)
      throw fail(
        `${editing ? 'Edit' : 'Delete'} is blocked by related documents`,
        409,
      );
  }
  const [[related]] = await query(
    db,
    tx,
    'SELECT id FROM related_documents WHERE source_id=? OR target_id=? LIMIT 1 FOR UPDATE',
    [id, id],
  );
  if (related) throw fail('Record is linked to another document', 409);
}
async function editable(db, tx, def, record) {
  if (def.recipe) return assertNoDependents(db, tx, def, record.id, true);
  if (def.batch) {
    if (Number(record.quantity) !== 0)
      throw fail('A batch with stock cannot be changed', 409);
    return;
  }
  if (def.master) return;
  if (!def.noStatus && !(def.states || []).includes(record.status))
    throw fail(`Record cannot be edited from ${record.status}`, 409);
  if (def.rfqSupplier || def.quoteLine || def.countLine) {
    await validateContext(db, tx, def, record, []);
    return;
  }
  if (def.effect) {
    const [[effect]] = await query(
      db,
      tx,
      'SELECT id FROM stock_effects WHERE operation_key=? OR (reference_type=? AND reference_id=?) LIMIT 1 FOR UPDATE',
      [
        `${def.effect}:${record.id}`,
        def.table === 'production_outputs'
          ? 'production_output'
          : 'production_scrap',
        record.id,
      ],
    );
    if (effect) throw fail('Posted stock movements cannot be edited', 409);
  }
  if (
    def.noStatus ||
    ['production_outputs', 'production_scrap', 'job_cards'].includes(def.table)
  ) {
    const [[order]] = await query(
      db,
      tx,
      'SELECT id,status FROM production_orders WHERE id=? FOR UPDATE',
      [record.production_order_id],
    );
    if (!order || ['completed', 'cancelled'].includes(order.status))
      throw fail('Parent production order is closed', 409);
  }
  if (['production_orders', 'work_orders'].includes(def.table))
    await assertNoDependents(db, tx, def, record.id, true);
  if (def.children) await assertNoDependents(db, tx, def, record.id, true);
}
async function validateContext(db, tx, def, record, changed) {
  await references(db, tx, record, changed);
  if (changed.includes('category') && record.category) {
    const [[category]] = await query(
      db,
      tx,
      'SELECT setting_value FROM company_settings WHERE setting_key=? FOR UPDATE',
      [`inventory.category.${record.category}`],
    );
    if (category && category.setting_value === '0')
      throw fail('Choose an active item group');
  }

  if (def.rfqSupplier || def.quoteLine) {
    let rfqId = record.rfq_id;
    if (def.quoteLine) {
      if (record.is_selected)
        throw fail('Selected quotes cannot be edited or deleted', 409);
      const [[supplier]] = await query(
        db,
        tx,
        'SELECT rfq_id FROM rfq_suppliers WHERE id=? FOR UPDATE',
        [record.rfq_supplier_id],
      );
      if (!supplier) throw fail('RFQ supplier not found', 404);
      rfqId = supplier.rfq_id;
    }
    const [[rfq]] = await query(
      db,
      tx,
      'SELECT status FROM rfqs WHERE id=? FOR UPDATE',
      [rfqId],
    );
    if (
      !rfq ||
      !(
        def.quoteLine ? ['requested', 'quoted'] : ['draft', 'requested']
      ).includes(rfq.status)
    )
      throw fail('RFQ no longer accepts changes', 409);
    if (def.rfqSupplier) {
      await references(db, tx, { vendor_id: record.supplier_id }, [
        'vendor_id',
      ]);
      const [[quote]] = await query(
        db,
        tx,
        'SELECT id FROM rfq_quotation_lines WHERE rfq_supplier_id=? LIMIT 1 FOR UPDATE',
        [record.id],
      );
      if (quote) throw fail('Supplier already has quote lines', 409);
    } else {
      const [[item]] = await query(
        db,
        tx,
        'SELECT quantity FROM rfq_items WHERE rfq_id=? AND item_id=?',
        [rfqId, record.item_id],
      );
      if (!item || Number(record.quantity) !== Number(item.quantity))
        throw fail('Quote quantity must match the requested RFQ quantity');
    }
  }
  if (def.countLine) {
    const [[count]] = await query(
      db,
      tx,
      'SELECT status FROM physical_counts WHERE id=? FOR UPDATE',
      [record.count_id],
    );
    if (!count || !['draft', 'open'].includes(count.status))
      throw fail('Only draft and open counts can be changed', 409);
  }

  if (
    changed.includes('item_type') &&
    ![
      'raw_material',
      'finished_good',
      'semi_finished',
      'consumable',
      'service',
    ].includes(record.item_type)
  )
    throw fail('Invalid item type');
  if (
    def.table === 'gate_pass' &&
    !['inward', 'outward', 'in', 'out'].includes(record.pass_type)
  )
    throw fail('Invalid gate pass type');
  if (def.recipe) {
    const [[multi]] = await query(
      db,
      tx,
      'SELECT id FROM bom_components WHERE bom_id=? AND parent_component_id IS NOT NULL LIMIT 1',
      [record.id],
    );
    if (multi)
      throw fail(
        'Use the BOM version workflow to modify a multi-level recipe',
        409,
      );
  }
  if (
    record.from_warehouse_id &&
    record.from_warehouse_id === record.to_warehouse_id
  )
    throw fail('Transfer warehouses must differ');
  if (
    def.tree &&
    changed.some((key) => ['parent_id', 'warehouse_id'].includes(key))
  ) {
    const seen = new Set([record.id]);
    let parent = record.parent_id;
    while (parent) {
      if (seen.has(parent))
        throw fail('Location hierarchy cannot contain a cycle');
      seen.add(parent);
      const [[row]] = await query(
        db,
        tx,
        'SELECT id,parent_id,warehouse_id,is_active FROM warehouse_locations WHERE id=? FOR UPDATE',
        [parent],
      );
      if (!row || !row.is_active || row.warehouse_id !== record.warehouse_id)
        throw fail('Parent location must belong to the same active warehouse');
      parent = row.parent_id;
    }
  }
  if (['production_orders', 'work_orders'].includes(def.table)) {
    const [[bom]] = await query(
      db,
      tx,
      'SELECT id,finished_item_id,is_active,output_qty FROM bom WHERE id=? FOR UPDATE',
      [record.bom_id],
    );
    if (
      !bom ||
      !bom.is_active ||
      bom.finished_item_id !== (record.item_id || record.finished_item_id) ||
      Number(bom.output_qty) <= 0
    )
      throw fail('Choose a matching active BOM');
    if (record.so_id) {
      const [[order]] = await query(
        db,
        tx,
        'SELECT id,status FROM sales_orders WHERE id=? FOR UPDATE',
        [record.so_id],
      );
      if (
        !order ||
        !['confirmed', 'partially_delivered'].includes(order.status)
      )
        throw fail('Choose a confirmed sales order');
    }
  }
  if (
    [
      'production_outputs',
      'production_scrap',
      'production_downtime',
      'job_cards',
    ].includes(def.table)
  ) {
    const [[order]] = await query(
      db,
      tx,
      'SELECT * FROM production_orders WHERE id=? FOR UPDATE',
      [record.production_order_id],
    );
    if (!order || !['released', 'in_progress'].includes(order.status))
      throw fail('Choose a released production order');
    if (
      def.table === 'production_outputs' &&
      (order.item_id !== record.item_id ||
        Number(record.quantity) > Number(order.planned_qty))
    )
      throw fail('Output must match the production item and planned quantity');
    if (def.table === 'job_cards' && record.operation_id) {
      const [[operation]] = await query(
        db,
        tx,
        "SELECT r.id FROM wo_routing_operations r JOIN related_documents d ON d.target_id=r.wo_id WHERE r.id=? AND d.source_id=? AND d.source_type='production_order' AND d.target_type='work_order' AND r.status IN ('pending','in_progress') FOR UPDATE",
        [record.operation_id, record.production_order_id],
      );
      if (!operation) throw fail('Choose an active routing operation');
    }
    if (
      def.table === 'job_cards' &&
      Number(record.planned_qty) > Number(order.planned_qty)
    )
      throw fail('Job-card quantity exceeds production plan');
  }
  if (record.batch_id) {
    const [[batch]] = await query(
      db,
      tx,
      'SELECT item_id,warehouse_id FROM stock_batches WHERE id=? FOR UPDATE',
      [record.batch_id],
    );
    if (
      !batch ||
      batch.item_id !== record.item_id ||
      batch.warehouse_id !== record.warehouse_id
    )
      throw fail('Batch must match item and warehouse');
  }
  if (def.reservation && changed.includes('quantity')) {
    const [[stock]] = await query(
      db,
      tx,
      'SELECT current_qty FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE',
      [record.item_id, record.warehouse_id],
    );
    const [others] = await query(
      db,
      tx,
      "SELECT id,quantity FROM stock_reservations WHERE item_id=? AND warehouse_id=? AND status='reserved' AND id<>? FOR UPDATE",
      [record.item_id, record.warehouse_id, record.id],
    );
    const reserved = others.reduce((n, r) => n + Number(r.quantity), 0);
    if (reserved + Number(record.quantity) > Number(stock?.current_qty || 0))
      throw fail('Insufficient unreserved stock', 409);
  }
}
function normalizeItems(def, items) {
  if (!Array.isArray(items) || !items.length || items.length > 500)
    throw fail('Supply between 1 and 500 items');
  return items.map((item) => {
    const input = { ...item };
    delete input.id;
    if (input.received_qty !== undefined) {
      input.quantity = input.received_qty;
      delete input.received_qty;
    }
    if (input.return_qty !== undefined) {
      input.quantity = input.return_qty;
      delete input.return_qty;
    }
    const cleaned = clean(
      def.children.fields,
      input,
      def.children.required,
      true,
    );
    if (item.id !== undefined) {
      if (typeof item.id !== 'string' || !item.id || item.id.length > 36)
        throw fail('Invalid line item id');
      cleaned.id = item.id;
    }
    if (def.children.fields.includes('rate') && cleaned.rate === undefined)
      cleaned.rate = 0;
    if (def.children.fields.includes('direction') && !cleaned.direction)
      throw fail('Adjustment item direction is required');
    return cleaned;
  });
}
async function validateItems(db, tx, def, record, items) {
  await references(db, tx, record, Object.keys(refs));
  if (
    def.table === 'grn' &&
    !record.po_id &&
    items.some((item) => item.po_item_id)
  )
    throw fail('PO is required for PO line references');
  if (def.table === 'grn' && record.po_id) {
    const [[po]] = await query(
      db,
      tx,
      'SELECT * FROM purchase_orders WHERE id=? FOR UPDATE',
      [record.po_id],
    );
    if (
      !po ||
      po.vendor_id !== record.vendor_id ||
      (po.warehouse_id && po.warehouse_id !== record.warehouse_id) ||
      !['approved', 'confirmed', 'part_received'].includes(po.status)
    )
      throw fail('Receipt must match an approved PO, vendor and warehouse');
    const pending = new Map();
    for (const item of items) {
      const [matches] = await query(
        db,
        tx,
        'SELECT id,quantity FROM purchase_order_items WHERE order_id=? AND item_id=?' +
          (item.po_item_id ? ' AND id=?' : ''),
        [po.id, item.item_id, ...(item.po_item_id ? [item.po_item_id] : [])],
      );
      if (matches.length !== 1)
        throw fail('Receipt requires an unambiguous PO item');
      const line = matches[0];
      item.po_item_id = line.id;
      const [[prior]] = await query(
        db,
        tx,
        "SELECT COALESCE(SUM(gi.quantity),0) quantity FROM grn_items gi JOIN grn g ON g.id=gi.grn_id WHERE gi.po_item_id=? AND g.id<>? AND g.status<>'cancelled'",
        [line.id, record.id],
      );
      pending.set(line.id, (pending.get(line.id) || 0) + Number(item.quantity));
      if (Number(prior.quantity) + pending.get(line.id) > Number(line.quantity))
        throw fail('Receipt exceeds ordered quantity', 409);
    }
  }
  if (def.table === 'purchase_returns') {
    const [[grn]] = await query(
      db,
      tx,
      "SELECT * FROM grn WHERE id=? AND status='posted' FOR UPDATE",
      [record.grn_id],
    );
    if (
      !grn ||
      grn.vendor_id !== record.vendor_id ||
      grn.warehouse_id !== record.warehouse_id
    )
      throw fail('Return must match a posted GRN, vendor and warehouse');
    const totals = new Map();
    for (const item of items)
      totals.set(
        item.item_id,
        (totals.get(item.item_id) || 0) + Number(item.quantity),
      );
    for (const [itemId, quantity] of totals) {
      const [[accepted]] = await query(
        db,
        tx,
        "SELECT COALESCE(SUM(accepted_qty),0) quantity FROM qc_inspections WHERE inspection_type='incoming' AND COALESCE(reference_id,source_id)=? AND item_id=? AND status IN ('processed','closed')",
        [grn.id, itemId],
      );
      const [[prior]] = await query(
        db,
        tx,
        "SELECT COALESCE(SUM(i.quantity),0) quantity FROM purchase_return_items i JOIN purchase_returns r ON r.id=i.return_id WHERE r.grn_id=? AND i.item_id=? AND r.id<>? AND r.status<>'cancelled'",
        [grn.id, itemId, record.id],
      );
      if (Number(prior.quantity) + quantity > Number(accepted.quantity))
        throw fail('Return exceeds QC-accepted quantity', 409);
    }
  }
  if (def.table === 'supplier_quotations') {
    const [[rfq]] = await query(
      db,
      tx,
      'SELECT id,status FROM rfqs WHERE id=? FOR UPDATE',
      [record.rfq_id],
    );
    if (!rfq || !['draft', 'requested', 'quoted'].includes(rfq.status))
      throw fail('RFQ is no longer editable', 409);
    const [requested] = await query(
      db,
      tx,
      'SELECT item_id,quantity FROM rfq_items WHERE rfq_id=?',
      [record.rfq_id],
    );
    const quantities = new Map(
      requested.map((row) => [row.item_id, Number(row.quantity)]),
    );
    const totals = new Map();
    for (const item of items)
      totals.set(
        item.item_id,
        (totals.get(item.item_id) || 0) + Number(item.quantity),
      );
    for (const [id, quantity] of totals)
      if (!quantities.has(id) || quantity > quantities.get(id))
        throw fail('Quotation items must match the RFQ');
  }
  if (
    ['rfqs', 'bom', 'physical_counts'].includes(def.table) &&
    new Set(items.map((i) => i.item_id)).size !== items.length
  )
    throw fail('Repeated items are not allowed');
  for (const item of items) {
    await references(db, tx, item, ['item_id']);
    if (def.recipe && item.item_id === record.finished_item_id)
      throw fail('A BOM cannot consume its own finished item');
    if (def.table === 'physical_counts') {
      const [[stock]] = await query(
        db,
        tx,
        'SELECT current_qty FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE',
        [item.item_id, record.warehouse_id],
      );
      item.system_qty = Number(stock?.current_qty || 0);
    }
  }
}
async function replaceItems(db, tx, def, record, items) {
  await validateItems(db, tx, def, record, items);
  const children = def.children;
  const [existing] = await query(
    db,
    tx,
    `SELECT * FROM ${children.table} WHERE ${children.foreignKey}=? FOR UPDATE`,
    [record.id],
  );
  const ids = new Set(existing.map((row) => row.id));
  const keep = new Set();
  for (const item of items) {
    if (item.id && (!ids.has(item.id) || keep.has(item.id)))
      throw fail('Invalid or repeated line item id');
    const { id: lineId, ...data } = item;
    const keys = Object.keys(data);
    if (lineId) {
      keep.add(lineId);
      await query(
        db,
        tx,
        `UPDATE ${children.table} SET ${keys.map((key) => `${key}=?`).join(',')} WHERE id=? AND ${children.foreignKey}=?`,
        [...Object.values(data), lineId, record.id],
      );
    } else
      await query(
        db,
        tx,
        `INSERT INTO ${children.table}(id,${children.foreignKey},${keys.join(',')}) VALUES(?,?,${keys.map(() => '?').join(',')})`,
        [uuid(), record.id, ...Object.values(data)],
      );
  }
  for (const line of existing)
    if (!keep.has(line.id))
      await query(
        db,
        tx,
        `DELETE FROM ${children.table} WHERE id=? AND ${children.foreignKey}=?`,
        [line.id, record.id],
      );
  if (
    ['purchase_orders', 'supplier_quotations', 'purchase_returns'].includes(
      def.table,
    )
  ) {
    const total = items.reduce(
      (n, i) =>
        n +
        i.quantity *
          Number(i.rate || 0) *
          (1 - Number(i.discount_percent || 0) / 100) *
          (1 + Number(i.tax_percent || 0) / 100),
      0,
    );
    await query(db, tx, `UPDATE ${def.table} SET total_amount=? WHERE id=?`, [
      Math.round(total * 100) / 100,
      record.id,
    ]);
  }
}
function settingKey(def, id) {
  const key = String(id).replace(`${def.module}.`, '');
  if (!def.settings.includes(key)) throw fail('Unsupported module setting');
  return `${def.module}.${key}`;
}
async function saveSetting(req, endpoint, id, body) {
  const def = definition(endpoint);
  const key = settingKey(def, id);
  const raw = key.split('.').at(-1);
  const data = clean(['setting_value'], body, ['setting_value'], true);
  const value = String(data.setting_value).trim();
  if (!value) throw fail('Setting value is required');
  if (
    raw.endsWith('_enabled') ||
    raw.startsWith('require_') ||
    raw === 'approval_required'
  )
    if (!['true', 'false', '1', '0'].includes(value))
      throw fail('Use true or false for this setting');
  if (
    [
      'default_return_days',
      'stock_count_frequency_days',
      'default_payment_terms',
    ].includes(raw)
  )
    if (
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < (raw === 'default_payment_terms' ? 0 : 1)
    )
      throw fail('Invalid number of days');
  if (
    [
      'scrap_tolerance_percent',
      'over_receipt_tolerance',
      'invoice_match_tolerance',
    ].includes(raw)
  )
    if (
      !Number.isFinite(Number(value)) ||
      Number(value) < 0 ||
      Number(value) > 100
    )
      throw fail('Tolerance must be between 0 and 100');
  return inTransaction(req, async (tx) => {
    if (raw === 'default_warehouse')
      await references(req.orgDb, tx, { warehouse_id: value }, [
        'warehouse_id',
      ]);
    await query(
      req.orgDb,
      tx,
      'INSERT INTO company_settings(setting_key,setting_value) VALUES(?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)',
      [key, value],
    );
    await audit(
      req.orgDb,
      req.user.sub,
      def.module,
      'setting.updated',
      'company_setting',
      key,
      { value },
      tx,
    );
    return { setting_key: key, setting_value: value };
  });
}
async function detail(req, endpoint, id) {
  const def = definition(endpoint);
  if (def.settings) {
    const key = settingKey(def, id);
    const [[row]] = await query(
      req.orgDb,
      null,
      'SELECT setting_key,setting_value,updated_at FROM company_settings WHERE setting_key=?',
      [key],
    );
    if (!row) throw fail('Setting not found', 404);
    return row;
  }
  if (def.category) {
    const [[setting]] = await query(
      req.orgDb,
      null,
      'SELECT setting_value FROM company_settings WHERE setting_key=?',
      [`inventory.category.${id}`],
    );
    const [[item]] = setting
      ? [[]]
      : await query(
          req.orgDb,
          null,
          'SELECT id FROM item_master WHERE category=? LIMIT 1',
          [id],
        );
    if (!setting && !item) throw fail('Category not found', 404);
    return {
      id,
      category: id,
      is_active: setting ? Number(setting.setting_value) : 1,
    };
  }
  const record = await load(req.orgDb, def, id);
  if (def.children) {
    const [items] = await query(
      req.orgDb,
      null,
      `SELECT * FROM ${def.children.table} WHERE ${def.children.foreignKey}=? ORDER BY id`,
      [id],
    );
    record.items = items;
  }
  if (def.bill) {
    const [[doc]] = await query(
      req.orgDb,
      null,
      'SELECT * FROM finance_documents WHERE id=?',
      [record.finance_document_id],
    );
    return { ...record, document: doc };
  }
  return record;
}
async function update(req, endpoint, id, body) {
  const def = definition(endpoint);
  if (def.settings) return saveSetting(req, endpoint, id, body);
  const input = { ...body };
  const rawItems = input.items ?? input.components;
  delete input.items;
  delete input.components;
  const data = clean(def.fields, input, def.required);
  if (!Object.keys(data).length && rawItems === undefined)
    throw fail('No editable fields supplied');
  if (rawItems !== undefined && !def.children)
    throw fail('This resource has no line items');
  const items = rawItems === undefined ? null : normalizeItems(def, rawItems);
  return inTransaction(req, async (tx) => {
    const record = await load(req.orgDb, def, id, tx, true);
    if (def.bill) {
      const financeDef = {
        ...resources['/purchase/vendor-invoices'],
        filter: null,
      };
      const invoice = await load(
        req.orgDb,
        financeDef,
        record.finance_document_id,
        tx,
        true,
      );
      await updateFinance(req, tx, financeDef, invoice, data);
    } else {
      await editable(req.orgDb, tx, def, record);
      if (def.finance) await updateFinance(req, tx, def, record, data);
      else {
        const merged = { ...record, ...data };
        await validateContext(req.orgDb, tx, def, merged, Object.keys(data));
        if (items) await replaceItems(req.orgDb, tx, def, merged, items);
        else if (
          def.children &&
          Object.keys(data).some((k) => k.endsWith('_id'))
        ) {
          const [existing] = await query(
            req.orgDb,
            tx,
            `SELECT * FROM ${def.children.table} WHERE ${def.children.foreignKey}=?`,
            [id],
          );
          const usable = existing.map((line) => ({
            id: line.id,
            ...Object.fromEntries(
              def.children.fields
                .filter((k) => line[k] !== undefined)
                .map((k) => [k, line[k]]),
            ),
          }));
          await replaceItems(
            req.orgDb,
            tx,
            def,
            merged,
            normalizeItems(def, usable),
          );
        }
        if (def.table === 'warehouses' && data.is_default === 1)
          await query(
            req.orgDb,
            tx,
            'UPDATE warehouses SET is_default=0 WHERE id<>?',
            [id],
          );
        if (Object.keys(data).length)
          await query(
            req.orgDb,
            tx,
            `UPDATE ${def.table} SET ${Object.keys(data)
              .map((k) => `${k}=?`)
              .join(',')} WHERE id=?`,
            [...Object.values(data), id],
          );
      }
    }
    await audit(
      req.orgDb,
      req.user.sub,
      def.module,
      'record.updated',
      def.table,
      id,
      { fields: Object.keys(data), items: items?.length },
      tx,
    );
    return { id, updated: true };
  });
}
async function updateFinance(req, tx, def, invoice, data) {
  if (
    !['open', 'matched'].includes(invoice.status) ||
    Number(invoice.paid_amount || 0) > 0
  )
    throw fail('Paid or cancelled invoices cannot be edited', 409);
  const [[journal]] = await query(
    req.orgDb,
    tx,
    "SELECT id FROM finance_journals WHERE source_type='vendor_invoice' AND source_id=? LIMIT 1 FOR UPDATE",
    [invoice.id],
  );
  if (
    journal &&
    Object.keys(data).some((k) => !['document_number', 'due_date'].includes(k))
  )
    throw fail(
      'Only invoice number and due date can change after accounting posting',
      409,
    );
  if (!journal) {
    const merged = { ...invoice, ...data };
    if (
      Math.round(
        (Number(merged.taxable_amount ?? merged.amount) +
          Number(merged.cgst || 0) +
          Number(merged.sgst || 0) +
          Number(merged.igst || 0)) *
          100,
      ) !== Math.round(Number(merged.amount) * 100)
    )
      throw fail('Tax values must equal invoice total');
    const partyKey =
      merged.document_type === 'payable' ? 'vendor_id' : 'customer_id';
    await references(req.orgDb, tx, { [partyKey]: merged.party_id }, [
      partyKey,
    ]);
  }
  await query(
    req.orgDb,
    tx,
    `UPDATE finance_documents SET ${Object.keys(data)
      .map((k) => `${k}=?`)
      .join(',')} WHERE id=?`,
    [...Object.values(data), invoice.id],
  );
}
async function create(req, endpoint, body) {
  const def = definition(endpoint);
  if (!def.create) throw fail('Use this resource creation workflow');
  const input = { ...body };
  const rawItems = input.items;
  delete input.items;
  if (input.idempotency_key !== undefined)
    throw fail('Use the existing creation workflow for idempotency keys');
  const data = clean(def.fields, input, def.required, true);
  const items = def.children ? normalizeItems(def, rawItems) : null;
  return inTransaction(req, async (tx) => {
    const id = uuid();
    const record = { id, ...data, status: def.initial || 'draft' };
    await validateContext(req.orgDb, tx, def, record, Object.keys(data));
    if (def.number && !record[def.number[0]])
      record[def.number[0]] = await nextNumber(
        req.orgDb,
        def.table,
        def.number[1],
        5,
        tx,
      );
    if (def.actor) record[def.actor] = req.user.sub;
    const keys = Object.keys(record);
    await query(
      req.orgDb,
      tx,
      `INSERT INTO ${def.table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
      Object.values(record),
    );
    if (items) await replaceItems(req.orgDb, tx, def, record, items);
    await audit(
      req.orgDb,
      req.user.sub,
      def.module,
      'record.created',
      def.table,
      id,
      { fields: Object.keys(data), items: items?.length },
      tx,
    );
    return record;
  });
}
async function remove(req, endpoint, id) {
  const def = definition(endpoint);
  if (def.settings)
    return inTransaction(req, async (tx) => {
      const key = settingKey(def, id);
      const [[row]] = await query(
        req.orgDb,
        tx,
        'SELECT setting_key FROM company_settings WHERE setting_key=? FOR UPDATE',
        [key],
      );
      if (!row) throw fail('Setting not found', 404);
      await query(
        req.orgDb,
        tx,
        'DELETE FROM company_settings WHERE setting_key=?',
        [key],
      );
      await audit(
        req.orgDb,
        req.user.sub,
        def.module,
        'setting.reset',
        'company_setting',
        key,
        {},
        tx,
      );
      return { setting_key: key, deleted: true };
    });
  if (def.remove) {
    const service = require('./operationalDomains.service');
    if (def.remove === 'order')
      return service.transitionJobWorkOrder(req, id, 'cancel');
    if (def.remove === 'consumption')
      return service.cancelJobWorkConsumption(req, id);
    return service.cancelJobWorkStockDocument(req, def.remove, id);
  }
  return inTransaction(req, async (tx) => {
    const record = await load(req.orgDb, def, id, tx, true);
    if (def.bill || def.finance) {
      const invoice = def.bill
        ? await load(
            req.orgDb,
            { table: 'finance_documents' },
            record.finance_document_id,
            tx,
            true,
          )
        : record;
      return cancelFinance(req, tx, def, invoice, id);
    }
    if (def.reservation) {
      if (record.status === 'consumed')
        throw fail('Consumed reservations cannot be deleted', 409);
      await query(
        req.orgDb,
        tx,
        "UPDATE stock_reservations SET status='released' WHERE id=?",
        [id],
      );
    } else if (def.master || def.recipe) {
      await query(
        req.orgDb,
        tx,
        `UPDATE ${def.table} SET is_active=0 WHERE id=?`,
        [id],
      );
    } else {
      await editable(req.orgDb, tx, def, record);
      await assertNoDependents(req.orgDb, tx, def, id);
      if (def.serial || def.batch) {
        const [[used]] = await query(
          req.orgDb,
          tx,
          'SELECT id FROM stock_ledger WHERE notes LIKE ? LIMIT 1',
          [`%${id}%`],
        );
        if (used) throw fail('Serial movement history must be preserved', 409);
      }
      if (def.children)
        await query(
          req.orgDb,
          tx,
          `DELETE FROM ${def.children.table} WHERE ${def.children.foreignKey}=?`,
          [id],
        );
      await query(req.orgDb, tx, `DELETE FROM ${def.table} WHERE id=?`, [id]);
    }
    await audit(
      req.orgDb,
      req.user.sub,
      def.module,
      'record.deleted',
      def.table,
      id,
      { logical_delete: Boolean(def.master || def.recipe || def.reservation) },
      tx,
    );
    return {
      id,
      deleted: true,
      ...(def.master || def.recipe ? { is_active: 0 } : {}),
    };
  });
}
async function cancelFinance(req, tx, def, invoice, id) {
  if (invoice.status === 'cancelled')
    return { id, status: 'cancelled', already_cancelled: true };
  if (Number(invoice.paid_amount || 0) > 0)
    throw fail('Reverse vendor payments before cancelling the invoice', 409);

  const [[journal]] = await query(
    req.orgDb,
    tx,
    "SELECT id,status FROM finance_journals WHERE source_type='vendor_invoice' AND source_id=? FOR UPDATE",
    [invoice.id],
  );
  if (journal?.status === 'posted')
    await require('./operationalDomains.service').reverseJournal(
      { ...req, transaction: tx },
      journal.id,
    );
  const [taxes] = await query(
    req.orgDb,
    tx,
    "SELECT e.* FROM gst_ledger_entries e JOIN gst_context_snapshots s ON s.id=e.snapshot_id WHERE s.source_type='vendor_invoice' AND s.source_id=?",
    [invoice.id],
  );
  if (taxes.length) {
    const snapshot = uuid();
    await query(
      req.orgDb,
      tx,
      'INSERT INTO gst_context_snapshots(id,source_type,source_id,context,calculation) VALUES(?,?,?,?,?)',
      [
        snapshot,
        'vendor_invoice_reversal',
        invoice.id,
        JSON.stringify({ invoice_id: invoice.id }),
        '{}',
      ],
    );
    for (const tax of taxes)
      await query(
        req.orgDb,
        tx,
        'INSERT INTO gst_ledger_entries(id,snapshot_id,tax_type,amount,direction) VALUES(?,?,?,?,?)',
        [
          uuid(),
          snapshot,
          tax.tax_type,
          tax.amount,
          tax.direction === 'debit' ? 'credit' : 'debit',
        ],
      );
  }
  await query(
    req.orgDb,
    tx,
    "UPDATE finance_documents SET status='cancelled' WHERE id=?",
    [invoice.id],
  );
  await audit(
    req.orgDb,
    req.user.sub,
    def.module,
    'invoice.cancelled',
    'finance_documents',
    invoice.id,
    {},
    tx,
  );
  return { id, status: 'cancelled' };
}
function capabilities(endpoint) {
  const def = definition(endpoint);
  return {
    endpoint,
    module: def.module,
    fields: def.fields.map((key) => ({
      key,
      label: key.replaceAll('_', ' '),
      type: numeric.has(key)
        ? 'number'
        : key.endsWith('_date') || key === 'expiry_date'
          ? 'date'
          : 'text',
      required: def.required.includes(key),
    })),
    states:
      def.master || def.recipe || def.batch || def.noStatus ? null : def.states,
    children: def.children
      ? {
          fields: def.children.fields.map((key) => ({
            key,
            label: key.replaceAll('_', ' '),
            type: numeric.has(key) ? 'number' : 'text',
            required: def.children.required.includes(key),
          })),
        }
      : null,
    deleteLabel: def.settings
      ? 'Reset'
      : def.master || def.recipe
        ? 'Deactivate'
        : def.remove || def.finance || def.bill
          ? 'Cancel'
          : 'Delete',
  };
}
module.exports = {
  definition,
  clean,
  normalizeItems,
  detail,
  update,
  create,
  remove,
  capabilities,
  fail,
};

async function mutateLine(req, endpoint, id, lineId, method, body) {
  const def = definition(endpoint);
  if (!def.children) throw fail('This resource has no line items', 404);
  return inTransaction(req, async (transaction) => {
    const record = await load(req.orgDb, def, id, transaction, true);
    await editable(req.orgDb, transaction, def, record);
    const [existing] = await query(
      req.orgDb,
      transaction,
      `SELECT * FROM ${def.children.table} WHERE ${def.children.foreignKey}=? FOR UPDATE`,
      [id],
    );
    let items = existing.map((line) => ({
      id: line.id,
      ...Object.fromEntries(
        def.children.fields
          .filter((k) => line[k] !== undefined)
          .map((k) => [k, line[k]]),
      ),
    }));
    if (method === 'POST')
      items.push(clean(def.children.fields, body, def.children.required, true));
    else {
      const index = items.findIndex((line) => line.id === lineId);
      if (index < 0) throw fail('Line item not found', 404);
      if (method === 'DELETE') items.splice(index, 1);
      else
        items[index] = {
          ...items[index],
          ...clean(def.children.fields, body, def.children.required),
        };
    }
    return update({ ...req, transaction }, endpoint, id, { items });
  });
}
module.exports.mutateLine = mutateLine;

module.exports.saveSetting = saveSetting;
