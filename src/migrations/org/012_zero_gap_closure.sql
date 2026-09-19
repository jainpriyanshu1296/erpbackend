CREATE TABLE IF NOT EXISTS operation_keys (
  id VARCHAR(36) PRIMARY KEY, operation_key VARCHAR(150) NOT NULL UNIQUE,
  result_json JSON NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS approval_requests (
  id VARCHAR(36) PRIMARY KEY, entity_type VARCHAR(80) NOT NULL, entity_id VARCHAR(36) NOT NULL,
  status ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  requested_by VARCHAR(36), decided_by VARCHAR(36), decided_at DATETIME NULL,
  reason VARCHAR(500), created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_approval_entity(entity_type,entity_id)
);
CREATE TABLE IF NOT EXISTS approval_steps (
  id VARCHAR(36) PRIMARY KEY, approval_id VARCHAR(36) NOT NULL, step_no INT NOT NULL,
  approver_role VARCHAR(80), status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  acted_by VARCHAR(36), acted_at DATETIME NULL, UNIQUE KEY uq_approval_step(approval_id,step_no)
);
CREATE TABLE IF NOT EXISTS rfq_suppliers (
  id VARCHAR(36) PRIMARY KEY, rfq_id VARCHAR(36) NOT NULL, supplier_id VARCHAR(36) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'invited', invited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rfq_supplier(rfq_id,supplier_id)
);
CREATE TABLE IF NOT EXISTS rfq_quotation_lines (
  id VARCHAR(36) PRIMARY KEY, rfq_supplier_id VARCHAR(36) NOT NULL, item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL, unit_price DECIMAL(14,4) NOT NULL, tax_rate DECIMAL(8,4) DEFAULT 0,
  delivery_days INT DEFAULT 0, is_selected TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS purchase_returns (
  id VARCHAR(36) PRIMARY KEY, return_number VARCHAR(50) UNIQUE NOT NULL, supplier_id VARCHAR(36),
  purchase_invoice_id VARCHAR(36), status VARCHAR(30) NOT NULL DEFAULT 'draft',
  total_amount DECIMAL(14,2) DEFAULT 0, created_by VARCHAR(36), created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS purchase_return_lines (
  id VARCHAR(36) PRIMARY KEY, return_id VARCHAR(36) NOT NULL, item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL, unit_price DECIMAL(14,4) DEFAULT 0, batch_id VARCHAR(36), serial_id VARCHAR(36)
);
CREATE TABLE IF NOT EXISTS stock_batches (
  id VARCHAR(36) PRIMARY KEY, item_id VARCHAR(36) NOT NULL, batch_no VARCHAR(100) NOT NULL,
  expiry_date DATE NULL, quantity DECIMAL(14,3) NOT NULL DEFAULT 0, warehouse_id VARCHAR(36),
  UNIQUE KEY uq_item_batch(item_id,batch_no)
);
CREATE TABLE IF NOT EXISTS stock_serials (
  id VARCHAR(36) PRIMARY KEY, item_id VARCHAR(36) NOT NULL, serial_no VARCHAR(150) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'available', warehouse_id VARCHAR(36),
  UNIQUE KEY uq_item_serial(item_id,serial_no)
);
CREATE TABLE IF NOT EXISTS physical_counts (
  id VARCHAR(36) PRIMARY KEY, count_number VARCHAR(50) UNIQUE NOT NULL, warehouse_id VARCHAR(36) NOT NULL,
  status ENUM('draft','open','submitted','approved','posted','cancelled') NOT NULL DEFAULT 'draft',
  opened_by VARCHAR(36), approved_by VARCHAR(36), opened_at DATETIME NULL, posted_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS physical_count_lines (
  id VARCHAR(36) PRIMARY KEY, count_id VARCHAR(36) NOT NULL, item_id VARCHAR(36) NOT NULL,
  system_qty DECIMAL(14,3) NOT NULL DEFAULT 0, counted_qty DECIMAL(14,3) NULL,
  variance DECIMAL(14,3) AS (COALESCE(counted_qty,0)-system_qty) STORED
);
CREATE TABLE IF NOT EXISTS warehouse_locations (
  id VARCHAR(36) PRIMARY KEY, warehouse_id VARCHAR(36) NOT NULL, code VARCHAR(80) NOT NULL,
  name VARCHAR(150) NOT NULL, parent_id VARCHAR(36), is_active TINYINT(1) DEFAULT 1,
  UNIQUE KEY uq_warehouse_location(warehouse_id,code)
);
CREATE TABLE IF NOT EXISTS import_jobs (
  id VARCHAR(36) PRIMARY KEY, entity_type VARCHAR(80) NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'queued',
  source_name VARCHAR(255), total_rows INT DEFAULT 0, processed_rows INT DEFAULT 0, error_json JSON NULL,
  created_by VARCHAR(36), created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS export_jobs (
  id VARCHAR(36) PRIMARY KEY, entity_type VARCHAR(80) NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'queued',
  filter_json JSON NULL, result_json JSON NULL, created_by VARCHAR(36), created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sales_enquiries (
  id VARCHAR(36) PRIMARY KEY, enquiry_number VARCHAR(50) UNIQUE NOT NULL, customer_id VARCHAR(36),
  status VARCHAR(30) NOT NULL DEFAULT 'open', expected_date DATE NULL, notes TEXT, created_by VARCHAR(36),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payment_allocations (
  id VARCHAR(36) PRIMARY KEY, payment_id VARCHAR(36) NOT NULL, invoice_id VARCHAR(36) NOT NULL,
  allocated_amount DECIMAL(14,2) NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payment_invoice(payment_id,invoice_id)
);
CREATE TABLE IF NOT EXISTS sales_returns (
  id VARCHAR(36) PRIMARY KEY, return_number VARCHAR(50) UNIQUE NOT NULL, sales_order_id VARCHAR(36),
  customer_id VARCHAR(36), status VARCHAR(30) NOT NULL DEFAULT 'draft', total_amount DECIMAL(14,2) DEFAULT 0,
  created_by VARCHAR(36), created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS credit_notes (
  id VARCHAR(36) PRIMARY KEY, note_number VARCHAR(50) UNIQUE NOT NULL, sales_return_id VARCHAR(36),
  customer_id VARCHAR(36), amount DECIMAL(14,2) NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'draft',
  created_by VARCHAR(36), created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS production_outputs (
  id VARCHAR(36) PRIMARY KEY, production_order_id VARCHAR(36) NOT NULL, item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL, batch_id VARCHAR(36), recorded_by VARCHAR(36), created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS production_downtime (
  id VARCHAR(36) PRIMARY KEY, production_order_id VARCHAR(36) NOT NULL, minutes INT NOT NULL,
  reason VARCHAR(255) NOT NULL, recorded_by VARCHAR(36), created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS production_scrap (
  id VARCHAR(36) PRIMARY KEY, production_order_id VARCHAR(36) NOT NULL, item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL, reason VARCHAR(255), recorded_by VARCHAR(36), created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS related_documents (
  id VARCHAR(36) PRIMARY KEY, source_type VARCHAR(80) NOT NULL, source_id VARCHAR(36) NOT NULL,
  target_type VARCHAR(80) NOT NULL, target_id VARCHAR(36) NOT NULL, relation VARCHAR(80) NOT NULL,
  created_by VARCHAR(36), created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_related(source_type,source_id,target_type,target_id,relation)
);
