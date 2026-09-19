-- Normalized operational records. Government gateways remain explicit integration boundaries.
CREATE TABLE IF NOT EXISTS quality_masters (
 id VARCHAR(36) PRIMARY KEY, code VARCHAR(60) NOT NULL, name VARCHAR(200) NOT NULL,
 master_type VARCHAR(40) NOT NULL, is_active TINYINT(1) NOT NULL DEFAULT 1,
 UNIQUE KEY uq_quality_master(code,master_type)
);
CREATE TABLE IF NOT EXISTS quality_spec_versions (
 id VARCHAR(36) PRIMARY KEY, master_id VARCHAR(36) NOT NULL, version_no INT NOT NULL,
 effective_from DATE NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'draft', specification JSON NOT NULL,
 approved_by VARCHAR(36), approved_at DATETIME, UNIQUE KEY uq_quality_spec(master_id,version_no)
);
CREATE TABLE IF NOT EXISTS quality_ncrs (
 id VARCHAR(36) PRIMARY KEY, ncr_number VARCHAR(60) NOT NULL, inspection_id VARCHAR(36),
 severity VARCHAR(30) NOT NULL DEFAULT 'major', description TEXT NOT NULL, root_cause TEXT,
 corrective_action TEXT, status VARCHAR(30) NOT NULL DEFAULT 'open', owner_id VARCHAR(36),
 closed_by VARCHAR(36), closed_at DATETIME, UNIQUE KEY uq_ncr_number(ncr_number)
);
CREATE TABLE IF NOT EXISTS quality_dispositions (
 id VARCHAR(36) PRIMARY KEY, inspection_id VARCHAR(36) NOT NULL, disposition VARCHAR(30) NOT NULL,
 quantity DECIMAL(14,3) NOT NULL, warehouse_id VARCHAR(36), effect_key VARCHAR(150) NOT NULL UNIQUE,
 created_by VARCHAR(36), created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS employee_history (
 id VARCHAR(36) PRIMARY KEY, employee_id VARCHAR(36) NOT NULL, effective_date DATE NOT NULL,
 field_name VARCHAR(80) NOT NULL, old_value TEXT, new_value TEXT, changed_by VARCHAR(36),
 created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payroll_structures (
 id VARCHAR(36) PRIMARY KEY, code VARCHAR(60) NOT NULL, name VARCHAR(150) NOT NULL,
 components JSON NOT NULL, is_active TINYINT(1) DEFAULT 1, UNIQUE KEY uq_payroll_structure(code)
);
CREATE TABLE IF NOT EXISTS payroll_assignments (
 id VARCHAR(36) PRIMARY KEY, employee_id VARCHAR(36) NOT NULL, structure_id VARCHAR(36) NOT NULL,
 effective_from DATE NOT NULL, annual_ctc DECIMAL(14,2) NOT NULL DEFAULT 0, components JSON,
 UNIQUE KEY uq_payroll_assignment(employee_id,effective_from)
);
CREATE TABLE IF NOT EXISTS payroll_snapshots (
 id VARCHAR(36) PRIMARY KEY, payroll_run_id VARCHAR(36) NOT NULL, employee_id VARCHAR(36) NOT NULL,
 payload JSON NOT NULL, gross_amount DECIMAL(14,2) NOT NULL, deductions DECIMAL(14,2) NOT NULL,
 net_amount DECIMAL(14,2) NOT NULL, UNIQUE KEY uq_payroll_snapshot(payroll_run_id,employee_id)
);
CREATE TABLE IF NOT EXISTS finance_periods (
 id VARCHAR(36) PRIMARY KEY, period_key CHAR(7) NOT NULL, starts_on DATE NOT NULL, ends_on DATE NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'open', closed_by VARCHAR(36), closed_at DATETIME,
 UNIQUE KEY uq_finance_period(period_key)
);
CREATE TABLE IF NOT EXISTS finance_documents (
 id VARCHAR(36) PRIMARY KEY, document_type VARCHAR(30) NOT NULL, document_number VARCHAR(60) NOT NULL,
 party_id VARCHAR(36), document_date DATE NOT NULL, amount DECIMAL(14,2) NOT NULL DEFAULT 0,
 status VARCHAR(30) NOT NULL DEFAULT 'open', due_date DATE, UNIQUE KEY uq_finance_document(document_type,document_number)
);
CREATE TABLE IF NOT EXISTS bank_transactions (
 id VARCHAR(36) PRIMARY KEY, account_id VARCHAR(36) NOT NULL, transaction_date DATE NOT NULL,
 reference VARCHAR(120), amount DECIMAL(14,2) NOT NULL, direction VARCHAR(10) NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'unreconciled', reconciled_at DATETIME
);
CREATE TABLE IF NOT EXISTS gst_snapshots (
 id VARCHAR(36) PRIMARY KEY, source_type VARCHAR(40) NOT NULL, source_id VARCHAR(36),
 calculation JSON NOT NULL, taxable_amount DECIMAL(14,2) NOT NULL, cgst DECIMAL(14,2) NOT NULL,
 sgst DECIMAL(14,2) NOT NULL, igst DECIMAL(14,2) NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_gst_snapshot(source_type,source_id)
);
CREATE TABLE IF NOT EXISTS government_documents (
 id VARCHAR(36) PRIMARY KEY, document_type VARCHAR(30) NOT NULL, source_id VARCHAR(36) NOT NULL,
 status VARCHAR(30) NOT NULL DEFAULT 'pending', request_payload JSON, response_payload JSON,
 external_reference VARCHAR(150), last_error VARCHAR(500), UNIQUE KEY uq_gov_document(document_type,source_id)
);
