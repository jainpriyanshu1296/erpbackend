-- Migration 025: Purchase, Inventory, and Sales Module Tables
-- Adds comprehensive tables for purchase requisitions, orders, GRN, returns
-- Inventory transfers, adjustments, and stock management
-- Sales quotations, orders, delivery, and invoices

-- ============ PURCHASE REQUISITION TABLES ============
CREATE TABLE IF NOT EXISTS purchase_requisition_items (
  id VARCHAR(36) PRIMARY KEY,
  requisition_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL DEFAULT 1,
  rate DECIMAL(14,2) DEFAULT 0,
  notes TEXT,
  INDEX idx_pr_items_req(requisition_id),
  CONSTRAINT fk_pr_items_req FOREIGN KEY (requisition_id) REFERENCES purchase_requisitions(id) ON DELETE CASCADE
);

-- Add missing columns to purchase_requisitions
ALTER TABLE purchase_requisitions
  ADD COLUMN IF NOT EXISTS department VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS warehouse_id VARCHAR(36) NULL,
  ADD COLUMN IF NOT EXISTS required_date DATE NULL,
  ADD COLUMN IF NOT EXISTS priority VARCHAR(30) DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(500) NULL;

-- ============ PURCHASE ORDER ITEM TABLES ============
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id VARCHAR(36) PRIMARY KEY,
  po_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL DEFAULT 1,
  rate DECIMAL(14,2) DEFAULT 0,
  received_qty DECIMAL(14,3) DEFAULT 0,
  discount_percent DECIMAL(5,2) DEFAULT 0,
  tax_percent DECIMAL(5,2) DEFAULT 0,
  INDEX idx_po_items_po(po_id),
  CONSTRAINT fk_po_items_po FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
);

-- Add missing columns to purchase_orders
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS delivery_date DATE NULL,
  ADD COLUMN IF NOT EXISTS warehouse_id VARCHAR(36) NULL,
  ADD COLUMN IF NOT EXISTS payment_terms INT DEFAULT 30,
  ADD COLUMN IF NOT EXISTS notes TEXT NULL;

-- ============ GRN ITEM TABLES ============
CREATE TABLE IF NOT EXISTS grn_items (
  id VARCHAR(36) PRIMARY KEY,
  grn_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  po_item_id VARCHAR(36) NULL,
  quantity DECIMAL(14,3) NOT NULL DEFAULT 1,
  rate DECIMAL(14,2) DEFAULT 0,
  INDEX idx_grn_items_grn(grn_id),
  CONSTRAINT fk_grn_items_grn FOREIGN KEY (grn_id) REFERENCES grn(id) ON DELETE CASCADE
);

-- Add missing columns to grn
ALTER TABLE grn
  ADD COLUMN IF NOT EXISTS warehouse_id VARCHAR(36) NULL,
  ADD COLUMN IF NOT EXISTS notes TEXT NULL;

-- ============ PURCHASE RETURN TABLES ============
CREATE TABLE IF NOT EXISTS purchase_returns (
  id VARCHAR(36) PRIMARY KEY,
  return_number VARCHAR(50) UNIQUE NOT NULL,
  vendor_id VARCHAR(36) NOT NULL,
  grn_id VARCHAR(36) NULL,
  warehouse_id VARCHAR(36) NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  reason TEXT NULL,
  notes TEXT NULL,
  posted_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_purchase_returns_vendor(vendor_id),
  INDEX idx_purchase_returns_status(status)
);

CREATE TABLE IF NOT EXISTS purchase_return_items (
  id VARCHAR(36) PRIMARY KEY,
  return_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL DEFAULT 1,
  rate DECIMAL(14,2) DEFAULT 0,
  INDEX idx_pr_items_return(return_id),
  CONSTRAINT fk_pr_items_return FOREIGN KEY (return_id) REFERENCES purchase_returns(id) ON DELETE CASCADE
);

-- ============ INVENTORY TRANSFER TABLES ============
CREATE TABLE IF NOT EXISTS warehouse_transfer_items (
  id VARCHAR(36) PRIMARY KEY,
  transfer_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL,
  rate DECIMAL(14,2) DEFAULT 0,
  INDEX idx_transfer_items(transfer_id),
  CONSTRAINT fk_transfer_items_transfer FOREIGN KEY (transfer_id) REFERENCES warehouse_transfers(id) ON DELETE CASCADE
);

