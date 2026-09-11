CREATE TABLE IF NOT EXISTS number_series (
  series_key VARCHAR(50) PRIMARY KEY, prefix VARCHAR(30) NOT NULL,
  next_number BIGINT NOT NULL DEFAULT 1, padding TINYINT NOT NULL DEFAULT 5,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id VARCHAR(36) PRIMARY KEY, adjustment_number VARCHAR(50) UNIQUE, warehouse_id VARCHAR(36) NOT NULL,
  status VARCHAR(20) DEFAULT 'draft', reason VARCHAR(255), created_by VARCHAR(36),
  posted_at DATETIME NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_stock_adjustments_status(status)
);
CREATE TABLE IF NOT EXISTS stock_adjustment_items (
  id VARCHAR(36) PRIMARY KEY, adjustment_id VARCHAR(36) NOT NULL, item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL, rate DECIMAL(14,2) DEFAULT 0, direction ENUM('in','out') NOT NULL,
  INDEX idx_adjustment_items(adjustment_id), CONSTRAINT fk_adjustment_items FOREIGN KEY (adjustment_id) REFERENCES stock_adjustments(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS invoice_items (
  id VARCHAR(36) PRIMARY KEY, invoice_id VARCHAR(36) NOT NULL, item_id VARCHAR(36), description VARCHAR(255),
  quantity DECIMAL(14,3) NOT NULL, rate DECIMAL(14,2) NOT NULL, discount_percent DECIMAL(7,2) DEFAULT 0,
  gst_rate DECIMAL(7,2) DEFAULT 0, taxable DECIMAL(14,2) DEFAULT 0, cgst DECIMAL(14,2) DEFAULT 0,
  sgst DECIMAL(14,2) DEFAULT 0, igst DECIMAL(14,2) DEFAULT 0, total DECIMAL(14,2) DEFAULT 0,
  INDEX idx_invoice_items_invoice(invoice_id)
);
CREATE TABLE IF NOT EXISTS invoice_payments (
  id VARCHAR(36) PRIMARY KEY, invoice_id VARCHAR(36) NOT NULL, amount DECIMAL(14,2) NOT NULL,
  method VARCHAR(30) DEFAULT 'bank', reference VARCHAR(100), paid_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(36), INDEX idx_invoice_payments_invoice(invoice_id)
);
CREATE TABLE IF NOT EXISTS payroll_items (
  id VARCHAR(36) PRIMARY KEY, payroll_run_id VARCHAR(36) NOT NULL, employee_id VARCHAR(36) NOT NULL,
  gross_amount DECIMAL(14,2) DEFAULT 0, deductions DECIMAL(14,2) DEFAULT 0, net_amount DECIMAL(14,2) DEFAULT 0,
  INDEX idx_payroll_items_run(payroll_run_id)
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id, expires_at);
CREATE INDEX idx_activity_created ON activity_log(created_at);
CREATE INDEX idx_stock_ledger_item ON stock_ledger(item_id, warehouse_id, transaction_date);
CREATE INDEX idx_notifications_user ON notifications(user_id, is_read, created_at);
