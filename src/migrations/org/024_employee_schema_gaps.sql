-- Fix employee schema gaps: add missing columns that 014_next_domains.sql
-- tried to create via CREATE TABLE IF NOT EXISTS (skipped because table exists).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS email VARCHAR(200) NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS designation VARCHAR(100) NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS joining_date DATE NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'active';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS salary DECIMAL(14,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS salary_type VARCHAR(30) DEFAULT 'monthly';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS mobile VARCHAR(20) NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS address TEXT NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_contact VARCHAR(200) NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_type VARCHAR(40) DEFAULT 'permanent';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS manager_id VARCHAR(36) NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Fix warehouses: ensure warehouse_name exists (it does in 001_init.sql but guard anyway)
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS city VARCHAR(100) NULL;
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS manager_id VARCHAR(36) NULL;

-- Fix item_master: add missing columns
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS item_type VARCHAR(30) DEFAULT 'product';
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS brand VARCHAR(100) NULL;
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS weight DECIMAL(10,3) NULL;
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS weight_uom VARCHAR(20) NULL;
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS shelf_life_days INT NULL;
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS min_order_qty DECIMAL(10,3) DEFAULT 0;
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS max_stock_level DECIMAL(10,3) DEFAULT 0;
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS opening_stock DECIMAL(10,3) DEFAULT 0;
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS opening_rate DECIMAL(12,2) DEFAULT 0;

-- Fix vendors: add missing columns
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS bank_account VARCHAR(100) NULL;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS bank_ifsc VARCHAR(20) NULL;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS credit_limit DECIMAL(14,2) DEFAULT 0;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Fix customers: add missing columns
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_limit DECIMAL(14,2) DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS discount_percent DECIMAL(5,2) DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Fix purchase_requisitions: add missing columns
ALTER TABLE purchase_requisitions ADD COLUMN IF NOT EXISTS required_by DATE NULL;
ALTER TABLE purchase_requisitions ADD COLUMN IF NOT EXISTS department VARCHAR(100) NULL;
ALTER TABLE purchase_requisitions ADD COLUMN IF NOT EXISTS approved_by VARCHAR(36) NULL;
ALTER TABLE purchase_requisitions ADD COLUMN IF NOT EXISTS approved_at DATETIME NULL;
ALTER TABLE purchase_requisitions ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Fix purchase_orders: add missing columns
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS requisition_id VARCHAR(36) NULL;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS expected_delivery DATE NULL;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS approved_by VARCHAR(36) NULL;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS approved_at DATETIME NULL;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS terms TEXT NULL;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Fix grn: add missing columns
ALTER TABLE grn ADD COLUMN IF NOT EXISTS warehouse_id VARCHAR(36) NULL;
ALTER TABLE grn ADD COLUMN IF NOT EXISTS notes TEXT NULL;
ALTER TABLE grn ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Fix quotations: add missing columns
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS valid_until DATE NULL;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS notes TEXT NULL;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS created_by VARCHAR(36) NULL;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Fix sales_orders: add missing columns
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS delivery_date DATE NULL;
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS notes TEXT NULL;
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS created_by VARCHAR(36) NULL;
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Fix invoices: add missing columns
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_date DATE NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sales_order_id VARCHAR(36) NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes TEXT NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_by VARCHAR(36) NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Fix work_orders: add missing columns
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS start_date DATE NULL;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS end_date DATE NULL;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS warehouse_id VARCHAR(36) NULL;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS notes TEXT NULL;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS created_by VARCHAR(36) NULL;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Fix bom: add missing columns
ALTER TABLE bom ADD COLUMN IF NOT EXISTS version_no INT DEFAULT 1;
ALTER TABLE bom ADD COLUMN IF NOT EXISTS notes TEXT NULL;
ALTER TABLE bom ADD COLUMN IF NOT EXISTS created_by VARCHAR(36) NULL;
ALTER TABLE bom ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Fix qc_inspections: add missing columns (014 creates new table, but 001 table may exist)
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS inspection_number VARCHAR(60) NULL;
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS source_type VARCHAR(40) NULL;
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS source_id VARCHAR(36) NULL;
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS inspected_by VARCHAR(36) NULL;
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'pending';
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS result VARCHAR(30) NULL;
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS notes TEXT NULL;
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS inspected_at DATETIME NULL;
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Fix payroll_runs: add missing columns
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS period_start DATE NULL;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS period_end DATE NULL;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS run_number VARCHAR(60) NULL;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS processed_by VARCHAR(36) NULL;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS approved_by VARCHAR(36) NULL;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS approved_at DATETIME NULL;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Fix payroll_items: add missing columns
ALTER TABLE payroll_items ADD COLUMN IF NOT EXISTS gross_amount DECIMAL(14,2) DEFAULT 0;
ALTER TABLE payroll_items ADD COLUMN IF NOT EXISTS deductions DECIMAL(14,2) DEFAULT 0;
ALTER TABLE payroll_items ADD COLUMN IF NOT EXISTS net_amount DECIMAL(14,2) DEFAULT 0;

-- Fix leave_requests: add missing columns
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS leave_type VARCHAR(40) DEFAULT 'annual';
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS reason TEXT NULL;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS approved_by VARCHAR(36) NULL;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS approved_at DATETIME NULL;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(500) NULL;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Fix attendance: add missing columns
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_in TIME NULL;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_out TIME NULL;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS work_hours DECIMAL(5,2) DEFAULT 0;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS marked_by VARCHAR(36) NULL;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS notes VARCHAR(500) NULL;

-- Fix delivery_challans: add missing columns
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS sales_order_id VARCHAR(36) NULL;
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'draft';
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS warehouse_id VARCHAR(36) NULL;
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS notes TEXT NULL;
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS created_by VARCHAR(36) NULL;
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Fix job_work_orders: add missing columns
ALTER TABLE job_work_orders ADD COLUMN IF NOT EXISTS item_id VARCHAR(36) NULL;
ALTER TABLE job_work_orders ADD COLUMN IF NOT EXISTS quantity DECIMAL(10,3) DEFAULT 0;
ALTER TABLE job_work_orders ADD COLUMN IF NOT EXISTS dispatch_date DATE NULL;
ALTER TABLE job_work_orders ADD COLUMN IF NOT EXISTS return_date DATE NULL;
ALTER TABLE job_work_orders ADD COLUMN IF NOT EXISTS notes TEXT NULL;
ALTER TABLE job_work_orders ADD COLUMN IF NOT EXISTS created_by VARCHAR(36) NULL;
ALTER TABLE job_work_orders ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Add purchase_requisition_items if missing
CREATE TABLE IF NOT EXISTS purchase_requisition_items (
  id VARCHAR(36) PRIMARY KEY,
  requisition_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(10,3) NOT NULL DEFAULT 1,
  rate DECIMAL(12,2) DEFAULT 0,
  notes TEXT,
  INDEX idx_pr_items_req(requisition_id)
);

-- Add purchase_order_items if missing
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id VARCHAR(36) PRIMARY KEY,
  po_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(10,3) NOT NULL DEFAULT 1,
  rate DECIMAL(12,2) DEFAULT 0,
  received_qty DECIMAL(10,3) DEFAULT 0,
  tax_percent DECIMAL(5,2) DEFAULT 0,
  INDEX idx_po_items_po(po_id)
);

