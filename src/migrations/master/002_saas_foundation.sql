USE `erp_master`;

ALTER TABLE organizations
  ADD COLUMN status VARCHAR(30) NOT NULL DEFAULT 'active' AFTER plan,
  ADD INDEX idx_organizations_status (status);

CREATE TABLE IF NOT EXISTS reserved_subdomains (
  subdomain VARCHAR(63) PRIMARY KEY,
  reason VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO reserved_subdomains(subdomain, reason) VALUES
('www','Platform website'),('admin','Platform administration'),('api','Platform API'),
('app','Platform application'),('mail','Email service'),('smtp','Email service'),
('ftp','Reserved infrastructure'),('support','Support portal'),('billing','Billing portal'),
('static','Static assets'),('assets','Static assets'),('cdn','Content delivery');

CREATE TABLE IF NOT EXISTS organization_domains (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(36) NOT NULL,
  hostname VARCHAR(255) NOT NULL UNIQUE,
  subdomain VARCHAR(63) NOT NULL UNIQUE,
  is_primary TINYINT(1) NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_organization_domains_org (organization_id),
  CONSTRAINT fk_organization_domains_org FOREIGN KEY (organization_id) REFERENCES organizations(id)
);

INSERT INTO organization_domains(id, organization_id, hostname, subdomain, is_primary, is_active)
SELECT UUID(), o.id, CONCAT(o.slug, '.daanoday.com'), o.slug, 1, 1
FROM organizations o
LEFT JOIN organization_domains d ON d.organization_id = o.id
WHERE d.id IS NULL AND o.slug REGEXP '^[a-z0-9-]{1,63}$';

CREATE TABLE IF NOT EXISTS api_error_logs (
  id VARCHAR(36) PRIMARY KEY,
  request_id VARCHAR(100),
  method VARCHAR(10) NOT NULL,
  path TEXT NOT NULL,
  status_code INT NOT NULL,
  error_code VARCHAR(100) NOT NULL,
  message TEXT,
  stack TEXT,
  organization_id VARCHAR(36),
  user_id VARCHAR(36),
  hostname VARCHAR(255),
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_api_error_logs_created_at (created_at),
  INDEX idx_api_error_logs_org (organization_id),
  INDEX idx_api_error_logs_code (error_code)
);

CREATE TABLE IF NOT EXISTS module_catalog (
  module_key VARCHAR(50) PRIMARY KEY,
  description TEXT,
  icon VARCHAR(100),
  category VARCHAR(100),
  is_purchasable TINYINT(1) NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  display_order INT NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_module_catalog_module FOREIGN KEY (module_key) REFERENCES modules(module_key)
);

INSERT IGNORE INTO module_catalog(module_key, description, category, display_order)
SELECT module_key, module_name, 'ERP', sort_order FROM modules;

CREATE TABLE IF NOT EXISTS module_features (
  id VARCHAR(36) PRIMARY KEY,
  module_key VARCHAR(50) NOT NULL,
  feature_key VARCHAR(100) NOT NULL,
  feature_name VARCHAR(150) NOT NULL,
  description TEXT,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  display_order INT NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_module_feature (module_key, feature_key),
  CONSTRAINT fk_module_features_module FOREIGN KEY (module_key) REFERENCES modules(module_key)
);

CREATE TABLE IF NOT EXISTS module_pricing (
  id VARCHAR(36) PRIMARY KEY,
  module_key VARCHAR(50) NOT NULL,
  duration_months INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_module_pricing (module_key, duration_months),
  CONSTRAINT fk_module_pricing_module FOREIGN KEY (module_key) REFERENCES modules(module_key)
);
