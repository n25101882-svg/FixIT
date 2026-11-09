-- Initial MVP schema, generated with Prisma migrate diff and extended with
-- PostgreSQL constraints/triggers that Prisma's schema DSL cannot express.
BEGIN;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('ADMIN', 'CLIENT', 'MASTER');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('PENDING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(254) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "role" "user_role" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "city" VARCHAR(100) NOT NULL,
    "bio" TEXT,
    "is_approved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "master_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "master_profile_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "category" VARCHAR(80) NOT NULL,
    "description" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "price_at_order_cents" INTEGER NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "master_profiles_user_id_key" ON "master_profiles"("user_id");

-- CreateIndex
CREATE INDEX "services_master_profile_id_idx" ON "services"("master_profile_id");

-- CreateIndex
CREATE INDEX "services_category_is_active_idx" ON "services"("category", "is_active");

-- CreateIndex
CREATE INDEX "orders_client_id_created_at_idx" ON "orders"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_service_id_idx" ON "orders"("service_id");

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");

-- AddForeignKey
ALTER TABLE "master_profiles" ADD CONSTRAINT "master_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_master_profile_id_fkey" FOREIGN KEY ("master_profile_id") REFERENCES "master_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Business invariants that must also hold for direct SQL writes.
ALTER TABLE "users" ADD CONSTRAINT "users_email_canonical_check"
  CHECK ("email" = lower(btrim("email")));
ALTER TABLE "services" ADD CONSTRAINT "services_price_cents_check"
  CHECK ("price_cents" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_price_at_order_cents_check"
  CHECK ("price_at_order_cents" >= 0);

CREATE FUNCTION "fixit_require_master_role"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE linked_role public.user_role;
BEGIN
  -- SHARE conflicts with a concurrent role UPDATE; the FK checks existence.
  SELECT "role" INTO linked_role FROM public.users WHERE "id" = NEW."user_id" FOR SHARE;
  IF FOUND AND linked_role <> 'MASTER'::public.user_role THEN
    RAISE EXCEPTION 'A master profile requires a MASTER user'
      USING ERRCODE = '23514', CONSTRAINT = 'master_profiles_user_role_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "master_profiles_require_master_role"
BEFORE INSERT OR UPDATE OF "user_id" ON "master_profiles"
FOR EACH ROW EXECUTE FUNCTION "fixit_require_master_role"();

CREATE FUNCTION "fixit_require_client_role"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE linked_role public.user_role;
BEGIN
  SELECT "role" INTO linked_role FROM public.users WHERE "id" = NEW."client_id" FOR SHARE;
  IF FOUND AND linked_role <> 'CLIENT'::public.user_role THEN
    RAISE EXCEPTION 'An order requires a CLIENT user'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_client_role_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "orders_require_client_role"
BEFORE INSERT OR UPDATE OF "client_id" ON "orders"
FOR EACH ROW EXECUTE FUNCTION "fixit_require_client_role"();

CREATE FUNCTION "fixit_protect_user_role"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."role" <> 'MASTER'::public.user_role
     AND EXISTS (SELECT 1 FROM public.master_profiles WHERE "user_id" = OLD."id") THEN
    RAISE EXCEPTION 'Cannot change the role of a user with a master profile'
      USING ERRCODE = '23514', CONSTRAINT = 'users_master_profile_role_check';
  END IF;
  IF NEW."role" <> 'CLIENT'::public.user_role
     AND EXISTS (SELECT 1 FROM public.orders WHERE "client_id" = OLD."id") THEN
    RAISE EXCEPTION 'Cannot change the role of a user with client orders'
      USING ERRCODE = '23514', CONSTRAINT = 'users_client_orders_role_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "users_protect_linked_role"
BEFORE UPDATE OF "role" ON "users"
FOR EACH ROW WHEN (OLD."role" IS DISTINCT FROM NEW."role")
EXECUTE FUNCTION "fixit_protect_user_role"();

COMMIT;
