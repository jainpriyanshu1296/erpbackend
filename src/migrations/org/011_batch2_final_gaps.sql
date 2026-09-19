ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS quotation_id VARCHAR(36) NULL;
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS sales_order_id VARCHAR(36) NULL;
CREATE UNIQUE INDEX uq_sales_orders_quotation ON sales_orders(quotation_id);
CREATE TABLE IF NOT EXISTS material_issue_effects (
  id VARCHAR(36) PRIMARY KEY, issue_key VARCHAR(100) NOT NULL UNIQUE,
  work_order_id VARCHAR(36) NOT NULL, warehouse_id VARCHAR(36) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS production_orders (
  id VARCHAR(36) PRIMARY KEY, production_number VARCHAR(50) UNIQUE,
  sales_order_id VARCHAR(36), bom_id VARCHAR(36) NOT NULL, item_id VARCHAR(36) NOT NULL,
  planned_qty DECIMAL(14,3) NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'draft',
  created_by VARCHAR(36), created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS job_cards (
  id VARCHAR(36) PRIMARY KEY, production_order_id VARCHAR(36) NOT NULL,
  operation_id VARCHAR(36), status VARCHAR(30) NOT NULL DEFAULT 'queued',
  planned_qty DECIMAL(14,3) DEFAULT 0, completed_qty DECIMAL(14,3) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_job_cards_production ON job_cards(production_order_id);
