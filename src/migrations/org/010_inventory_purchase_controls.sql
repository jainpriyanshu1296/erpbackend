CREATE TABLE IF NOT EXISTS warehouse_transfers (
  id VARCHAR(36) PRIMARY KEY, transfer_number VARCHAR(50) UNIQUE NOT NULL,
  from_warehouse_id VARCHAR(36) NOT NULL, to_warehouse_id VARCHAR(36) NOT NULL,
  status ENUM('draft','requested','approved','in_transit','received','cancelled') NOT NULL DEFAULT 'draft',
  requested_by VARCHAR(36), approved_by VARCHAR(36), received_by VARCHAR(36),
  requested_at DATETIME NULL, approved_at DATETIME NULL, received_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_transfer_status(status)
);
CREATE TABLE IF NOT EXISTS warehouse_transfer_items (
  id VARCHAR(36) PRIMARY KEY, transfer_id VARCHAR(36) NOT NULL, item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL, rate DECIMAL(14,2) DEFAULT 0,
  INDEX idx_transfer_items(transfer_id), CONSTRAINT fk_transfer_items_transfer FOREIGN KEY (transfer_id) REFERENCES warehouse_transfers(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS warehouse_transfer_receipts (
  id VARCHAR(36) PRIMARY KEY, transfer_id VARCHAR(36) NOT NULL UNIQUE, received_by VARCHAR(36),
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS stock_reservations (
  id VARCHAR(36) PRIMARY KEY, item_id VARCHAR(36) NOT NULL, warehouse_id VARCHAR(36) NOT NULL,
  reference_type VARCHAR(50), reference_id VARCHAR(36), quantity DECIMAL(14,3) NOT NULL,
  status ENUM('reserved','released','consumed') NOT NULL DEFAULT 'reserved',
  created_by VARCHAR(36), created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_reservation_stock(item_id,warehouse_id,status)
);
CREATE TABLE IF NOT EXISTS stock_counts (
  id VARCHAR(36) PRIMARY KEY, count_number VARCHAR(50) UNIQUE NOT NULL, warehouse_id VARCHAR(36) NOT NULL,
  status ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft', counted_by VARCHAR(36), posted_by VARCHAR(36),
  posted_at DATETIME NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS stock_count_items (
  id VARCHAR(36) PRIMARY KEY, count_id VARCHAR(36) NOT NULL, item_id VARCHAR(36) NOT NULL,
  counted_quantity DECIMAL(14,3) NOT NULL, system_quantity DECIMAL(14,3) DEFAULT 0, rate DECIMAL(14,2) DEFAULT 0,
  INDEX idx_count_items(count_id), CONSTRAINT fk_count_items_count FOREIGN KEY (count_id) REFERENCES stock_counts(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS rfqs (
  id VARCHAR(36) PRIMARY KEY, rfq_number VARCHAR(50) UNIQUE NOT NULL,
  status ENUM('draft','requested','quoted','compared','selected','approved','cancelled') NOT NULL DEFAULT 'draft',
  requested_by VARCHAR(36), approved_by VARCHAR(36), created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS rfq_items (
  id VARCHAR(36) PRIMARY KEY, rfq_id VARCHAR(36) NOT NULL, item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL, INDEX idx_rfq_items(rfq_id),
  CONSTRAINT fk_rfq_items_rfq FOREIGN KEY (rfq_id) REFERENCES rfqs(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS supplier_quotations (
  id VARCHAR(36) PRIMARY KEY, quotation_number VARCHAR(50) UNIQUE NOT NULL, rfq_id VARCHAR(36) NOT NULL,
  vendor_id VARCHAR(36) NOT NULL, status ENUM('draft','submitted','selected','rejected') NOT NULL DEFAULT 'draft',
  total_amount DECIMAL(14,2) DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_supplier_quotes_rfq(rfq_id)
);
CREATE TABLE IF NOT EXISTS supplier_quotation_items (
  id VARCHAR(36) PRIMARY KEY, quotation_id VARCHAR(36) NOT NULL, item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL, rate DECIMAL(14,2) NOT NULL, INDEX idx_supplier_quote_items(quotation_id),
  CONSTRAINT fk_supplier_quote_items_quote FOREIGN KEY (quotation_id) REFERENCES supplier_quotations(id) ON DELETE CASCADE
);
