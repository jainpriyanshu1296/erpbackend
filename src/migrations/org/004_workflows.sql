CREATE TABLE IF NOT EXISTS purchase_requisition_items (
  id VARCHAR(36) PRIMARY KEY, requisition_id VARCHAR(36) NOT NULL, item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL, rate DECIMAL(14,2) DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pr_items_requisition(requisition_id)
);
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id VARCHAR(36) PRIMARY KEY, order_id VARCHAR(36) NOT NULL, requisition_item_id VARCHAR(36),
  item_id VARCHAR(36) NOT NULL, quantity DECIMAL(14,3) NOT NULL, rate DECIMAL(14,2) DEFAULT 0,
  INDEX idx_po_items_order(order_id)
);
CREATE TABLE IF NOT EXISTS grn_items (
  id VARCHAR(36) PRIMARY KEY, grn_id VARCHAR(36) NOT NULL, po_item_id VARCHAR(36),
  item_id VARCHAR(36) NOT NULL, quantity DECIMAL(14,3) NOT NULL, rate DECIMAL(14,2) DEFAULT 0,
  INDEX idx_grn_items_grn(grn_id)
);
CREATE TABLE IF NOT EXISTS quotation_items (
  id VARCHAR(36) PRIMARY KEY, quotation_id VARCHAR(36) NOT NULL, item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL, rate DECIMAL(14,2) DEFAULT 0, INDEX idx_quote_items_quote(quotation_id)
);
CREATE TABLE IF NOT EXISTS sales_order_items (
  id VARCHAR(36) PRIMARY KEY, order_id VARCHAR(36) NOT NULL, quotation_item_id VARCHAR(36),
  item_id VARCHAR(36) NOT NULL, quantity DECIMAL(14,3) NOT NULL, rate DECIMAL(14,2) DEFAULT 0,
  INDEX idx_so_items_order(order_id)
);
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS warehouse_id VARCHAR(36), ADD COLUMN IF NOT EXISTS requisition_id VARCHAR(36);
ALTER TABLE purchase_requisitions ADD COLUMN IF NOT EXISTS required_by DATE, ADD COLUMN IF NOT EXISTS department_id INT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS delivery_date DATE, ADD COLUMN IF NOT EXISTS payment_terms INT DEFAULT 30;
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS quotation_id VARCHAR(36);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS order_id VARCHAR(36);