-- Add grn_items if missing
CREATE TABLE IF NOT EXISTS grn_items (
  id VARCHAR(36) PRIMARY KEY,
  grn_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  po_item_id VARCHAR(36) NULL,
  quantity DECIMAL(10,3) NOT NULL DEFAULT 1,
  rate DECIMAL(12,2) DEFAULT 0,
  INDEX idx_grn_items_grn(grn_id)
);

-- Add quotation_items if missing
CREATE TABLE IF NOT EXISTS quotation_items (
  id VARCHAR(36) PRIMARY KEY,
  quotation_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(10,3) NOT NULL DEFAULT 1,
  rate DECIMAL(12,2) DEFAULT 0,
  discount_percent DECIMAL(5,2) DEFAULT 0,
  gst_rate DECIMAL(5,2) DEFAULT 18,
  amount DECIMAL(12,2) DEFAULT 0,
  INDEX idx_quotation_items_q(quotation_id)
);

-- Add sales_order_items if missing
CREATE TABLE IF NOT EXISTS sales_order_items (
  id VARCHAR(36) PRIMARY KEY,
  so_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(10,3) NOT NULL DEFAULT 1,
  rate DECIMAL(12,2) DEFAULT 0,
  delivered_qty DECIMAL(10,3) DEFAULT 0,
  discount_percent DECIMAL(5,2) DEFAULT 0,
  gst_rate DECIMAL(5,2) DEFAULT 18,
  amount DECIMAL(12,2) DEFAULT 0,
  INDEX idx_so_items_so(so_id)
);

