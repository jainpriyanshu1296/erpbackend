-- Additive job-work documents. These tables intentionally reuse the existing
-- item, warehouse, stock ledger, vendor, quality, and audit infrastructure.
CREATE TABLE IF NOT EXISTS job_work_challans (
  id VARCHAR(36) PRIMARY KEY,
  job_work_order_id VARCHAR(36) NOT NULL,
  challan_number VARCHAR(60) NOT NULL,
  warehouse_id VARCHAR(36) NOT NULL,
  outward_date DATE NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  created_by VARCHAR(36),
  cancelled_by VARCHAR(36),
  cancelled_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_job_work_challan_number (challan_number)
);

CREATE TABLE IF NOT EXISTS job_work_challan_items (
  id VARCHAR(36) PRIMARY KEY,
  challan_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL,
  UNIQUE KEY uq_job_work_challan_item (challan_id, item_id)
);

CREATE TABLE IF NOT EXISTS job_work_receipts (
  id VARCHAR(36) PRIMARY KEY,
  challan_id VARCHAR(36) NOT NULL,
  receipt_number VARCHAR(60) NOT NULL,
  warehouse_id VARCHAR(36) NOT NULL,
  receipt_date DATE NOT NULL,
  requires_qc TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'posted',
  created_by VARCHAR(36),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_job_work_receipt_number (receipt_number)
);

CREATE TABLE IF NOT EXISTS job_work_receipt_items (
  id VARCHAR(36) PRIMARY KEY,
  receipt_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL,
  rate DECIMAL(14,2) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_job_work_receipt_item (receipt_id, item_id)
);

CREATE TABLE IF NOT EXISTS job_work_consumptions (
  id VARCHAR(36) PRIMARY KEY,
  challan_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL,
  consumed_on DATE NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'posted',
  notes TEXT,
  created_by VARCHAR(36),
  cancelled_by VARCHAR(36),
  cancelled_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS job_work_finished_goods_receipts (
  id VARCHAR(36) PRIMARY KEY,
  challan_id VARCHAR(36) NOT NULL,
  receipt_number VARCHAR(60) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  warehouse_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL,
  rate DECIMAL(14,2) NOT NULL DEFAULT 0,
  receipt_date DATE NOT NULL,
  requires_qc TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'posted',
  created_by VARCHAR(36),
  cancelled_by VARCHAR(36),
  cancelled_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_job_work_finished_receipt_number (receipt_number)
);

CREATE TABLE IF NOT EXISTS job_work_bills (
  id VARCHAR(36) PRIMARY KEY,
  job_work_order_id VARCHAR(36) NOT NULL,
  finance_document_id VARCHAR(36) NOT NULL,
  bill_type VARCHAR(30) NOT NULL,
  created_by VARCHAR(36),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_job_work_finance_document (finance_document_id)
);

ALTER TABLE job_work_orders ADD COLUMN IF NOT EXISTS order_type VARCHAR(30) NOT NULL DEFAULT 'vendor';
ALTER TABLE job_work_orders ADD COLUMN IF NOT EXISTS customer_id VARCHAR(36) NULL;
ALTER TABLE job_work_orders ADD COLUMN IF NOT EXISTS warehouse_id VARCHAR(36) NULL;
ALTER TABLE job_work_orders ADD COLUMN IF NOT EXISTS rate DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE job_work_challans ADD COLUMN IF NOT EXISTS notes TEXT NULL;
ALTER TABLE job_work_challans ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE job_work_receipts ADD COLUMN IF NOT EXISTS notes TEXT NULL;
ALTER TABLE job_work_receipts ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(36) NULL;
ALTER TABLE job_work_receipts ADD COLUMN IF NOT EXISTS cancelled_at DATETIME NULL;
ALTER TABLE job_work_receipts ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
