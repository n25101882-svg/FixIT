-- Additive technical state only. Applied business migrations/triggers are immutable.
BEGIN;
CREATE TABLE "auth_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "token_hash" char(64) NOT NULL UNIQUE,
  "previous_token_hash" char(64),
  "generation" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" timestamptz(3) NOT NULL,
  "rotated_at" timestamptz(3),
  "revoked_at" timestamptz(3),
  "revoked_reason" varchar(16),
  CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "auth_sessions_hash_check" CHECK (token_hash ~ '^[0-9a-f]{64}$' AND (previous_token_hash IS NULL OR previous_token_hash ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "auth_sessions_generation_check" CHECK (generation >= 0 AND ((generation = 0 AND previous_token_hash IS NULL AND rotated_at IS NULL) OR (generation > 0 AND previous_token_hash IS NOT NULL AND rotated_at IS NOT NULL))),
  CONSTRAINT "auth_sessions_time_check" CHECK (expires_at > created_at AND last_used_at >= created_at AND last_used_at < expires_at AND (rotated_at IS NULL OR (rotated_at >= created_at AND rotated_at = last_used_at)) AND (revoked_at IS NULL OR revoked_at >= created_at)),
  CONSTRAINT "auth_sessions_revocation_check" CHECK ((revoked_at IS NULL AND revoked_reason IS NULL) OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL AND revoked_reason IN ('logout', 'replay', 'expired')))
);
CREATE INDEX "auth_sessions_user_id_revoked_at_idx" ON "auth_sessions"("user_id", "revoked_at");
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");
COMMIT;