-- ============ STOCK ADJUSTMENT TABLES ============
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id VARCHAR(36) PRIMARY KEY,
  adjustment_number VARCHAR(50) UNIQUE NOT NULL,
  warehouse_id VARCHAR(36) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  reason TEXT NOT NULL,
  posted_at DATETIME NULL,
  posted_by VARCHAR(36) NULL,
  created_by VARCHAR(36) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_stock_adj_warehouse(warehouse_id),
  INDEX idx_stock_adj_status(status)
);

CREATE TABLE IF NOT EXISTS stock_adjustment_items (
  id VARCHAR(36) PRIMARY KEY,
  adjustment_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  direction VARCHAR(10) NOT NULL DEFAULT 'in',
  quantity DECIMAL(14,3) NOT NULL DEFAULT 0,
  rate DECIMAL(14,2) DEFAULT 0,
  INDEX idx_adj_items_adj(adjustment_id),
  CONSTRAINT fk_adj_items_adj FOREIGN KEY (adjustment_id) REFERENCES stock_adjustments(id) ON DELETE CASCADE
);

-- ============ QUOTATION ITEM TABLES ============
CREATE TABLE IF NOT EXISTS quotation_items (
  id VARCHAR(36) PRIMARY KEY,
  quotation_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL DEFAULT 1,
  rate DECIMAL(14,2) DEFAULT 0,
  discount_percent DECIMAL(5,2) DEFAULT 0,
  gst_rate DECIMAL(5,2) DEFAULT 18,
  amount DECIMAL(14,2) DEFAULT 0,
  INDEX idx_quotation_items_q(quotation_id),
  CONSTRAINT fk_quotation_items_q FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE CASCADE
);

-- Add missing columns to quotations
ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS valid_until DATE NULL,
  ADD COLUMN IF NOT EXISTS notes TEXT NULL,
  ADD COLUMN IF NOT EXISTS created_by VARCHAR(36) NULL;

-- ============ SALES ORDER ITEM TABLES ============
CREATE TABLE IF NOT EXISTS sales_order_items (
  id VARCHAR(36) PRIMARY KEY,
  so_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL DEFAULT 1,
  rate DECIMAL(14,2) DEFAULT 0,
  delivered_qty DECIMAL(14,3) DEFAULT 0,
  discount_percent DECIMAL(5,2) DEFAULT 0,
  gst_rate DECIMAL(5,2) DEFAULT 18,
  amount DECIMAL(14,2) DEFAULT 0,
  INDEX idx_so_items_so(so_id),
  CONSTRAINT fk_so_items_so FOREIGN KEY (so_id) REFERENCES sales_orders(id) ON DELETE CASCADE
);

-- Add missing columns to sales_orders
ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS delivery_date DATE NULL,
  ADD COLUMN IF NOT EXISTS notes TEXT NULL,
  ADD COLUMN IF NOT EXISTS created_by VARCHAR(36) NULL;

-- ============ DELIVERY CHALLAN ITEM TABLES ============
CREATE TABLE IF NOT EXISTS delivery_challan_items (
  id VARCHAR(36) PRIMARY KEY,
  challan_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL DEFAULT 1,
  rate DECIMAL(14,2) DEFAULT 0,
  INDEX idx_challan_items_challan(challan_id),
  CONSTRAINT fk_challan_items_challan FOREIGN KEY (challan_id) REFERENCES delivery_challans(id) ON DELETE CASCADE
);

-- Add missing columns to delivery_challans
ALTER TABLE delivery_challans
  ADD COLUMN IF NOT EXISTS so_id VARCHAR(36) NULL,
  ADD COLUMN IF NOT EXISTS warehouse_id VARCHAR(36) NULL,
  ADD COLUMN IF NOT EXISTS notes TEXT NULL,
  ADD COLUMN IF NOT EXISTS created_by VARCHAR(36) NULL;

