-- Additive quality and HR domain extensions.
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS specification_id VARCHAR(36) NULL;
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS sample_size DECIMAL(14,3) NULL;
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS sample_method VARCHAR(40) NULL;
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS accepted_qty DECIMAL(14,3) NULL;
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS rejected_qty DECIMAL(14,3) NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS department_id VARCHAR(36) NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS location_id VARCHAR(36) NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS grade_id VARCHAR(36) NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS shift_id VARCHAR(36) NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS manager_id VARCHAR(36) NULL;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS correction_status VARCHAR(30) NOT NULL DEFAULT 'pending';
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS corrected_by VARCHAR(36) NULL;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS approved_by VARCHAR(36) NULL;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS approved_at DATETIME NULL;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS notes TEXT NULL;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS leave_type VARCHAR(40) NULL;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS approved_by VARCHAR(36) NULL;

CREATE TABLE IF NOT EXISTS quality_specifications (
  id VARCHAR(36) PRIMARY KEY,
  code VARCHAR(60) NOT NULL,
  name VARCHAR(200) NOT NULL,
  specification_type VARCHAR(40) NOT NULL,
  version_no INT NOT NULL DEFAULT 1,
  effective_from DATE NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  specification JSON NOT NULL,
  approved_by VARCHAR(36),
  approved_at DATETIME,
  created_by VARCHAR(36),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_quality_specification(code, specification_type, version_no)
);

CREATE TABLE IF NOT EXISTS quality_parameters (
  id VARCHAR(36) PRIMARY KEY,
  specification_id VARCHAR(36) NOT NULL,
  parameter_code VARCHAR(60) NOT NULL,
  parameter_name VARCHAR(150) NOT NULL,
  target_value VARCHAR(50),
  upper_limit DECIMAL(14,4),
  lower_limit DECIMAL(14,4),
  unit VARCHAR(30),
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_quality_parameter(specification_id, parameter_code)
);

CREATE TABLE IF NOT EXISTS quality_sampling_plans (
  id VARCHAR(36) PRIMARY KEY,
  specification_id VARCHAR(36) NOT NULL,
  plan_code VARCHAR(60) NOT NULL,
  sample_size DECIMAL(14,3) NOT NULL DEFAULT 0,
  sampling_method VARCHAR(40) NOT NULL DEFAULT 'random',
  acceptance_level VARCHAR(40),
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_quality_sampling_plan(specification_id, plan_code)
);

CREATE TABLE IF NOT EXISTS quality_acceptance_criteria (
  id VARCHAR(36) PRIMARY KEY,
  specification_id VARCHAR(36) NOT NULL,
  criterion_code VARCHAR(60) NOT NULL,
  criterion_name VARCHAR(150) NOT NULL,
  expression VARCHAR(200),
  pass_threshold DECIMAL(14,4),
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  UNIQUE KEY uq_quality_acceptance_criterion(specification_id, criterion_code)
);

CREATE TABLE IF NOT EXISTS inspection_snapshots (
  id VARCHAR(36) PRIMARY KEY,
  inspection_id VARCHAR(36) NOT NULL,
  snapshot_version INT NOT NULL,
  payload JSON NOT NULL,
  recorded_by VARCHAR(36),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_inspection_snapshot(inspection_id, snapshot_version)
);

CREATE TABLE IF NOT EXISTS quality_ncr_events (
  id VARCHAR(36) PRIMARY KEY,
  ncr_id VARCHAR(36) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  actor_id VARCHAR(36),
  event_note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ncr_events(ncr_id, created_at)
);

CREATE TABLE IF NOT EXISTS quality_disposition_effects (
  id VARCHAR(36) PRIMARY KEY,
  disposition_id VARCHAR(36) NOT NULL,
  item_id VARCHAR(36) NOT NULL,
  warehouse_id VARCHAR(36),
  disposition VARCHAR(30) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL,
  movement_type VARCHAR(20) NOT NULL,
  source_reference VARCHAR(100),
  created_by VARCHAR(36),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_disposition_effect(disposition_id)
);

CREATE TABLE IF NOT EXISTS hr_departments (
  id VARCHAR(36) PRIMARY KEY,
  code VARCHAR(60) NOT NULL,
  name VARCHAR(150) NOT NULL,
  parent_id VARCHAR(36),
  location_id VARCHAR(36),
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_hr_department_code(code)
);

