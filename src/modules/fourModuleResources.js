// Explicit tenant-scoped resources. Derived stock, ledgers, reports and PPC
// deliberately have no arbitrary data-mutation route.
const master = (module, table, fields, required, extra = {}) => ({
  module,
  table,
  fields,
  required,
  master: true,
  ...extra,
});
const document = (module, table, fields, required, extra = {}) => ({
  module,
  table,
  fields,
  required,
  states: ['draft'],
  ...extra,
});
const lines = (
  table,
  foreignKey,
  fields,
  required = ['item_id', 'quantity'],
) => ({ table, foreignKey, fields, required });
const partyFields = [
  'company_name',
  'contact_person',
  'phone',
  'email',
  'gstin',
  'state',
  'address',
  'payment_terms',
];
const resources = {
  '/inventory/categories': master(
    'inventory',
    'company_settings',
    ['category', 'is_active'],
    ['category'],
    { category: true },
  ),
  '/closure/rfq/suppliers': document(
    'purchase',
    'rfq_suppliers',
    ['supplier_id'],
    ['supplier_id'],
    { states: ['invited'], rfqSupplier: true },
  ),
  '/closure/rfq/quotation-lines': document(
    'purchase',
    'rfq_quotation_lines',
    ['quantity', 'unit_price', 'tax_rate', 'delivery_days'],
    ['quantity', 'unit_price'],
    { noStatus: true, quoteLine: true },
  ),
  '/closure/physical-counts/lines': document(
    'inventory',
    'physical_count_lines',
    ['counted_qty'],
    ['counted_qty'],
    { noStatus: true, countLine: true },
  ),

  '/inventory/items': master(
    'inventory',
    'item_master',
    [
      'item_code',
      'item_name',
      'item_type',
      'category',
      'uom_id',
      'hsn_code',
      'gst_rate',
      'reorder_level',
      'reorder_qty',
      'standard_cost',
      'description',
      'is_active',
    ],
    ['item_code', 'item_name'],
  ),
  '/inventory/warehouses': master(
    'inventory',
    'warehouses',
    ['warehouse_code', 'warehouse_name', 'address', 'is_default', 'is_active'],
    ['warehouse_code', 'warehouse_name'],
  ),
  '/inventory/uom': master(
    'inventory',
    'uom_master',
    ['uom_code', 'uom_name', 'is_active'],
    ['uom_code', 'uom_name'],
  ),
  '/purchase/vendors': master(
    'purchase',
    'vendors',
    ['vendor_code', ...partyFields, 'vendor_type', 'is_active'],
    ['company_name'],
    { create: true },
  ),
  '/jobwork/vendors': master(
    'jobwork',
    'vendors',
    ['vendor_code', ...partyFields, 'vendor_type', 'is_active'],
    ['company_name'],
  ),
  '/jobwork/customers': master(
    'jobwork',
    'customers',
    ['customer_code', ...partyFields, 'is_active'],
    ['company_name'],
  ),
  '/purchase/requisitions': document(
    'purchase',
    'purchase_requisitions',
    [
      'department',
      'warehouse_id',
      'required_date',
      'priority',
      'reason',
      'notes',
    ],
    [],
    {
      states: ['draft', 'pending'],
      number: ['pr_number', 'PR-'],
      actor: 'requested_by',

      children: lines('purchase_requisition_items', 'requisition_id', [
        'item_id',
        'quantity',
        'rate',
        'notes',
      ]),
    },
  ),
  '/purchase/orders': document(
    'purchase',
    'purchase_orders',
    ['vendor_id', 'warehouse_id', 'delivery_date', 'payment_terms', 'notes'],
    ['vendor_id', 'warehouse_id'],
    {
      number: ['po_number', 'PO-'],
      actor: 'created_by',

      children: lines('purchase_order_items', 'order_id', [
        'item_id',
        'quantity',
        'rate',
        'discount_percent',
        'tax_percent',
      ]),
    },
  ),
  '/purchase/grn': document(
    'purchase',
    'grn',
    ['po_id', 'vendor_id', 'warehouse_id', 'received_date', 'notes'],
    ['vendor_id', 'warehouse_id'],
    {
      number: ['grn_number', 'GRN-'],

      children: lines('grn_items', 'grn_id', [
        'po_item_id',
        'item_id',
        'quantity',
        'rate',
      ]),
    },
  ),
  '/purchase/returns': document(
    'purchase',
    'purchase_returns',
    ['vendor_id', 'grn_id', 'warehouse_id', 'reason', 'notes'],
    ['vendor_id', 'grn_id', 'warehouse_id'],
    {
      number: ['return_number', 'PRET-'],

      children: lines('purchase_return_items', 'return_id', [
        'item_id',
        'quantity',
        'rate',
      ]),
    },
  ),
  '/purchase/rfqs': document('purchase', 'rfqs', [], [], {
    number: ['rfq_number', 'RFQ-'],
    actor: 'requested_by',
    children: lines('rfq_items', 'rfq_id', ['item_id', 'quantity']),
  }),
  '/purchase/supplier-quotations': document(
    'purchase',
    'supplier_quotations',
    ['rfq_id', 'vendor_id'],
    ['rfq_id', 'vendor_id'],
    {
      children: lines('supplier_quotation_items', 'quotation_id', [
        'item_id',
        'quantity',
        'rate',
      ]),
    },
  ),
  '/purchase/vendor-invoices': document(
    'purchase',
    'finance_documents',
    [
      'document_number',
      'document_date',
      'due_date',
      'party_id',
      'amount',
      'taxable_amount',
      'cgst',
      'sgst',
      'igst',
    ],
    ['document_number', 'document_date', 'party_id', 'amount'],
    { states: ['open'], filter: "document_type='payable'", finance: true },
  ),
  '/inventory/transfers': document(
    'inventory',
    'warehouse_transfers',
    ['from_warehouse_id', 'to_warehouse_id', 'notes'],
    ['from_warehouse_id', 'to_warehouse_id'],
    {
      number: ['transfer_number', 'TR-'],
      actor: 'requested_by',
      children: lines('warehouse_transfer_items', 'transfer_id', [
        'item_id',
        'quantity',
      ]),
    },
  ),
  '/inventory/adjustments': document(
    'inventory',
    'stock_adjustments',
    ['warehouse_id', 'reason'],
    ['warehouse_id', 'reason'],
    {
      number: ['adjustment_number', 'ADJ-'],
      actor: 'created_by',
      children: lines('stock_adjustment_items', 'adjustment_id', [
        'item_id',
        'quantity',
        'rate',
        'direction',
      ]),
    },
  ),
  '/inventory/reservations': document(
    'inventory',
    'stock_reservations',
    ['quantity', 'reference_type', 'reference_id'],
    ['quantity'],
    { states: ['reserved'], reservation: true },
  ),
  '/inventory/gate-pass': document(
    'inventory',
    'gate_pass',
    ['pass_number', 'pass_type', 'item_id', 'warehouse_id', 'quantity'],
    ['pass_number', 'pass_type', 'item_id', 'warehouse_id', 'quantity'],
    { states: ['open'], initial: 'open', create: true },
  ),
  '/inventory/batches': document(
    'inventory',
    'stock_batches',
    ['batch_no', 'expiry_date'],
    ['batch_no'],
    { batch: true },
  ),
  '/inventory/serials': document(
    'inventory',
    'stock_serials',
    ['serial_no'],
    ['serial_no'],
    { states: ['available'], serial: true },
  ),
  '/inventory/locations': master(
    'inventory',
    'warehouse_locations',
    ['code', 'name', 'warehouse_id', 'parent_id', 'is_active'],
    ['code', 'name', 'warehouse_id'],
    { tree: true },
  ),
  '/inventory/counts': document(
    'inventory',
    'physical_counts',
    ['count_number', 'warehouse_id'],
    ['count_number', 'warehouse_id'],
    {
      states: ['draft', 'open'],
      children: lines(
        'physical_count_lines',
        'count_id',
        ['item_id', 'counted_qty'],
        ['item_id', 'counted_qty'],
      ),
    },
  ),
  '/production/bom': document(
    'production',
    'bom',
    ['bom_code', 'finished_item_id', 'output_qty'],
    ['bom_code', 'finished_item_id', 'output_qty'],
    {
      recipe: true,
      children: lines('bom_components', 'bom_id', [
        'item_id',
        'quantity',
        'scrap_percent',
        'rate',
      ]),
    },
  ),
  '/production/orders': document(
    'production',
    'production_orders',
    ['production_number', 'bom_id', 'item_id', 'planned_qty', 'so_id'],
    ['bom_id', 'item_id', 'planned_qty'],
    {
      number: ['production_number', 'PROD-'],
      actor: 'created_by',
    },
  ),
  '/production/work-orders': document(
    'production',
    'work_orders',
    ['wo_number', 'bom_id', 'finished_item_id', 'planned_qty', 'so_id'],
    ['bom_id', 'finished_item_id', 'planned_qty'],
    { number: ['wo_number', 'WO-'] },
  ),
  '/production/job-cards': document(
    'production',
    'job_cards',
    ['production_order_id', 'operation_id', 'planned_qty'],
    ['production_order_id', 'planned_qty'],
    { states: ['queued'], create: true, initial: 'queued' },
  ),
  '/production/output': document(
    'production',
    'production_outputs',
    ['production_order_id', 'item_id', 'quantity', 'warehouse_id', 'batch_id'],
    ['production_order_id', 'item_id', 'quantity', 'warehouse_id'],
    { effect: 'production-output' },
  ),
  '/production/scrap': document(
    'production',
    'production_scrap',
    ['production_order_id', 'item_id', 'quantity', 'warehouse_id', 'reason'],
    ['production_order_id', 'item_id', 'quantity', 'warehouse_id'],
    { effect: 'production-scrap' },
  ),
  '/production/downtime': document(
    'production',
    'production_downtime',
    ['production_order_id', 'minutes', 'reason'],
    ['production_order_id', 'minutes', 'reason'],
    { noStatus: true },
  ),
  '/jobwork/orders': document(
    'jobwork',
    'job_work_orders',
    ['process_name', 'expected_return_date', 'notes', 'rate'],
    ['process_name'],
    { remove: 'order' },
  ),
  '/jobwork/challans': document('jobwork', 'job_work_challans', ['notes'], [], {
    states: ['posted', 'completed'],
    remove: 'challan',
  }),
  '/jobwork/receipts': document('jobwork', 'job_work_receipts', ['notes'], [], {
    states: ['posted'],
    remove: 'receipt',
  }),
  '/jobwork/consumption': document(
    'jobwork',
    'job_work_consumptions',
    ['notes'],
    [],
    { states: ['posted'], remove: 'consumption' },
  ),
  '/jobwork/finished-goods': document(
    'jobwork',
    'job_work_finished_goods_receipts',
    ['receipt_date'],
    [],
    { states: ['posted'], remove: 'finished' },
  ),
  '/jobwork/billing': document(
    'jobwork',
    'job_work_bills',
    ['document_date', 'due_date', 'document_number'],
    [],
    { bill: true, states: ['open', 'matched'] },
  ),
};
for (const [module, keys] of Object.entries({
  inventory: [
    'default_warehouse',
    'stock_count_frequency_days',
    'batch_tracking_enabled',
    'serial_tracking_enabled',
  ],
  production: [
    'default_warehouse',
    'require_material_issue',
    'scrap_tolerance_percent',
  ],
  purchase: [
    'approval_required',
    'over_receipt_tolerance',
    'invoice_match_tolerance',
    'default_payment_terms',
  ],
  jobwork: ['default_warehouse', 'require_inward_qc', 'default_return_days'],
}))
  resources[`/${module}/settings`] = master(
    module,
    'company_settings',
    ['setting_value'],
    ['setting_value'],
    { settings: keys },
  );
const aliases = {
  '/vendors': '/purchase/vendors',
  '/purchase/receipts': '/purchase/grn',
  '/purchase/invoices': '/purchase/vendor-invoices',
  '/closure/batches': '/inventory/batches',
  '/closure/serials': '/inventory/serials',
  '/closure/warehouse-locations': '/inventory/locations',
  '/closure/physical-counts': '/inventory/counts',
  '/closure/production-outputs': '/production/output',
  '/closure/production-scrap': '/production/scrap',
  '/closure/production-downtime': '/production/downtime',
};
function resolve(endpoint) {
  return resources[aliases[endpoint] || endpoint];
}
module.exports = { resources, aliases, resolve };
