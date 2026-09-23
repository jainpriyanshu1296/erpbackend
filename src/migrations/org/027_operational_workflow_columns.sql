-- Forward-only repair for columns omitted when earlier CREATE TABLE IF NOT
-- EXISTS statements encountered tables created by migrations 004 and 012.
-- No tables or legacy data are dropped. Do not execute during implementation.
ALTER TABLE purchase_requisition_items ADD COLUMN IF NOT EXISTS notes TEXT NULL;
ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS discount_percent DECIMAL(7,2) DEFAULT 0;
ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS tax_percent DECIMAL(7,2) DEFAULT 0;
ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS vendor_id VARCHAR(36) NULL;
ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS grn_id VARCHAR(36) NULL;
ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS reason TEXT NULL;
ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS notes TEXT NULL;
ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS posted_at DATETIME NULL;
ALTER TABLE purchase_return_items ADD COLUMN IF NOT EXISTS rate DECIMAL(14,2) DEFAULT 0;
ALTER TABLE sales_returns ADD COLUMN IF NOT EXISTS reason TEXT NULL;
ALTER TABLE sales_returns ADD COLUMN IF NOT EXISTS notes TEXT NULL;
ALTER TABLE sales_returns ADD COLUMN IF NOT EXISTS posted_at DATETIME NULL;
ALTER TABLE production_outputs ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'draft';
ALTER TABLE production_scrap ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'draft';
ALTER TABLE quality_ncrs ADD COLUMN IF NOT EXISTS created_at DATETIME DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS requested_at DATETIME NULL;
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS approved_at DATETIME NULL;
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS approved_by VARCHAR(36) NULL;
ALTER TABLE quotation_items ADD COLUMN IF NOT EXISTS discount_percent DECIMAL(7,2) DEFAULT 0;
ALTER TABLE quotation_items ADD COLUMN IF NOT EXISTS gst_rate DECIMAL(7,2) DEFAULT 18;
ALTER TABLE quotation_items ADD COLUMN IF NOT EXISTS amount DECIMAL(14,2) DEFAULT 0;
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS delivery_date DATE NULL;
UPDATE production_outputs po JOIN stock_effects se ON se.reference_type='production_output' AND se.reference_id=po.id SET po.status='posted' WHERE po.status='draft';
