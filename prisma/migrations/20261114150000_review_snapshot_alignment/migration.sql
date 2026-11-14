-- Review follow-up. Earlier applied migration files remain immutable.
-- CREATE OR REPLACE protects existing orders without rewriting their content;
-- legacy backfill has already completed in the preceding Hybrid migration.
BEGIN;

ALTER TYPE category RENAME TO service_category;
ALTER TABLE services RENAME COLUMN price TO price_estimate;
ALTER TABLE services RENAME CONSTRAINT services_price_check TO services_price_estimate_check;
ALTER TABLE services ALTER COLUMN price_estimate DROP NOT NULL;
ALTER TABLE services ALTER COLUMN description DROP NOT NULL;
ALTER TABLE order_responses ALTER COLUMN proposed_price DROP NOT NULL;
ALTER TABLE orders ADD COLUMN budget decimal(10,2);
ALTER TABLE orders ADD CONSTRAINT orders_budget_check CHECK (budget >= 0 AND budget <= 99999999.99);
ALTER TABLE orders DROP CONSTRAINT orders_shape_check;
ALTER TABLE orders ADD CONSTRAINT orders_shape_check CHECK (
  (type = 'STANDARD' AND service_id IS NOT NULL AND master_profile_id IS NOT NULL
    AND budget IS NULL AND status <> 'OPEN')
  OR (type = 'CUSTOM' AND service_id IS NULL AND (
    (status IN ('OPEN','CANCELLED') AND master_profile_id IS NULL AND price_at_order IS NULL)
    OR (status IN ('ACCEPTED','IN_PROGRESS','COMPLETED','CANCELLED') AND master_profile_id IS NOT NULL))));

CREATE OR REPLACE FUNCTION fixit_guard_hybrid_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.type = 'STANDARD' AND NEW.status <> 'PENDING') OR (NEW.type = 'CUSTOM' AND NEW.status <> 'OPEN') THEN
      RAISE EXCEPTION 'Invalid initial order status' USING ERRCODE='23514';
    END IF;
    event := jsonb_build_object('status',NEW.status::text,'at',clock_timestamp(),
      'actorUserId',nullif(current_setting('fixit.actor_id',true),''),'source','database');
    NEW.status_history := jsonb_build_array(event);
  ELSE
    IF ROW(NEW.title,NEW.city,NEW.category,NEW.description,NEW.budget)
       IS DISTINCT FROM ROW(OLD.title,OLD.city,OLD.category,OLD.description,OLD.budget) THEN
      RAISE EXCEPTION 'Order content snapshots are immutable' USING ERRCODE='23514';
    END IF;
    IF ROW(NEW.id,NEW.type,NEW.client_id,NEW.service_id,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id,OLD.type,OLD.client_id,OLD.service_id,OLD.created_at) THEN
      RAISE EXCEPTION 'Order identity, type and origin are immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.status_history IS DISTINCT FROM OLD.status_history THEN
      RAISE EXCEPTION 'Order history is maintained by the database' USING ERRCODE='23514';
    END IF;
    IF ROW(NEW.master_profile_id,NEW.price_at_order) IS DISTINCT FROM ROW(OLD.master_profile_id,OLD.price_at_order) THEN
      IF NOT (OLD.type = 'CUSTOM' AND OLD.status = 'OPEN' AND OLD.master_profile_id IS NULL
          AND NEW.status = 'ACCEPTED' AND NEW.master_profile_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM order_responses r WHERE r.order_id=NEW.id
            AND r.master_profile_id=NEW.master_profile_id AND r.proposed_price IS NOT DISTINCT FROM NEW.price_at_order)) THEN
        RAISE EXCEPTION 'Invalid executor selection or immutable price snapshot' USING ERRCODE='23514';
      END IF;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT ((OLD.status='OPEN' AND NEW.status IN ('ACCEPTED','CANCELLED'))
        OR (OLD.status='PENDING' AND NEW.status IN ('ACCEPTED','CANCELLED','DECLINED'))
        OR (OLD.status='ACCEPTED' AND NEW.status IN ('IN_PROGRESS','CANCELLED'))
        OR (OLD.status='IN_PROGRESS' AND NEW.status='COMPLETED')) THEN
        RAISE EXCEPTION 'Invalid order status transition' USING ERRCODE='23514';
      END IF;
      NEW.status_history := OLD.status_history || jsonb_build_array(jsonb_build_object(
        'status',NEW.status::text,'at',clock_timestamp(),
        'actorUserId',nullif(current_setting('fixit.actor_id',true),''),'source','database'));
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

COMMIT;
