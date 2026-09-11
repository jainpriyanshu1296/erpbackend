CREATE DATABASE IF NOT EXISTS `erp_master`;
USE `erp_master`;
CREATE TABLE IF NOT EXISTS organizations (
 id VARCHAR(36) PRIMARY KEY, slug VARCHAR(50) UNIQUE NOT NULL, db_name VARCHAR(100) UNIQUE NOT NULL,
 company_name VARCHAR(200) NOT NULL, owner_name VARCHAR(200), owner_email VARCHAR(200) NOT NULL,
 owner_phone VARCHAR(20), gstin VARCHAR(15), address TEXT, city VARCHAR(100), state VARCHAR(100),
 plan ENUM('free','starter','growth','pro') DEFAULT 'free', plan_started_at DATETIME, plan_expires_at DATETIME,
 is_active TINYINT(1) DEFAULT 1, is_trial TINYINT(1) DEFAULT 1, trial_ends_at DATETIME,
 is_suspended TINYINT(1) DEFAULT 0, suspension_reason TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS modules (id INT AUTO_INCREMENT PRIMARY KEY, module_key VARCHAR(50) UNIQUE NOT NULL, module_name VARCHAR(100) NOT NULL, min_plan ENUM('free','starter','growth','pro') DEFAULT 'free', sort_order INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS org_modules (org_id VARCHAR(36), module_key VARCHAR(50), is_active TINYINT(1) DEFAULT 1, PRIMARY KEY(org_id,module_key));
CREATE TABLE IF NOT EXISTS subscriptions (id VARCHAR(36) PRIMARY KEY, org_id VARCHAR(36) NOT NULL, plan VARCHAR(20) NOT NULL, duration_months INT NOT NULL, amount DECIMAL(10,2) NOT NULL, status VARCHAR(20) DEFAULT 'pending', starts_at DATETIME, expires_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS admin_users (id VARCHAR(36) PRIMARY KEY, name VARCHAR(200), email VARCHAR(200) UNIQUE, password_hash TEXT, role VARCHAR(30) DEFAULT 'support', is_active TINYINT(1) DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS plan_pricing (id INT AUTO_INCREMENT PRIMARY KEY, plan VARCHAR(20), duration_months INT, amount DECIMAL(10,2), is_active TINYINT(1) DEFAULT 1);
INSERT IGNORE INTO modules(module_key,module_name,min_plan,sort_order) VALUES
('dashboard','Dashboard','free',1),('purchase','Purchase & Procurement','starter',2),('inventory','Inventory & Warehouse','free',3),('production','Production & BOM','growth',4),('jobwork','Job Work','pro',5),('quality','Quality Control','growth',6),('sales','Sales & Dispatch','starter',7),('finance','Finance & Accounts','starter',8),('gst','GST & Compliance','starter',9),('hr','HR & Payroll','growth',10),('reports','Reports & Analytics','starter',11);
