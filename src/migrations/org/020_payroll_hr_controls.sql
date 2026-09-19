-- Workflow persistence for payroll outputs and HR approvals.
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS approved_at DATETIME NULL;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(500) NULL;

CREATE TABLE IF NOT EXISTS payroll_overtime (
  id VARCHAR(36) PRIMARY KEY, payroll_run_id VARCHAR(36) NOT NULL,
  employee_id VARCHAR(36) NOT NULL, overtime_date DATE NOT NULL,
  hours DECIMAL(8,2) NOT NULL, hourly_rate DECIMAL(14,4) NOT NULL,
  amount DECIMAL(14,2) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'approved',
  approved_by VARCHAR(36), created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payroll_overtime(payroll_run_id,employee_id,overtime_date)
);

CREATE TABLE IF NOT EXISTS payroll_payslips (
  id VARCHAR(36) PRIMARY KEY, payroll_run_id VARCHAR(36) NOT NULL,
  employee_id VARCHAR(36) NOT NULL, payslip_number VARCHAR(80) NOT NULL,
  payload JSON NOT NULL, gross_amount DECIMAL(14,2) NOT NULL,
  deductions DECIMAL(14,2) NOT NULL, net_amount DECIMAL(14,2) NOT NULL,
  issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payroll_payslip(payroll_run_id,employee_id),
  UNIQUE KEY uq_payroll_payslip_number(payslip_number)
);