-- Add invoice_items if missing
CREATE TABLE IF NOT EXISTS invoice_items (
  id VARCHAR(36) PRIMARY KEY,
  invoice_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NULL,
  description VARCHAR(500) NULL,
  quantity DECIMAL(10,3) NOT NULL DEFAULT 1,
  rate DECIMAL(12,2) DEFAULT 0,
  discount_percent DECIMAL(5,2) DEFAULT 0,
  gst_rate DECIMAL(5,2) DEFAULT 18,
  taxable DECIMAL(12,2) DEFAULT 0,
  cgst DECIMAL(12,2) DEFAULT 0,
  sgst DECIMAL(12,2) DEFAULT 0,
  igst DECIMAL(12,2) DEFAULT 0,
  total DECIMAL(12,2) DEFAULT 0,
  INDEX idx_invoice_items_inv(invoice_id)
);

-- Add invoice_payments if missing
CREATE TABLE IF NOT EXISTS invoice_payments (
  id VARCHAR(36) PRIMARY KEY,
  invoice_id VARCHAR(36) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  method VARCHAR(30) DEFAULT 'bank',
  reference VARCHAR(100) NULL,
  payment_date DATE DEFAULT (CURDATE()),
  created_by VARCHAR(36) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_invoice_payments_inv(invoice_id)
);

-- Add bom_components if missing
CREATE TABLE IF NOT EXISTS bom_components (
  id VARCHAR(36) PRIMARY KEY,
  bom_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(10,3) NOT NULL DEFAULT 1,
  scrap_percent DECIMAL(5,2) DEFAULT 0,
  rate DECIMAL(12,2) DEFAULT 0,
  INDEX idx_bom_components_bom(bom_id),
  CONSTRAINT fk_bom_components_bom FOREIGN KEY (bom_id) REFERENCES bom(id) ON DELETE CASCADE
);

-- Add wo_routing_operations if missing
CREATE TABLE IF NOT EXISTS wo_routing_operations (
  id VARCHAR(36) PRIMARY KEY,
  work_order_id VARCHAR(36) NOT NULL,
  sequence_no INT DEFAULT 1,
  operation_name VARCHAR(200) NOT NULL,
  work_center VARCHAR(100) NULL,
  machine_id VARCHAR(36) NULL,
  operator_id VARCHAR(36) NULL,
  planned_start DATETIME NULL,
  planned_end DATETIME NULL,
  actual_start DATETIME NULL,
  actual_end DATETIME NULL,
  status VARCHAR(30) DEFAULT 'pending',
  completed_qty DECIMAL(10,3) DEFAULT 0,
  rejected_qty DECIMAL(10,3) DEFAULT 0,
  notes TEXT NULL,
  INDEX idx_wo_ops_wo(work_order_id)
);

-- Add delivery_challan_items if missing
CREATE TABLE IF NOT EXISTS delivery_challan_items (
  id VARCHAR(36) PRIMARY KEY,
  challan_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(10,3) NOT NULL DEFAULT 1,
  rate DECIMAL(12,2) DEFAULT 0,
  INDEX idx_challan_items_challan(challan_id)
);

-- Add number_series if missing
CREATE TABLE IF NOT EXISTS number_series (
  series_key VARCHAR(50) PRIMARY KEY,
  prefix VARCHAR(20) DEFAULT '',
  next_number INT DEFAULT 1,
  padding INT DEFAULT 5
);

