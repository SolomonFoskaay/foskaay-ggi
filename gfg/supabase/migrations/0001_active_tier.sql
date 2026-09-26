-- S1 Active Tier: add tier columns to profiles (run once in Supabase SQL editor)
-- The client degrades gracefully to Tier 1 if these columns are missing, but the
-- buy flow + tier badge need them to persist. Run this before testing S1.
-- This is feature schema, not a security fix; keep it in-repo for recovery.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS active_tier INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS active_tier_expires_at TIMESTAMPTZ;

-- point_transactions already stores spends as negative points (reason
-- 'active_tier_purchase'); no schema change needed there.