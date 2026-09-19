-- Payroll, accounting and GST controls.  This migration is additive so it is
-- safe to run against organisations provisioned by earlier releases.
CREATE TABLE IF NOT EXISTS payroll_components (
 id VARCHAR(36) PRIMARY KEY, code VARCHAR(60) NOT NULL, name VARCHAR(150) NOT NULL,
 component_type VARCHAR(30) NOT NULL DEFAULT 'earning', formula TEXT, taxable TINYINT(1) NOT NULL DEFAULT 1,
 statutory TINYINT(1) NOT NULL DEFAULT 0, is_active TINYINT(1) NOT NULL DEFAULT 1,
 UNIQUE KEY uq_payroll_component_code(code)
);
CREATE TABLE IF NOT EXISTS payroll_assignment_components (
 id VARCHAR(36) PRIMARY KEY, assignment_id VARCHAR(36) NOT NULL, component_id VARCHAR(36) NOT NULL,
 amount DECIMAL(14,2) NOT NULL DEFAULT 0, formula TEXT, effective_from DATE NOT NULL,
 UNIQUE KEY uq_assignment_component(assignment_id,component_id,effective_from)
);
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS reviewed_by VARCHAR(36) NULL;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS reviewed_at DATETIME NULL;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS locked_by VARCHAR(36) NULL;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS locked_at DATETIME NULL;
ALTER TABLE payroll_snapshots ADD COLUMN IF NOT EXISTS immutable_hash CHAR(64) NULL;
CREATE TABLE IF NOT EXISTS payroll_statutory_deductions (
 id VARCHAR(36) PRIMARY KEY, payroll_run_id VARCHAR(36) NOT NULL, employee_id VARCHAR(36) NOT NULL,
 deduction_type VARCHAR(40) NOT NULL, amount DECIMAL(14,2) NOT NULL, payload JSON,
 UNIQUE KEY uq_payroll_statutory(payroll_run_id,employee_id,deduction_type)
);
CREATE TABLE IF NOT EXISTS payroll_finance_posts (
 id VARCHAR(36) PRIMARY KEY, payroll_run_id VARCHAR(36) NOT NULL, journal_id VARCHAR(36) NOT NULL,
 created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_payroll_post(payroll_run_id)
);
CREATE TABLE IF NOT EXISTS finance_account_closure (
 account_id VARCHAR(36) PRIMARY KEY, parent_account_id VARCHAR(36) NULL
);
ALTER TABLE finance_accounts ADD COLUMN IF NOT EXISTS parent_id VARCHAR(36) NULL;
ALTER TABLE finance_accounts ADD COLUMN IF NOT EXISTS normal_balance ENUM('debit','credit') NULL;
ALTER TABLE finance_journals ADD COLUMN IF NOT EXISTS submitted_by VARCHAR(36) NULL;
ALTER TABLE finance_journals ADD COLUMN IF NOT EXISTS submitted_at DATETIME NULL;
ALTER TABLE finance_journals ADD COLUMN IF NOT EXISTS approved_by VARCHAR(36) NULL;
ALTER TABLE finance_journals ADD COLUMN IF NOT EXISTS approved_at DATETIME NULL;
ALTER TABLE finance_journals ADD COLUMN IF NOT EXISTS reversal_of VARCHAR(36) NULL;
CREATE INDEX idx_accounts_parent ON finance_accounts(parent_id);
CREATE TABLE IF NOT EXISTS gst_tax_masters (
 id VARCHAR(36) PRIMARY KEY, code VARCHAR(30) NOT NULL, description VARCHAR(200), rate DECIMAL(7,3) NOT NULL,
 cess_rate DECIMAL(7,3) NOT NULL DEFAULT 0, hsn_sac VARCHAR(20), effective_from DATE NOT NULL,
 is_active TINYINT(1) NOT NULL DEFAULT 1, UNIQUE KEY uq_gst_master(code,effective_from)
);
CREATE TABLE IF NOT EXISTS gst_context_snapshots (
 id VARCHAR(36) PRIMARY KEY, source_type VARCHAR(40) NOT NULL, source_id VARCHAR(36) NOT NULL,
 context JSON NOT NULL, calculation JSON NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_gst_context(source_type,source_id)
);
CREATE TABLE IF NOT EXISTS gst_ledger_entries (
 id VARCHAR(36) PRIMARY KEY, snapshot_id VARCHAR(36) NOT NULL, account_id VARCHAR(36),
 tax_type VARCHAR(20) NOT NULL, amount DECIMAL(14,2) NOT NULL, direction ENUM('debit','credit') NOT NULL,
 UNIQUE KEY uq_gst_ledger(snapshot_id,tax_type,direction)
);
CREATE TABLE IF NOT EXISTS audit_events (
 id VARCHAR(36) PRIMARY KEY, actor_id VARCHAR(36), action VARCHAR(100) NOT NULL,
 entity_type VARCHAR(60) NOT NULL, entity_id VARCHAR(36), payload JSON, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
 INDEX idx_audit_entity(entity_type,entity_id,created_at)
);
