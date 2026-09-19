ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS token_hash CHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS revoked_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS replaced_by VARCHAR(36) NULL;
CREATE INDEX idx_refresh_token_hash ON refresh_tokens (token_hash);
