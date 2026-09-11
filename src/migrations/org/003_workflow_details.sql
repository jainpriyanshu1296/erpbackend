CREATE TABLE IF NOT EXISTS bom_components (
  id VARCHAR(36) PRIMARY KEY,
  bom_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL,
  scrap_percent DECIMAL(7,2) DEFAULT 0,
  rate DECIMAL(14,2) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_bom_components_bom (bom_id),
  CONSTRAINT fk_bom_components_bom FOREIGN KEY (bom_id) REFERENCES bom(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS invoice_item_lines (
  id VARCHAR(36) PRIMARY KEY,
  invoice_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36),
  description VARCHAR(255),
  quantity DECIMAL(14,3) NOT NULL,
  rate DECIMAL(14,2) NOT NULL,
  discount_percent DECIMAL(7,2) DEFAULT 0,
  gst_rate DECIMAL(7,2) DEFAULT 0,
  taxable DECIMAL(14,2) DEFAULT 0,
  cgst DECIMAL(14,2) DEFAULT 0,
  sgst DECIMAL(14,2) DEFAULT 0,
  igst DECIMAL(14,2) DEFAULT 0,
  total DECIMAL(14,2) DEFAULT 0,
  INDEX idx_invoice_item_lines_invoice (invoice_id),
  CONSTRAINT fk_invoice_item_lines_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);
