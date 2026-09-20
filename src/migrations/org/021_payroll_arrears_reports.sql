-- Additive payroll boundaries and report drilldown support.
CREATE TABLE IF NOT EXISTS payroll_arrears (
  id VARCHAR(36) PRIMARY KEY,
  payroll_run_id VARCHAR(36) NOT NULL,
  employee_id VARCHAR(36) NOT NULL,
  component_id VARCHAR(36) NULL,
  amount DECIMAL(14,2) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_by VARCHAR(36) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payroll_arrear(payroll_run_id,employee_id,reason)
);
ALTER TABLE payroll_snapshots ADD COLUMN IF NOT EXISTS finalized_at DATETIME NULL;
ALTER TABLE payroll_snapshots ADD COLUMN IF NOT EXISTS finalized_by VARCHAR(36) NULL;
CREATE INDEX idx_payroll_arrears_employee ON payroll_arrears(employee_id,status);
ALTER TABLE quality_ncrs ADD COLUMN IF NOT EXISTS containment_action TEXT NULL;
ALTER TABLE quality_ncrs ADD COLUMN IF NOT EXISTS verified_by VARCHAR(36) NULL;
ALTER TABLE quality_ncrs ADD COLUMN IF NOT EXISTS verified_at DATETIME NULL;
ALTER TABLE quality_dispositions ADD COLUMN IF NOT EXISTS batch_id VARCHAR(36) NULL;
ALTER TABLE quality_dispositions ADD COLUMN IF NOT EXISTS serial_id VARCHAR(36) NULL;
CREATE INDEX idx_quality_disposition_lot ON quality_dispositions(batch_id,serial_id);
CREATE TABLE IF NOT EXISTS hr_designations (
  id VARCHAR(36) PRIMARY KEY, code VARCHAR(60) NOT NULL, name VARCHAR(150) NOT NULL,
  description VARCHAR(255), is_active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_hr_designation_code(code)
);
CREATE TABLE IF NOT EXISTS hr_employment_types (
  id VARCHAR(36) PRIMARY KEY, code VARCHAR(60) NOT NULL, name VARCHAR(150) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1, UNIQUE KEY uq_hr_employment_type_code(code)
);
CREATE TABLE IF NOT EXISTS hr_document_types (
  id VARCHAR(36) PRIMARY KEY, code VARCHAR(60) NOT NULL, name VARCHAR(150) NOT NULL,
  document_sensitive TINYINT(1) NOT NULL DEFAULT 0, is_active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_hr_document_type_code(code)
);
