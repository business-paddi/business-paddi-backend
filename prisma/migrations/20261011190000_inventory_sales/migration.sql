BEGIN;
-- AlterTable
ALTER TABLE "UserPreference" ADD COLUMN     "sidebarMinimized" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "InventoryCategory" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "nameKey" VARCHAR(100) NOT NULL,
    "description" VARCHAR(2000),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InventoryCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryProduct" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "barcode" VARCHAR(100),
    "sku" VARCHAR(100),
    "description" VARCHAR(2000),
    "imageUrl" VARCHAR(2000),
    "packageWeightGrams" INTEGER,
    "purchaseCostMinor" BIGINT NOT NULL,
    "sellingPriceMinor" BIGINT NOT NULL,
    "availableQuantity" INTEGER NOT NULL DEFAULT 0,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InventoryProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT,
    "categoryId" TEXT,
    "actorId" TEXT NOT NULL,
    "actorName" VARCHAR(200) NOT NULL,
    "action" VARCHAR(20) NOT NULL,
    "summary" VARCHAR(500) NOT NULL,
    "quantityDelta" INTEGER NOT NULL DEFAULT 0,
    "quantityBefore" INTEGER,
    "quantityAfter" INTEGER,
    "purchaseCostBeforeMinor" BIGINT,
    "purchaseCostAfterMinor" BIGINT,
    "sellingPriceBeforeMinor" BIGINT,
    "sellingPriceAfterMinor" BIGINT,
    "thresholdBefore" INTEGER,
    "thresholdAfter" INTEGER,
    "reference" VARCHAR(200),
    "note" VARCHAR(2000),
    "saleId" TEXT,
    "receiptId" TEXT,
    "changes" JSONB NOT NULL,
    "priceChanged" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryShortage" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "classification" VARCHAR(20) NOT NULL,
    "threshold" INTEGER NOT NULL,
    "minimumStock" INTEGER NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),

    CONSTRAINT "InventoryShortage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryCart" (
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InventoryCart_pkey" PRIMARY KEY ("businessId","userId")
);

