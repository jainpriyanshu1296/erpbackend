CREATE TABLE IF NOT EXISTS vendor_items (
  vendor_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  vendor_item_code VARCHAR(100),
  preferred TINYINT(1) DEFAULT 0,
  last_rate DECIMAL(14,2) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (vendor_id, item_id),
  INDEX idx_vendor_items_item(item_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36),
  module VARCHAR(50) NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  entity_type VARCHAR(50),
  entity_id VARCHAR(36),
  payload JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_entity(entity_type, entity_id),
  INDEX idx_audit_created(created_at)
);

ALTER TABLE grn ADD COLUMN IF NOT EXISTS posted_at DATETIME NULL;
