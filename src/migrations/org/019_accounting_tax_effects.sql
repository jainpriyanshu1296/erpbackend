-- Additive cross-module accounting effects. Existing journals and GST
-- snapshots remain the source of truth; source columns make posting idempotent.
ALTER TABLE finance_journals ADD COLUMN IF NOT EXISTS source_type VARCHAR(40) NULL;
ALTER TABLE finance_journals ADD COLUMN IF NOT EXISTS source_id VARCHAR(36) NULL;
ALTER TABLE finance_journals ADD UNIQUE KEY uq_finance_journal_source(source_type,source_id);
ALTER TABLE gst_context_snapshots ADD COLUMN IF NOT EXISTS journal_id VARCHAR(36) NULL;