-- CreateTable
CREATE TABLE "InventoryQuote" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "cartRevision" INTEGER NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryReceipt" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "purchaseCostMinor" BIGINT NOT NULL,
    "supplier" VARCHAR(200),
    "reference" VARCHAR(200),
    "note" VARCHAR(2000),
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "InventoryReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventorySale" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "number" VARCHAR(100) NOT NULL,
    "businessName" VARCHAR(100) NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" VARCHAR(200) NOT NULL,
    "paymentMethod" VARCHAR(20) NOT NULL,
    "paymentStatus" VARCHAR(30) NOT NULL,
    "customerName" VARCHAR(200),
    "customerContact" VARCHAR(200),
    "currency" CHAR(3) NOT NULL DEFAULT 'NGN',
    "totalMinor" BIGINT NOT NULL,
    "totalCostMinor" BIGINT NOT NULL,
    "tenderMinor" BIGINT,
    "changeMinor" BIGINT NOT NULL,
    "units" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventorySale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventorySaleLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" VARCHAR(200) NOT NULL,
    "categoryId" TEXT NOT NULL,
    "categoryName" VARCHAR(100) NOT NULL,
    "barcode" TEXT,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "sellingPriceMinor" BIGINT NOT NULL,
    "purchaseCostMinor" BIGINT NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "totalCostMinor" BIGINT NOT NULL,

    CONSTRAINT "InventorySaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryOperation" (
    "businessId" TEXT NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" VARCHAR(200) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryOperation_pkey" PRIMARY KEY ("businessId","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCategory_businessId_id_key" ON "InventoryCategory"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCategory_businessId_nameKey_key" ON "InventoryCategory"("businessId", "nameKey");

-- CreateIndex
CREATE INDEX "InventoryProduct_businessId_categoryId_idx" ON "InventoryProduct"("businessId", "categoryId");

-- CreateIndex
CREATE INDEX "InventoryProduct_businessId_createdAt_id_idx" ON "InventoryProduct"("businessId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryProduct_businessId_id_key" ON "InventoryProduct"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryProduct_businessId_barcode_key" ON "InventoryProduct"("businessId", "barcode");

-- CreateIndex
CREATE INDEX "InventoryMovement_businessId_occurredAt_id_idx" ON "InventoryMovement"("businessId", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "InventoryMovement_businessId_productId_occurredAt_id_idx" ON "InventoryMovement"("businessId", "productId", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "InventoryShortage_businessId_productId_startedAt_id_idx" ON "InventoryShortage"("businessId", "productId", "startedAt", "id");

-- CreateIndex
CREATE INDEX "InventoryQuote_businessId_userId_expiresAt_idx" ON "InventoryQuote"("businessId", "userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "InventorySale_number_key" ON "InventorySale"("number");

-- CreateIndex
CREATE INDEX "InventorySale_businessId_occurredAt_id_idx" ON "InventorySale"("businessId", "occurredAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventorySale_businessId_id_key" ON "InventorySale"("businessId", "id");

-- CreateIndex
CREATE INDEX "InventorySaleLine_businessId_productId_idx" ON "InventorySaleLine"("businessId", "productId");

-- AddForeignKey
ALTER TABLE "InventoryCategory" ADD CONSTRAINT "InventoryCategory_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryProduct" ADD CONSTRAINT "InventoryProduct_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryProduct" ADD CONSTRAINT "InventoryProduct_businessId_categoryId_fkey" FOREIGN KEY ("businessId", "categoryId") REFERENCES "InventoryCategory"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_businessId_productId_fkey" FOREIGN KEY ("businessId", "productId") REFERENCES "InventoryProduct"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryShortage" ADD CONSTRAINT "InventoryShortage_businessId_productId_fkey" FOREIGN KEY ("businessId", "productId") REFERENCES "InventoryProduct"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCart" ADD CONSTRAINT "InventoryCart_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCart" ADD CONSTRAINT "InventoryCart_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryQuote" ADD CONSTRAINT "InventoryQuote_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryQuote" ADD CONSTRAINT "InventoryQuote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReceipt" ADD CONSTRAINT "InventoryReceipt_businessId_productId_fkey" FOREIGN KEY ("businessId", "productId") REFERENCES "InventoryProduct"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventorySale" ADD CONSTRAINT "InventorySale_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventorySaleLine" ADD CONSTRAINT "InventorySaleLine_businessId_saleId_fkey" FOREIGN KEY ("businessId", "saleId") REFERENCES "InventorySale"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventorySaleLine" ADD CONSTRAINT "InventorySaleLine_businessId_productId_fkey" FOREIGN KEY ("businessId", "productId") REFERENCES "InventoryProduct"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryOperation" ADD CONSTRAINT "InventoryOperation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Numeric/domain constraints also protect writes outside the API.
ALTER TABLE "InventoryCategory" ADD CONSTRAINT "InventoryCategory_name_check" CHECK (length(btrim("name")) > 0 AND "nameKey" = lower(btrim("name")) AND "revision" > 0);
ALTER TABLE "InventoryProduct" ADD CONSTRAINT "InventoryProduct_values_check" CHECK (
  length(btrim("name")) > 0 AND "availableQuantity" BETWEEN 0 AND 1000000 AND "lowStockThreshold" BETWEEN 0 AND 1000000 AND
  "purchaseCostMinor" BETWEEN 0 AND 1000000000000 AND "sellingPriceMinor" BETWEEN 0 AND 1000000000000 AND
  ("packageWeightGrams" IS NULL OR "packageWeightGrams" >= 0) AND "revision" > 0 AND ("barcode" IS NULL OR length(btrim("barcode")) > 0));
ALTER TABLE "InventoryReceipt" ADD CONSTRAINT "InventoryReceipt_values_check" CHECK ("quantity" BETWEEN 1 AND 1000000 AND "purchaseCostMinor" BETWEEN 0 AND 1000000000000 AND "revision" = 1);
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_action_check" CHECK ("action" IN ('opening','receive','sale','edit','category') AND ("quantityBefore" IS NULL OR "quantityBefore" >= 0) AND ("quantityAfter" IS NULL OR "quantityAfter" >= 0));
ALTER TABLE "InventoryShortage" ADD CONSTRAINT "InventoryShortage_values_check" CHECK ("classification" IN ('low_stock','out_of_stock') AND "threshold" >= 0 AND "minimumStock" >= 0 AND ("endedAt" IS NULL OR "endedAt" >= "startedAt"));
CREATE UNIQUE INDEX "InventoryShortage_one_open_key" ON "InventoryShortage" ("businessId","productId") WHERE "endedAt" IS NULL;
ALTER TABLE "InventoryCart" ADD CONSTRAINT "InventoryCart_values_check" CHECK (jsonb_typeof("lines") = 'array' AND "revision" > 0);
ALTER TABLE "InventoryQuote" ADD CONSTRAINT "InventoryQuote_values_check" CHECK ("totalMinor" BETWEEN 0 AND 9007199254740991 AND "revision" = 1 AND "cartRevision" >= 0 AND jsonb_typeof("lines") = 'array');
ALTER TABLE "InventorySale" ADD CONSTRAINT "InventorySale_values_check" CHECK (
  "currency" = 'NGN' AND "paymentMethod" IN ('cash','transfer','card') AND "revision" = 1 AND "units" > 0 AND
  "totalMinor" BETWEEN 0 AND 9007199254740991 AND "totalCostMinor" BETWEEN 0 AND 9007199254740991 AND "changeMinor" >= 0 AND
  (("paymentMethod" = 'cash' AND "paymentStatus" = 'cash_received' AND "tenderMinor" IS NOT NULL AND "tenderMinor" >= "totalMinor" AND "changeMinor" = "tenderMinor" - "totalMinor") OR
   ("paymentMethod" <> 'cash' AND "paymentStatus" = 'manually_confirmed' AND "tenderMinor" IS NULL AND "changeMinor" = 0)));
ALTER TABLE "InventorySaleLine" ADD CONSTRAINT "InventorySaleLine_values_check" CHECK ("quantity" BETWEEN 1 AND 1000000 AND "sellingPriceMinor" >= 0 AND "purchaseCostMinor" >= 0 AND "totalMinor" = "quantity"::bigint * "sellingPriceMinor" AND "totalCostMinor" = "quantity"::bigint * "purchaseCostMinor");
CREATE FUNCTION reject_inventory_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Inventory history is append-only' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER "InventoryMovement_immutable" BEFORE UPDATE OR DELETE ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION reject_inventory_history_mutation();
CREATE TRIGGER "InventorySale_immutable" BEFORE UPDATE OR DELETE ON "InventorySale" FOR EACH ROW EXECUTE FUNCTION reject_inventory_history_mutation();
CREATE TRIGGER "InventorySaleLine_immutable" BEFORE UPDATE OR DELETE ON "InventorySaleLine" FOR EACH ROW EXECUTE FUNCTION reject_inventory_history_mutation();
CREATE TRIGGER "InventoryReceipt_immutable" BEFORE UPDATE OR DELETE ON "InventoryReceipt" FOR EACH ROW EXECUTE FUNCTION reject_inventory_history_mutation();
CREATE TRIGGER "InventoryOperation_immutable" BEFORE UPDATE OR DELETE ON "InventoryOperation" FOR EACH ROW EXECUTE FUNCTION reject_inventory_history_mutation();

-- Extend the closed permission catalog with the six inventory keys.
ALTER TABLE "Permission" DROP CONSTRAINT "Permission_catalog_check";
ALTER TABLE "Permission" ADD CONSTRAINT "Permission_catalog_check" CHECK ("key" IN ('inventory:view','inventory:manage','inventory:receive','inventory:checkout','inventory:sales:view','inventory:report','business:update','members:invite','members:remove','members:update_role','members:update_status','members:view','roles:view','roles:create','roles:update','roles:delete','roles:assign','payments:create','payments:view','payments:view_own','payments:approve','payments:cancel','providers:create','providers:update','providers:view','invoices:create','employee_lists:create','employee_lists:view','employee_lists:update','employee_lists:archive','employees:create','employees:view','employees:update','employees:archive','employees:verify','invoices:view','reports:view','audit_logs:view','employees:view_own','policies:view','policies:create','policies:update','policies:archive','policies:assign','policies:view_audit','policies:reconcile','integrations:view','integrations:manage'));
-- Extend the existing immutable system-permission guard for inventory grants.
CREATE OR REPLACE FUNCTION protect_system_permissions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assigned "Role"%ROWTYPE; previous "Role"%ROWTYPE;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    SELECT * INTO previous FROM "Role" WHERE "id"=OLD."roleId";
    IF previous."type"='system' THEN RAISE EXCEPTION 'System permission assignments cannot be edited or removed'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  SELECT * INTO assigned FROM "Role" WHERE "id"=NEW."roleId";
  IF assigned."type"='system' THEN
    IF TG_TABLE_NAME='RoleDeniedPermission' THEN RAISE EXCEPTION 'System roles have no explicit denials'; END IF;
    IF NOT ((NEW."permission" IN ('inventory:view','inventory:manage','inventory:receive','inventory:checkout','inventory:sales:view','inventory:report') AND (assigned."key" IN ('owner','admin') OR (assigned."key"='finance_manager' AND NEW."permission" IN ('inventory:view','inventory:checkout','inventory:sales:view','inventory:report')) OR (assigned."key"='accountant' AND NEW."permission" IN ('inventory:view','inventory:sales:view','inventory:report')))) OR (assigned."key"='owner' AND NEW."permission" IN ('business:update','members:invite','members:remove','members:update_role','members:update_status','members:view','roles:view','roles:create','roles:update','roles:delete','roles:assign','payments:create','payments:view','payments:view_own','payments:approve','payments:cancel','providers:create','providers:update','providers:view','invoices:create','employee_lists:create','employee_lists:view','employee_lists:update','employee_lists:archive','employees:create','employees:view','employees:update','employees:archive','employees:verify','invoices:view','reports:view','audit_logs:view','employees:view_own','policies:view','policies:create','policies:update','policies:archive','policies:assign','policies:view_audit','policies:reconcile','integrations:view','integrations:manage')) OR (assigned."key"='admin' AND NEW."permission" IN ('members:invite','members:view','members:update_status','payments:create','payments:approve','payments:view','providers:create','providers:update','invoices:create','invoices:view','reports:view','audit_logs:view','employee_lists:create','employee_lists:view','employee_lists:update','employee_lists:archive','employees:create','employees:view','employees:update','employees:archive','employees:verify','integrations:view','integrations:manage')) OR (assigned."key"='finance_manager' AND NEW."permission" IN ('payments:create','payments:approve','payments:view','providers:create','invoices:create','invoices:view','reports:view','employee_lists:create','employee_lists:view','employee_lists:update','employees:create','employees:view','employees:update','employees:verify','members:view')) OR (assigned."key"='accountant' AND NEW."permission" IN ('payments:view','invoices:view','reports:view','members:view','employee_lists:view','employees:view')) OR (assigned."key"='employee' AND NEW."permission" IN ('employees:view_own','members:view','employee_lists:view','reports:view')) OR (assigned."key"='contributor' AND NEW."permission" IN ('payments:create','members:view','payments:view_own')) OR (assigned."key"='viewer' AND NEW."permission" IN ('payments:view','invoices:view','members:view','reports:view'))) THEN RAISE EXCEPTION 'Permission is not granted to this system role'; END IF;
  END IF;
  RETURN NEW;
END $$;
INSERT INTO "Permission" ("key") VALUES ('inventory:view'),('inventory:manage'),('inventory:receive'),('inventory:checkout'),('inventory:sales:view'),('inventory:report') ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT r."id", p."key" FROM "Role" r CROSS JOIN "Permission" p
WHERE r."type" = 'system' AND r."status" = 'active' AND p."key" LIKE 'inventory:%' AND (
  r."key" IN ('owner','admin') OR
  (r."key" = 'finance_manager' AND p."key" IN ('inventory:view','inventory:checkout','inventory:sales:view','inventory:report')) OR
  (r."key" = 'accountant' AND p."key" IN ('inventory:view','inventory:sales:view','inventory:report'))
) ON CONFLICT DO NOTHING;
COMMIT;
