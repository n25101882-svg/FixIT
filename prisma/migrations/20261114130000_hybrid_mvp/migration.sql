-- Additive evolution of the applied initial migration. Never reset/drop data.
BEGIN;

-- Refuse lossy recategorisation and invented required legacy metadata.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM services WHERE category NOT IN ('TECH_REPAIR','PLUMBING','ELECTRICAL','OTHER')) THEN
    RAISE EXCEPTION 'Hybrid migration blocked: explicitly recategorise unsupported legacy service categories before retrying';
  END IF;
  IF EXISTS (SELECT 1 FROM services WHERE btrim(title) = '')
     OR EXISTS (SELECT 1 FROM master_profiles WHERE btrim(city) = '')
     OR EXISTS (SELECT 1 FROM orders WHERE btrim(description) = '') THEN
    RAISE EXCEPTION 'Hybrid migration blocked: required legacy title/city/description is blank';
  END IF;
END $$;

CREATE TYPE category AS ENUM ('TECH_REPAIR','PLUMBING','ELECTRICAL','OTHER');
CREATE TYPE order_type AS ENUM ('STANDARD','CUSTOM');
-- Rebuild inside the transaction: ADD VALUE would require a separate COMMIT
-- before using OPEN/DECLINED, leaving a partially applied migration on failure.
CREATE TYPE order_status_hybrid AS ENUM ('OPEN','PENDING','ACCEPTED','IN_PROGRESS','COMPLETED','CANCELLED','DECLINED');
ALTER TABLE orders ALTER COLUMN status DROP DEFAULT;
ALTER TABLE orders ALTER COLUMN status TYPE order_status_hybrid USING status::text::order_status_hybrid;
DROP TYPE order_status;
ALTER TYPE order_status_hybrid RENAME TO order_status;
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'PENDING';

ALTER TABLE master_profiles RENAME COLUMN bio TO description;
ALTER TABLE master_profiles ADD COLUMN category category NOT NULL DEFAULT 'OTHER';
ALTER TABLE services ALTER COLUMN category TYPE category USING category::category;
UPDATE master_profiles m SET category = (
  SELECT min(s.category::text)::category FROM services s WHERE s.master_profile_id = m.id
) WHERE (SELECT count(DISTINCT s.category) FROM services s WHERE s.master_profile_id = m.id) = 1;

ALTER TABLE services DROP CONSTRAINT services_price_cents_check;
ALTER TABLE services RENAME COLUMN price_cents TO price;
ALTER TABLE services ALTER COLUMN price TYPE decimal(10,2) USING price::numeric / 100;
ALTER TABLE services ADD CONSTRAINT services_price_check CHECK (price >= 0 AND price <= 99999999.99);
ALTER TABLE services ADD CONSTRAINT services_title_check CHECK (btrim(title) <> '');
ALTER TABLE master_profiles ADD CONSTRAINT master_profiles_city_check CHECK (btrim(city) <> '');
ALTER TABLE services ADD CONSTRAINT services_id_master_profile_id_key UNIQUE (id, master_profile_id);

ALTER TABLE orders DROP CONSTRAINT orders_service_id_fkey;
ALTER TABLE orders DROP CONSTRAINT orders_price_at_order_cents_check;
ALTER TABLE orders RENAME COLUMN price_at_order_cents TO price_at_order;
ALTER TABLE orders ALTER COLUMN price_at_order TYPE decimal(10,2) USING price_at_order::numeric / 100;
ALTER TABLE orders ALTER COLUMN price_at_order DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN service_id DROP NOT NULL;
ALTER TABLE orders ADD COLUMN type order_type NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN master_profile_id uuid,
  ADD COLUMN title varchar(160),
  ADD COLUMN city varchar(100),
  ADD COLUMN category category,
  ADD COLUMN updated_at timestamptz(3),
  ADD COLUMN status_history jsonb;

-- Preserve IDs, descriptions, statuses, dates, ownership and the exact old price.
-- Location/title/category did not previously exist on orders: snapshot current
-- linked metadata. One observed legacy event is not a fabricated full history.
UPDATE orders o SET master_profile_id = s.master_profile_id, title = s.title,
  city = m.city, category = s.category, updated_at = clock_timestamp(),
  status_history = jsonb_build_array(jsonb_build_object(
    'status', o.status::text, 'at', clock_timestamp(), 'source', 'legacy_migration', 'legacyCreatedAt', o.created_at))