-- ============ SALES INVOICE ITEM TABLES ============
CREATE TABLE IF NOT EXISTS invoice_items (
  id VARCHAR(36) PRIMARY KEY,
  invoice_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NULL,
  description VARCHAR(500) NULL,
  quantity DECIMAL(14,3) NOT NULL DEFAULT 1,
  rate DECIMAL(14,2) DEFAULT 0,
  discount_percent DECIMAL(5,2) DEFAULT 0,
  gst_rate DECIMAL(5,2) DEFAULT 18,
  taxable DECIMAL(14,2) DEFAULT 0,
  cgst DECIMAL(14,2) DEFAULT 0,
  sgst DECIMAL(14,2) DEFAULT 0,
  igst DECIMAL(14,2) DEFAULT 0,
  total DECIMAL(14,2) DEFAULT 0,
  INDEX idx_invoice_items_inv(invoice_id),
  CONSTRAINT fk_invoice_items_inv FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);

-- Add missing columns to invoices
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS due_date DATE NULL,
  ADD COLUMN IF NOT EXISTS so_id VARCHAR(36) NULL,
  ADD COLUMN IF NOT EXISTS notes TEXT NULL,
  ADD COLUMN IF NOT EXISTS created_by VARCHAR(36) NULL;

-- ============ SALES RETURN TABLES ============
CREATE TABLE IF NOT EXISTS sales_returns (
  id VARCHAR(36) PRIMARY KEY,
  return_number VARCHAR(50) UNIQUE NOT NULL,
  so_id VARCHAR(36) NULL,
  customer_id VARCHAR(36) NOT NULL,
  warehouse_id VARCHAR(36) NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  reason TEXT NULL,
  notes TEXT NULL,
  posted_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sales_returns_customer(customer_id),
  INDEX idx_sales_returns_status(status)
);

CREATE TABLE IF NOT EXISTS sales_return_items (
  id VARCHAR(36) PRIMARY KEY,
  return_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL DEFAULT 1,
  rate DECIMAL(14,2) DEFAULT 0,
  INDEX idx_sr_items_return(return_id),
  CONSTRAINT fk_sr_items_return FOREIGN KEY (return_id) REFERENCES sales_returns(id) ON DELETE CASCADE
);

-- Add missing columns to sales_returns
ALTER TABLE sales_returns
  ADD COLUMN IF NOT EXISTS so_id VARCHAR(36) NULL,
  ADD COLUMN IF NOT EXISTS warehouse_id VARCHAR(36) NULL,
  ADD COLUMN IF NOT EXISTS reason TEXT NULL;

-- ============ INVOICE PAYMENT TABLES ============
CREATE TABLE IF NOT EXISTS invoice_payments (
  id VARCHAR(36) PRIMARY KEY,
  invoice_id VARCHAR(36) NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  method VARCHAR(30) DEFAULT 'bank',
  reference VARCHAR(100) NULL,
  payment_date DATE,
  created_by VARCHAR(36) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_invoice_payments_inv(invoice_id),
  CONSTRAINT fk_invoice_payments_inv FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);

-- ============ VENDOR PAYMENT TABLES ============
CREATE TABLE IF NOT EXISTS vendor_payments (
  id VARCHAR(36) PRIMARY KEY,
  vendor_id VARCHAR(36) NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  method VARCHAR(30) DEFAULT 'bank',
  reference VARCHAR(100) NULL,
  payment_date DATE,
  created_by VARCHAR(36) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_vendor_payments_vendor(vendor_id)
);

-- Add missing columns to vendors
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS bank_account VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS bank_ifsc VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS credit_limit DECIMAL(14,2) DEFAULT 0;

-- Add missing columns to customers
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS credit_limit DECIMAL(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_percent DECIMAL(5,2) DEFAULT 0;

-- ============ INDEXES FOR PERFORMANCE ============
CREATE INDEX IF NOT EXISTS idx_stock_ledger_item ON stock_ledger(item_id);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_warehouse ON stock_ledger(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_type ON stock_ledger(transaction_type);
CREATE INDEX IF NOT EXISTS idx_stock_summary_item ON stock_summary(item_id);
CREATE INDEX IF NOT EXISTS idx_stock_summary_warehouse ON stock_summary(warehouse_id);
