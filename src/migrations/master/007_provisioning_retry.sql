-- Persist the normalized duration needed to safely resume failed admin-created
-- organizations. Additive and intentionally not executed here.
ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS duration_months INT NULL;