FROM services s JOIN master_profiles m ON m.id = s.master_profile_id WHERE s.id = o.service_id;
ALTER TABLE orders ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN city SET NOT NULL, ALTER COLUMN category SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL, ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN status_history SET NOT NULL, ALTER COLUMN status_history SET DEFAULT '[]'::jsonb;

ALTER TABLE orders ADD CONSTRAINT orders_price_at_order_check CHECK (price_at_order >= 0 AND price_at_order <= 99999999.99),
  ADD CONSTRAINT orders_text_check CHECK (btrim(title) <> '' AND btrim(city) <> '' AND btrim(description) <> ''),
  ADD CONSTRAINT orders_history_check CHECK (jsonb_typeof(status_history) = 'array' AND jsonb_array_length(status_history) > 0),
  ADD CONSTRAINT orders_shape_check CHECK (
    (type = 'STANDARD' AND service_id IS NOT NULL AND master_profile_id IS NOT NULL
      AND price_at_order IS NOT NULL AND status <> 'OPEN')
    OR (type = 'CUSTOM' AND service_id IS NULL AND (
      (status IN ('OPEN','CANCELLED') AND master_profile_id IS NULL AND price_at_order IS NULL)
      OR (status IN ('ACCEPTED','IN_PROGRESS','COMPLETED','CANCELLED') AND master_profile_id IS NOT NULL AND price_at_order IS NOT NULL)))) ,
  ADD CONSTRAINT orders_service_id_master_profile_id_fkey FOREIGN KEY (service_id, master_profile_id)
    REFERENCES services(id, master_profile_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT orders_master_profile_id_fkey FOREIGN KEY (master_profile_id)
    REFERENCES master_profiles(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX orders_master_profile_id_idx ON orders(master_profile_id);
CREATE INDEX orders_type_status_city_category_idx ON orders(type,status,city,category);

CREATE TABLE order_responses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  master_profile_id uuid NOT NULL,
  proposed_price decimal(10,2) NOT NULL,
  message text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT order_responses_pkey PRIMARY KEY(id),
  CONSTRAINT order_responses_order_id_master_profile_id_key UNIQUE(order_id,master_profile_id),
  CONSTRAINT order_responses_proposed_price_check CHECK(proposed_price >= 0 AND proposed_price <= 99999999.99),
  CONSTRAINT order_responses_message_check CHECK(btrim(message) <> ''),
  CONSTRAINT order_responses_order_id_fkey FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT order_responses_master_profile_id_fkey FOREIGN KEY(master_profile_id) REFERENCES master_profiles(id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX order_responses_master_profile_id_idx ON order_responses(master_profile_id);

CREATE FUNCTION fixit_guard_hybrid_order() RETURNS trigger LANGUAGE plpgsql AS $$
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
            AND r.master_profile_id=NEW.master_profile_id AND r.proposed_price=NEW.price_at_order)) THEN
        RAISE EXCEPTION 'Invalid executor selection or immutable price snapshot' USING ERRCODE='23514';
      END IF;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT ((OLD.status='OPEN' AND NEW.status IN ('ACCEPTED','CANCELLED'))
        OR (OLD.status='PENDING' AND NEW.status IN ('ACCEPTED','CANCELLED','DECLINED'))
        OR (OLD.status='ACCEPTED' AND NEW.status IN ('IN_PROGRESS','CANCELLED'))
        OR (OLD.status='IN_PROGRESS' AND NEW.status IN ('COMPLETED','CANCELLED'))) THEN
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
CREATE TRIGGER orders_guard_hybrid BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION fixit_guard_hybrid_order();

CREATE FUNCTION fixit_guard_order_response() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent orders%ROWTYPE;
BEGIN
  -- Every writer locks the parent first, serialising response creation/deletion
  -- with executor selection and closing the OPEN-order race.
  SELECT * INTO parent FROM orders WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.order_id ELSE NEW.order_id END FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order does not exist' USING ERRCODE='23503';
  END IF;
  IF TG_OP='INSERT' THEN
    IF parent.type <> 'CUSTOM' OR parent.status <> 'OPEN' OR parent.master_profile_id IS NOT NULL THEN
      RAISE EXCEPTION 'Responses require an OPEN unassigned CUSTOM order' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'Responses are immutable; one offer per master' USING ERRCODE='23514';
  END IF;
  IF parent.master_profile_id = OLD.master_profile_id THEN
    RAISE EXCEPTION 'Cannot remove the selected offer' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER order_responses_guard BEFORE INSERT OR UPDATE OR DELETE ON order_responses
  FOR EACH ROW EXECUTE FUNCTION fixit_guard_order_response();

COMMIT;
