-- ─────────────────────────────────────────────────────────────
-- 006_advanced_modules.sql
-- Stock Reservation, Debit Notes, E-Invoice, E-Way Bill & Delivery Items
-- ─────────────────────────────────────────────────────────────

-- 1. Anti-Double-Selling: Stock Reservation column
ALTER TABLE stock_summary
  ADD COLUMN reserved_qty DECIMAL(10,3) DEFAULT 0;

-- 2. Vendor Debit Notes on QC Rejection
CREATE TABLE IF NOT EXISTS debit_notes (
  id VARCHAR(36) PRIMARY KEY,
  note_number VARCHAR(50) UNIQUE NOT NULL,
  vendor_id VARCHAR(36) NOT NULL,
  reference_type VARCHAR(50),
  reference_id VARCHAR(36),
  total_amount DECIMAL(14,2) DEFAULT 0,
  reason TEXT,
  status VARCHAR(30) DEFAULT 'draft',
  created_by VARCHAR(36),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_dn_vendor (vendor_id),
  INDEX idx_dn_ref (reference_type, reference_id)
);

CREATE TABLE IF NOT EXISTS debit_note_items (
  id VARCHAR(36) PRIMARY KEY,
  debit_note_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL,
  rate DECIMAL(14,2) DEFAULT 0,
  amount DECIMAL(14,2) DEFAULT 0,
  reason VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_dni_note (debit_note_id)
);

-- 3. GST E-Invoice Columns on Invoices
ALTER TABLE invoices
  ADD COLUMN irn VARCHAR(100) NULL,
  ADD COLUMN signed_qr_code TEXT NULL,
  ADD COLUMN ack_no VARCHAR(50) NULL,
  ADD COLUMN ack_date DATETIME NULL,
  ADD COLUMN einvoice_status VARCHAR(30) DEFAULT 'pending';

-- 4. E-Way Bill Columns on Delivery Challans
ALTER TABLE delivery_challans
  ADD COLUMN sales_order_id VARCHAR(36) NULL,
  ADD COLUMN eway_bill_no VARCHAR(50) NULL,
  ADD COLUMN eway_bill_date DATETIME NULL,
  ADD COLUMN valid_until DATETIME NULL,
  ADD COLUMN vehicle_number VARCHAR(50) NULL,
  ADD COLUMN eway_bill_status VARCHAR(30) DEFAULT 'pending';

-- 5. Delivery Challan Line Items
CREATE TABLE IF NOT EXISTS delivery_challan_items (
  id VARCHAR(36) PRIMARY KEY,
  challan_id VARCHAR(36) NOT NULL,
  order_item_id VARCHAR(36) NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL,
  rate DECIMAL(14,2) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_dci_challan (challan_id)
);