-- Add operation_keys for idempotency if missing
CREATE TABLE IF NOT EXISTS operation_keys (
  id VARCHAR(36) PRIMARY KEY,
  operation_key VARCHAR(200) UNIQUE NOT NULL,
  result_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add stock_adjustments if missing
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id VARCHAR(36) PRIMARY KEY,
  adjustment_number VARCHAR(50) UNIQUE,
  warehouse_id VARCHAR(36),
  reason TEXT,
  status VARCHAR(30) DEFAULT 'draft',
  posted_at DATETIME NULL,
  created_by VARCHAR(36),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add stock_adjustment_items if missing
CREATE TABLE IF NOT EXISTS stock_adjustment_items (
  id VARCHAR(36) PRIMARY KEY,
  adjustment_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  direction VARCHAR(10) DEFAULT 'in',
  quantity DECIMAL(10,3) NOT NULL DEFAULT 0,
  rate DECIMAL(12,2) DEFAULT 0,
  INDEX idx_adj_items_adj(adjustment_id),
  CONSTRAINT fk_adj_items_adj FOREIGN KEY (adjustment_id) REFERENCES stock_adjustments(id) ON DELETE CASCADE
);

-- Add sales_returns if missing
CREATE TABLE IF NOT EXISTS sales_returns (
  id VARCHAR(36) PRIMARY KEY,
  return_number VARCHAR(50) UNIQUE,
  invoice_id VARCHAR(36) NULL,
  customer_id VARCHAR(36) NULL,
  return_date DATE,
  status VARCHAR(30) DEFAULT 'draft',
  total_amount DECIMAL(12,2) DEFAULT 0,
  taxable_amount DECIMAL(14,2) DEFAULT 0,
  cgst DECIMAL(14,2) DEFAULT 0,
  sgst DECIMAL(14,2) DEFAULT 0,
  igst DECIMAL(14,2) DEFAULT 0,
  notes TEXT NULL,
  created_by VARCHAR(36) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add purchase_returns if missing
CREATE TABLE IF NOT EXISTS purchase_returns (
  id VARCHAR(36) PRIMARY KEY,
  return_number VARCHAR(50) UNIQUE,
  grn_id VARCHAR(36) NULL,
  vendor_id VARCHAR(36) NULL,
  return_date DATE,
  status VARCHAR(30) DEFAULT 'draft',
  total_amount DECIMAL(12,2) DEFAULT 0,
  taxable_amount DECIMAL(14,2) DEFAULT 0,
  cgst DECIMAL(14,2) DEFAULT 0,
  sgst DECIMAL(14,2) DEFAULT 0,
  igst DECIMAL(14,2) DEFAULT 0,
  notes TEXT NULL,
  created_by VARCHAR(36) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add debit_notes if missing
CREATE TABLE IF NOT EXISTS debit_notes (
  id VARCHAR(36) PRIMARY KEY,
  note_number VARCHAR(50) UNIQUE,
  vendor_id VARCHAR(36) NULL,
  note_date DATE,
  status VARCHAR(30) DEFAULT 'draft',
  total_amount DECIMAL(12,2) DEFAULT 0,
  notes TEXT NULL,
  created_by VARCHAR(36) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add tally_sync_logs if missing
CREATE TABLE IF NOT EXISTS tally_sync_logs (
  id VARCHAR(36) PRIMARY KEY,
  sync_type VARCHAR(50),
  status VARCHAR(30) DEFAULT 'pending',
  records_synced INT DEFAULT 0,
  error_message TEXT NULL,
  synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add invoice_item_lines if missing (used by /sales/invoices/:id/lines)
CREATE TABLE IF NOT EXISTS invoice_item_lines (
  id VARCHAR(36) PRIMARY KEY,
  invoice_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NULL,
  description VARCHAR(500) NULL,
  quantity DECIMAL(10,3) NOT NULL DEFAULT 1,
  rate DECIMAL(12,2) DEFAULT 0,
  discount_percent DECIMAL(5,2) DEFAULT 0,
  gst_rate DECIMAL(5,2) DEFAULT 18,
  taxable DECIMAL(12,2) DEFAULT 0,
  cgst DECIMAL(12,2) DEFAULT 0,
  sgst DECIMAL(12,2) DEFAULT 0,
  igst DECIMAL(12,2) DEFAULT 0,
  total DECIMAL(12,2) DEFAULT 0,
  INDEX idx_invoice_lines_inv(invoice_id),
  CONSTRAINT fk_invoice_lines_inv FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);
