-- ─────────────────────────────────────────────────────────────
-- 005_manufacturing_suite.sql
-- Routing Operations, Multi-Level BOM, Job Work Sec 143 & Tally
-- ─────────────────────────────────────────────────────────────

-- 1. Shop Floor Routing / Operations
CREATE TABLE IF NOT EXISTS wo_routing_operations (
  id VARCHAR(36) PRIMARY KEY,
  wo_id VARCHAR(36) NOT NULL,
  sequence_no INT NOT NULL DEFAULT 1,
  stage_name VARCHAR(100) NOT NULL,
  description TEXT,
  machine_id VARCHAR(36),
  operator_id VARCHAR(36),
  planned_start DATETIME,
  planned_end DATETIME,
  actual_start DATETIME,
  actual_end DATETIME,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  completed_qty DECIMAL(14,3) DEFAULT 0,
  rejected_qty DECIMAL(14,3) DEFAULT 0,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_routing_wo (wo_id, sequence_no)
);

-- 2. Multi-Level / Sub-Assembly BOM columns
ALTER TABLE bom_components
  ADD COLUMN IF NOT EXISTS parent_component_id VARCHAR(36) NULL,
  ADD COLUMN IF NOT EXISTS component_type VARCHAR(30) DEFAULT 'raw_material',
  ADD COLUMN IF NOT EXISTS level INT DEFAULT 1;

-- 3. Job Work Section 143 (CGST Act) Compliance Columns
ALTER TABLE job_work_orders
  ADD COLUMN IF NOT EXISTS challan_type VARCHAR(30) DEFAULT 'inputs',
  ADD COLUMN IF NOT EXISTS dispatch_date DATE,
  ADD COLUMN IF NOT EXISTS due_date DATE,
  ADD COLUMN IF NOT EXISTS itc04_quarter VARCHAR(20),
  ADD COLUMN IF NOT EXISTS compliance_status VARCHAR(30) DEFAULT 'compliant';

-- 4. Tally Sync & Export Logs
CREATE TABLE IF NOT EXISTS tally_sync_logs (
  id VARCHAR(36) PRIMARY KEY,
  export_type VARCHAR(50) NOT NULL,
  date_from DATE,
  date_to DATE,
  record_count INT DEFAULT 0,
  file_name VARCHAR(150),
  exported_by VARCHAR(36),
  exported_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
