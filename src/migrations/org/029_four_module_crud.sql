-- Additive support for draft warehouse-transfer metadata editing.
-- Stock quantities and posted movement history remain workflow-owned.
ALTER TABLE warehouse_transfers ADD COLUMN IF NOT EXISTS notes TEXT NULL;
