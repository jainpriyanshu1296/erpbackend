-- Additive foundations for quality, people, payroll, finance, tax and analytics.
CREATE TABLE IF NOT EXISTS employees (
  id VARCHAR(36) PRIMARY KEY, employee_code VARCHAR(50) NOT NULL, name VARCHAR(200) NOT NULL,
  email VARCHAR(200), department VARCHAR(100), designation VARCHAR(100), joining_date DATE,
  status VARCHAR(30) NOT NULL DEFAULT 'active', salary DECIMAL(14,2) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_employee_code(employee_code)
);
CREATE TABLE IF NOT EXISTS qc_inspections (
  id VARCHAR(36) PRIMARY KEY, inspection_number VARCHAR(60) NOT NULL, item_id VARCHAR(36),
  source_type VARCHAR(40) NOT NULL, source_id VARCHAR(36), inspected_by VARCHAR(36),
  status VARCHAR(30) NOT NULL DEFAULT 'pending', result VARCHAR(30), notes TEXT,
  inspected_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_qc_number(inspection_number)
);
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS run_number VARCHAR(60) NULL;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS period_start DATE NULL;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS period_end DATE NULL;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS processed_by VARCHAR(36) NULL;
ALTER TABLE payroll_runs ADD UNIQUE KEY uq_payroll_number(run_number);
ALTER TABLE payroll_items ADD UNIQUE KEY uq_payroll_employee(payroll_run_id,employee_id);
CREATE TABLE IF NOT EXISTS finance_accounts (
  id VARCHAR(36) PRIMARY KEY, code VARCHAR(30) NOT NULL, name VARCHAR(150) NOT NULL,
  account_type VARCHAR(40) NOT NULL, opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1, UNIQUE KEY uq_account_code(code)
);
CREATE TABLE IF NOT EXISTS finance_journals (
  id VARCHAR(36) PRIMARY KEY, journal_number VARCHAR(60) NOT NULL, journal_date DATE NOT NULL,
  narration VARCHAR(500), status VARCHAR(30) NOT NULL DEFAULT 'draft', total_debit DECIMAL(14,2) DEFAULT 0,
  created_by VARCHAR(36), created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_journal_number(journal_number)
);
CREATE TABLE IF NOT EXISTS finance_journal_lines (
  id VARCHAR(36) PRIMARY KEY, journal_id VARCHAR(36) NOT NULL, account_id VARCHAR(36) NOT NULL,
  debit DECIMAL(14,2) NOT NULL DEFAULT 0, credit DECIMAL(14,2) NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tax_transactions (
  id VARCHAR(36) PRIMARY KEY, transaction_number VARCHAR(60) NOT NULL, transaction_date DATE NOT NULL,
  counterparty_gstin VARCHAR(20), taxable_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  cgst DECIMAL(14,2) NOT NULL DEFAULT 0, sgst DECIMAL(14,2) NOT NULL DEFAULT 0,
  igst DECIMAL(14,2) NOT NULL DEFAULT 0, tax_type VARCHAR(30) NOT NULL DEFAULT 'sale',
  status VARCHAR(30) NOT NULL DEFAULT 'draft', UNIQUE KEY uq_tax_number(transaction_number)
);
CREATE TABLE IF NOT EXISTS report_snapshots (
  id VARCHAR(36) PRIMARY KEY, report_key VARCHAR(100) NOT NULL, period_start DATE, period_end DATE,
  parameters JSON, result JSON NOT NULL, generated_by VARCHAR(36), created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_report_key_period(report_key, period_start, period_end)
);
CREATE TABLE IF NOT EXISTS domain_idempotency (
  id VARCHAR(36) PRIMARY KEY, idempotency_key VARCHAR(150) NOT NULL, operation VARCHAR(100) NOT NULL,
  response_json JSON NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_domain_idempotency(idempotency_key, operation)
);
