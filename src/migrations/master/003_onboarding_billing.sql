ALTER TABLE subscriptions
  ADD COLUMN provider_order_id VARCHAR(100) NULL,
  ADD COLUMN provider_payment_id VARCHAR(100) NULL,
  ADD COLUMN currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  ADD UNIQUE KEY uq_subscription_provider_order (provider_order_id);

CREATE TABLE IF NOT EXISTS pending_organization_accounts (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(36) NOT NULL UNIQUE,
  owner_password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pending_org_account_org FOREIGN KEY (organization_id) REFERENCES organizations(id)
);

CREATE TABLE IF NOT EXISTS subscription_items (
  id VARCHAR(36) PRIMARY KEY,
  subscription_id VARCHAR(36) NOT NULL,
  module_key VARCHAR(50) NOT NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_subscription_item (subscription_id, module_key),
  CONSTRAINT fk_subscription_item_subscription FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
);

CREATE TABLE IF NOT EXISTS payment_orders (
  id VARCHAR(36) PRIMARY KEY,
  subscription_id VARCHAR(36) NOT NULL,
  provider VARCHAR(30) NOT NULL DEFAULT 'razorpay',
  provider_order_id VARCHAR(100) NOT NULL UNIQUE,
  amount DECIMAL(12,2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(30) NOT NULL DEFAULT 'created',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_payment_order_subscription FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
);

CREATE TABLE IF NOT EXISTS payment_events (
  id VARCHAR(36) PRIMARY KEY,
  provider VARCHAR(30) NOT NULL,
  provider_event_id VARCHAR(150) NOT NULL UNIQUE,
  event_type VARCHAR(100) NOT NULL,
  payload JSON NOT NULL,
  processed_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
