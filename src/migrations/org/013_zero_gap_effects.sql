CREATE TABLE IF NOT EXISTS approval_policies (
  id VARCHAR(36) PRIMARY KEY,
  entity_type VARCHAR(80) NOT NULL,
  min_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  approver_role VARCHAR(80) NOT NULL,
  step_no INT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_approval_policy(entity_type,min_amount,step_no)
);

CREATE TABLE IF NOT EXISTS approval_step_events (
  id VARCHAR(36) PRIMARY KEY,
  approval_step_id VARCHAR(36) NOT NULL,
  action VARCHAR(30) NOT NULL,
  acted_by VARCHAR(36),
  notes VARCHAR(500),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_effects (
  id VARCHAR(36) PRIMARY KEY,
  operation_key VARCHAR(150) NOT NULL UNIQUE,
  reference_type VARCHAR(80) NOT NULL,
  reference_id VARCHAR(36) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS import_rows (
  id VARCHAR(36) PRIMARY KEY,
  import_job_id VARCHAR(36) NOT NULL,
  row_no INT NOT NULL,
  payload JSON NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'queued',
  error_message VARCHAR(500),
  UNIQUE KEY uq_import_row(import_job_id,row_no)
);

ALTER TABLE physical_counts ADD COLUMN IF NOT EXISTS legacy_stock_count_id VARCHAR(36);
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS payload_json JSON NULL;
ALTER TABLE export_jobs ADD COLUMN IF NOT EXISTS result_content LONGTEXT NULL;
ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS warehouse_id VARCHAR(36) NULL;
ALTER TABLE sales_returns ADD COLUMN IF NOT EXISTS warehouse_id VARCHAR(36) NULL;
ALTER TABLE production_outputs ADD COLUMN IF NOT EXISTS warehouse_id VARCHAR(36) NULL;
ALTER TABLE production_scrap ADD COLUMN IF NOT EXISTS warehouse_id VARCHAR(36) NULL;
ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS invoice_id VARCHAR(36) NULL;

CREATE TABLE IF NOT EXISTS sales_return_lines (
  id VARCHAR(36) PRIMARY KEY,
  return_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL,
  unit_price DECIMAL(14,4) DEFAULT 0,
  batch_id VARCHAR(36),
  serial_id VARCHAR(36)
);
