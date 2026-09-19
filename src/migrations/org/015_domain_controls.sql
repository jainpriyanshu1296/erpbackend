-- Durable controls for HR, payroll, tax and reporting boundaries.
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS marked_by VARCHAR(36) NULL;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS notes VARCHAR(500) NULL;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS leave_type VARCHAR(40) NULL;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS approved_by VARCHAR(36) NULL;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS approved_by VARCHAR(36) NULL;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS approved_at DATETIME NULL;
ALTER TABLE finance_journals ADD COLUMN IF NOT EXISTS posted_at DATETIME NULL;
ALTER TABLE tax_transactions ADD COLUMN IF NOT EXISTS source_type VARCHAR(40) NULL;
ALTER TABLE tax_transactions ADD COLUMN IF NOT EXISTS source_id VARCHAR(36) NULL;
ALTER TABLE tax_transactions ADD COLUMN IF NOT EXISTS filing_period CHAR(7) NULL;
ALTER TABLE report_snapshots ADD COLUMN IF NOT EXISTS generated_at DATETIME NULL;
CREATE INDEX idx_attendance_date ON attendance(attendance_date, employee_id);
CREATE INDEX idx_leave_employee_status ON leave_requests(employee_id, status);
CREATE INDEX idx_tax_filing_period ON tax_transactions(filing_period, status);
CREATE INDEX idx_journal_date_status ON finance_journals(journal_date, status);