CREATE TABLE IF NOT EXISTS hr_locations (
  id VARCHAR(36) PRIMARY KEY,
  code VARCHAR(60) NOT NULL,
  name VARCHAR(150) NOT NULL,
  address TEXT,
  parent_id VARCHAR(36),
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_hr_location_code(code)
);

CREATE TABLE IF NOT EXISTS hr_grades (
  id VARCHAR(36) PRIMARY KEY,
  code VARCHAR(60) NOT NULL,
  name VARCHAR(150) NOT NULL,
  pay_band DECIMAL(14,2) DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_hr_grade_code(code)
);

CREATE TABLE IF NOT EXISTS hr_shifts (
  id VARCHAR(36) PRIMARY KEY,
  code VARCHAR(60) NOT NULL,
  name VARCHAR(150) NOT NULL,
  start_time TIME,
  end_time TIME,
  work_hours DECIMAL(5,2) DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_hr_shift_code(code)
);

CREATE TABLE IF NOT EXISTS hr_calendars (
  id VARCHAR(36) PRIMARY KEY,
  code VARCHAR(60) NOT NULL,
  year INT NOT NULL,
  calendar_type VARCHAR(40) NOT NULL DEFAULT 'annual',
  metadata JSON,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_hr_calendar(code, year)
);

CREATE TABLE IF NOT EXISTS attendance_corrections (
  id VARCHAR(36) PRIMARY KEY,
  employee_id VARCHAR(36) NOT NULL,
  attendance_date DATE NOT NULL,
  original_status VARCHAR(30) NOT NULL,
  proposed_status VARCHAR(30) NOT NULL,
  reason TEXT,
  requested_by VARCHAR(36),
  approved_by VARCHAR(36),
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  approved_at DATETIME,
  INDEX idx_attendance_correction_employee(employee_id, attendance_date)
);

CREATE TABLE IF NOT EXISTS leave_policies (
  id VARCHAR(36) PRIMARY KEY,
  employee_id VARCHAR(36),
  leave_type VARCHAR(40) NOT NULL,
  annual_days DECIMAL(7,2) NOT NULL DEFAULT 0,
  carry_forward_days DECIMAL(7,2) NOT NULL DEFAULT 0,
  max_accumulation DECIMAL(7,2) NOT NULL DEFAULT 0,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  effective_from DATE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_leave_policy(employee_id, leave_type, effective_from)
);

CREATE TABLE IF NOT EXISTS leave_accrual_rules (
  id VARCHAR(36) PRIMARY KEY,
  leave_type VARCHAR(40) NOT NULL,
  accrual_period VARCHAR(30) NOT NULL,
  accrual_days DECIMAL(7,2) NOT NULL DEFAULT 0,
  max_balance DECIMAL(7,2) NOT NULL DEFAULT 0,
  effective_from DATE NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_leave_accrual(leave_type, accrual_period, effective_from)
);

CREATE TABLE IF NOT EXISTS leave_holidays (
  id VARCHAR(36) PRIMARY KEY,
  holiday_date DATE NOT NULL,
  holiday_name VARCHAR(150) NOT NULL,
  is_recurring TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_leave_holiday_date(holiday_date, holiday_name)
);

CREATE TABLE IF NOT EXISTS leave_balances (
  id VARCHAR(36) PRIMARY KEY,
  employee_id VARCHAR(36) NOT NULL,
  leave_type VARCHAR(40) NOT NULL,
  opening_balance DECIMAL(7,2) NOT NULL DEFAULT 0,
  accrued_days DECIMAL(7,2) NOT NULL DEFAULT 0,
  used_days DECIMAL(7,2) NOT NULL DEFAULT 0,
  carry_forward_days DECIMAL(7,2) NOT NULL DEFAULT 0,
  closing_balance DECIMAL(7,2) NOT NULL DEFAULT 0,
  effective_date DATE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_leave_balance(employee_id, leave_type, effective_date)
);

CREATE TABLE IF NOT EXISTS leave_balance_transactions (
  id VARCHAR(36) PRIMARY KEY,
  employee_id VARCHAR(36) NOT NULL,
  leave_type VARCHAR(40) NOT NULL,
  transaction_type VARCHAR(20) NOT NULL,
  quantity DECIMAL(7,2) NOT NULL DEFAULT 0,
  related_reference VARCHAR(100),
  reason TEXT,
  created_by VARCHAR(36),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_leave_balance_transaction(employee_id, leave_type, created_at)
);
