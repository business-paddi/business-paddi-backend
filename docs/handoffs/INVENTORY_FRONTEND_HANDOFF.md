# Inventory and sales API integration handoff

Implement the frontend migration described here. Inspect the existing inventory service, controller/layout, checkout, receipt, analytics, account-preferences, authenticated API client, refresh coordination, and query hooks first. Update those flows rather than building a second implementation. Retain the existing route map, project styling, persistent inventory layout, and independently stable product IDs.

## Authentication and scope

Local API origin: `http://localhost:5000`. Use the application's configured origin in other environments. Every path below starts with `/api`. `B` means `/api/businesses/:businessId/inventory`.

Use the existing API client with cookie credentials (`withCredentials: true` or `credentials: "include"`), not a separate bearer-token/auth layer. The accessToken cookie, valid session, active account, and verified email are required. Browser origins must match the backend's configured FRONTEND_URL; mutations reject an explicitly disallowed Origin. Send `Content-Type: application/json` for JSON requests. No new reauthentication is required for inventory or sidebar display changes.

Every inventory operation checks active business membership and effective permissions, including denied permissions. The server derives actor ID/name and business scope. Do not submit actor fields, client-calculated totals, currency overrides, stock balances, receipt numbers, or audit identities. Unknown DTO fields are rejected.

GET responses and authenticated writes use `Cache-Control: no-store`. All timestamps are UTC ISO strings. Query keys must include businessId; cart keys also include userId. Clear user-scoped caches on logout/account switch.

## Explicit permissions

| Permission | Operations |
| --- | --- |
| `inventory:view` | Summary, category/product lists, product/barcode details, movements, price history, shortage history |
| `inventory:manage` | Create/edit/delete categories, create/edit products |
| `inventory:receive` | Receive stock |
| `inventory:checkout` | Read/save personal cart, quote, complete sale |
| `inventory:sales:view` | Sales list and saved receipt detail |
| `inventory:report` | Analytics |

Owner/admin default grants include all six permissions. Finance manager defaults include view, checkout, sales:view, report. Accountant defaults include view, sales:view, report. Other system roles do not automatically receive inventory grants. Existing custom-role denials remain authoritative. Use effective workspace grants, not role labels, to enable controls. Refresh membership/role queries after the backend migration.

The summary includes `access: { canManageCatalogue, canReceive, canCheckout, canReport }`. These flags supplement the existing membership effectivePermissions; they do not override backend authorization. Forbidden operations return 403.

## Common conventions

- Stable opaque IDs. A product's ID/URL does not change when moved to another category.
- Money uses **integer NGN minor units (kobo)**. `100` means ₦1.00. This differs from existing employee-payroll decimal-string fields. Convert the current inventory naira values at the adapter boundary; validate conversion instead of sending fractional kobo.
- Unit purchase/selling prices: integer 0–1,000,000,000,000 kobo. Stock balances, thresholds, and individual line/receipt quantities are at most 1,000,000. Total amounts must stay within JavaScript's safe integer range. Amount overflow is rejected.
- Quantities are whole units; fractional stock is rejected. `packageWeightGrams` is an optional integer >= 0, max 2,147,483,647. Null means unrecorded; never derive weight from volume.
- Product cost/stock valuation uses the latest stored unit purchase cost, not FIFO or weighted-average cost. Saved sale lines preserve the cost at checkout.
- Collections return `{ items, nextCursor, total }`. Default limit is 25, maximum 100. `total` counts all matching records before cursor slicing. Pass nextCursor back unchanged with the same filters/sort. Reset cursor on filter/sort changes. No offset/page-number query.
- Mutations return resource envelopes and revision. Stock-changing mutations also return `balances` and `movementIds`. DELETE category is the 204 exception.
- Revisions start at 1; an absent cart has revision 0. Use JSON `expectedRevision` or `If-Match: "<revision>"` for edits/cart writes. If both are supplied, they must agree. Missing revision: 428; stale revision: 409. The service never replaces an edit's revision silently.
- GET product returns `{ product }`; use `product.revision` on the next edit. No ETag is required.
- GETs do not inject fixtures or create business inventory. An empty server response is authoritative.

## Cloudinary images: frontend-owned uploads

The frontend already has the Cloudinary integration details. Implement uploads through that existing integration, validate the selected file there (PNG/JPEG/WebP, at most 1 MiB), and await the successful upload. Then send **only the resulting HTTPS `secure_url` string as `imageUrl`** in product creation/edit requests.

- There is **no backend multipart `POST B/product-images` endpoint**. It was intentionally omitted following the agreed Cloudinary flow.
- Do not send file bytes, multipart bodies, base64, blob URLs, cloud API secrets, or browser-local file paths to product endpoints.
- `imageUrl` supports HTTPS URLs up to 2,000 characters; `null` clears it on PATCH. Omitted means keep existing value.
- The inventory backend validates the URL, stores the string, and never fetches the image or verifies Cloudinary asset metadata. File/type/size checks and Cloudinary ownership belong to the upload integration.
- Use the existing Cloudinary preset/signing workflow. Never introduce Cloudinary API secrets into client code. Do not delete a currently used asset before its replacement product save succeeds.

## Catalogue and category endpoints

### GET B/summary

Optional `categoryId`. Response:

```ts
{
  productCount: number; categoryCount: number; units: number;
  stockCostValueMinor: number; lowStockCount: number; outOfStockCount: number;
  currency: "NGN"; empty: boolean; needsFirstCategory: boolean;
  access: { canManageCatalogue: boolean; canReceive: boolean; canCheckout: boolean; canReport: boolean };
}
```

When `needsFirstCategory`, show **Add your first category**. If categories exist but no products, show the first-product flow. Low-stock excludes zero-stock; out-of-stock is separate.

### GET B/categories

Query: `search`, `cursor`, `limit`. Sorted by case-normalized name then ID ascending.

```ts
type Category = {
  id: string; businessId: string; name: string; description: string | null;
  revision: number; createdAt: string; updatedAt: string;
  productCount: number; units: number; stockCostValueMinor: number;
};
// Response: { items: Category[]; nextCursor: string | null; total: number }
```

### POST B/categories

Body `{ name: string, description?: string | null }`; name is trimmed/nonempty, max 100 characters; description max 2,000. Names are case-insensitively unique within the business. Returns 201 `{ category: Category, revision: number }`.

### PATCH B/categories/:categoryId

Body `{ name?: string, description?: string | null, expectedRevision?: number }` plus If-Match if not supplying expectedRevision. At least one editable field is required. Returns `{ category: Category, revision }`. Category ID stays stable; renaming does not move products.

### DELETE B/categories/:categoryId

Use `If-Match: "<revision>"`, or `?expectedRevision=<revision>`. No request body. Returns 204 only if empty. Nonempty: 409 `CATEGORY_NOT_EMPTY`. Foreign/missing category: 404. Products must be moved to an existing category before deletion.

### GET B/products

Query: `search` over name/barcode/SKU, `categoryId`, `stockStatus=in_stock|low_stock|out_of_stock`, `sort`, `cursor`, `limit`.

Supported sort values: `name_asc` (default), `name_desc`, `createdAt_asc`, `createdAt_desc`, `sellingPriceMinor_asc`, `sellingPriceMinor_desc`, `availableQuantity_asc`, `availableQuantity_desc`. Every ordering includes ID as a stable tie-breaker.

```ts
type Product = {
  id: string; businessId: string; categoryId: string;
  category: { id: string; name: string };
  name: string; barcode: string | null; sku: string | null;
  description: string | null; imageUrl: string | null;
  packageWeightGrams: number | null;
  purchaseCostMinor: number; sellingPriceMinor: number;
  availableQuantity: number; lowStockThreshold: number;
  stockStatus: "in_stock" | "low_stock" | "out_of_stock";
  currency: "NGN"; revision: number; createdAt: string; updatedAt: string;
};
// Response: { items: Product[]; nextCursor: string | null; total: number }
```

### GET B/products/by-barcode?barcode=000123

Exact string match in the business, preserving leading zeros. URL-encode the barcode. Returns `{ product: Product }` with current balance/prices. A miss is 404 `BARCODE_NOT_FOUND`; never interpret it as an empty success. Barcode max 100 characters.

### GET B/products/:productId

Returns `{ product: Product }`, tenant-scoped. Missing/foreign product: 404 `PRODUCT_NOT_FOUND`.

### POST B/products

```ts
{
  categoryId: string; name: string;
  purchaseCostMinor: number; sellingPriceMinor: number;
  openingUnits?: number; // default 0
  lowStockThreshold?: number; // default 0
  barcode?: string | null; sku?: string | null;
  description?: string | null; packageWeightGrams?: number | null;
  imageUrl?: string | null;
}
```

Category must already exist in this business. Product name max 200 characters; barcode/SKU max 100; description max 2,000. Omit optional barcode/SKU or use null; an empty string is invalid. A supplied barcode is unique per business. Atomic product creation writes the opening-stock movement even for zero units, and initializes shortage history if appropriate. Returns 201:

```ts
{
  product: Product; revision: number;
  balances: { productId: string; availableQuantity: number; revision: number }[];
  movementIds: string[];
}
```

### PATCH B/products/:productId

Editable fields: categoryId, name, barcode, sku, description, packageWeightGrams, imageUrl, purchaseCostMinor, sellingPriceMinor, lowStockThreshold. All are optional. Send expectedRevision/If-Match. Optional `reason` max 2,000 characters becomes the edit movement note. **Do not send availableQuantity, openingUnits, stockStatus, currency, or actor fields.**

Nullable optional fields can be cleared with null. A changed category must be an existing category in this business. Returns `{ product: Product, revision, movementIds }`. A no-op returns the current revision and an empty movementIds array. Actual changes increment revision and append structured before/after history atomically.

## Receiving and audit/history

### POST B/products/:productId/receipts

Required header `Idempotency-Key`: 16–80 letters/digits/underscores/hyphens. Keep the same key for retries of the same logical request.

Body `{ quantity: positiveInteger, purchaseCostMinor: integer, supplier?: string, reference?: string, note?: string }`. Supplier/reference max 200; note max 2,000. Receiving increases balance and replaces the current unit purchase cost, with an immutable receipt and movement in the same transaction.

Returns 201 `{ receipt, product: Product, revision, balances, movementIds }`. Receipt fields: `id, businessId, productId, actorId, quantity, purchaseCostMinor, supplier|null, reference|null, note|null, createdAt, revision:1`.

### GET B/movements

Query: productId, action (`opening|receive|sale|edit|category`), search (summary/actor/reference/note), from, to, sort (`occurredAt_desc` default or `occurredAt_asc`), cursor, limit.

```ts
type Movement = {
  id: string; businessId: string; productId: string | null; categoryId: string | null;
  actorId: string; actorName: string; occurredAt: string;
  action: "opening" | "receive" | "sale" | "edit" | "category";
  summary: string; quantityDelta: number;
  quantityBefore: number | null; quantityAfter: number | null;
  purchaseCostBeforeMinor: number | null; purchaseCostAfterMinor: number | null;
  sellingPriceBeforeMinor: number | null; sellingPriceAfterMinor: number | null;
  thresholdBefore: number | null; thresholdAfter: number | null;
  reference: string | null; note: string | null;
  saleId: string | null; receiptId: string | null;
  priceChanged: boolean; changes: Record<string, unknown>;
};
// Response: { items: Movement[], nextCursor, total }
```

Product edit changes map field names to `{ before, after }`. Stock entries include quantity and cost snapshots. Category entries retain category ID/name even after empty-category deletion. Movement, receipt, sale, and sale-line records are append-only at the database level. No audit deletion endpoint or automatic pruning is implemented.

### GET B/products/:productId/price-history

Same date/cursor/limit/chronological-sort conventions. Returns movements where a real selling/cost change occurred (including receiving cost changes). Initial prices are in the opening movement; no invented earlier history. Use action/note to display source/reason and actorName for the historical actor display.

### GET B/products/:productId/shortages

Query from/to/cursor/limit. Returns:

```ts
{
  items: { id: string; businessId: string; productId: string;
    classification: "low_stock" | "out_of_stock"; threshold: number;
    minimumStock: number; startedAt: string; endedAt: string | null }[];
  nextCursor: string | null; total: number;
  historyStartsAt: string; timezone: "Africa/Lagos";
}
```

Newest start first, then ID. History begins when the backend product was created. Intervals use the **historical threshold** captured when opened. Positive balance <= threshold is low stock; zero is out of stock. Crossing classification or changing threshold closes the previous segment and starts a new applicable one; receiving above threshold closes it. Ongoing intervals have endedAt=null. Date filters return intervals overlapping `[from,to)` with original start/end, not clipped bounds. Do not derive historical intervals against the current threshold anymore.

## Saved cart and checkout

Cart is scoped to the authenticated user and business, not a register. Multiple tabs/devices for the same user share one draft. Different users have different drafts. There are no stock reservations.

### GET B/cart

Returns `{ cart: { businessId, userId, lines: { productId, quantity }[], revision, updatedAt } }`. An absent draft is an empty cart with revision=0 and updatedAt=null. GET does not create it. Prices/balances must come from fresh product data/quotes, not persisted cart metadata.

### PUT B/cart

Body `{ lines: [{ productId, quantity }], expectedRevision }`, or If-Match instead of the body revision. Empty lines are allowed; max 100 distinct products; quantities are positive whole units. Each product must belong to the business. Optional expectedSellingPriceMinor is tolerated on input lines but is not persisted in the draft.

Returns `{ cart, revision }`. Validating a draft does not deduct/reserve stock or guarantee checkout stock. On revision conflicts, fetch the server draft and reconcile rather than blindly overwriting.

### POST B/sales/quote

Body `{ lines: [{ productId, quantity, expectedSellingPriceMinor? }] }`, 1–100 distinct products. Supply the price currently shown by the frontend in expectedSellingPriceMinor to detect changes.

```ts
type QuoteLine = {
  productId: string; quantity: number; productName: string;
  categoryId: string; categoryName: string; barcode: string | null; sku: string | null;
  sellingPriceMinor: number; purchaseCostMinor: number; revision: number;
  availableQuantity: number; totalMinor: number; totalCostMinor: number;
  priceChanged: boolean; sufficientStock: boolean;
};
// 201 response:
{
  quote: { id: string; businessId: string; userId: string;
    lines: QuoteLine[]; totalMinor: number; currency: "NGN";
    revision: 1; cartRevision: number; createdAt: string; expiresAt: string;
    usedAt: string | null; canComplete: boolean; pricesChanged: boolean };
  revision: 1;
}
```

Quotes expire in five minutes, belong to the user/business, and capture the current cart revision. They do not reserve stock. Show changed prices for review; block completion if canComplete=false. Persist the final cart before quoting. If the user edits the cart after quoting, requote.

### POST B/sales

Required Idempotency-Key as above. Body:

```ts
{
  lines: { productId: string; quantity: number }[];
  quoteId: string; quoteRevision: 1;
  paymentMethod: "cash" | "transfer" | "card";
  tenderMinor?: number; // required for cash, >= total
  paymentConfirmed?: boolean; // true required for transfer/card
  customerName?: string; customerContact?: string; // max 200 each
}
```

Use exactly the quoted product IDs/quantities. Do not submit browser-calculated totals/line prices. The server locks products, checks stock, quote revision/expiry, current product revisions/prices/costs/category names, and saved cart revision. It creates the immutable sale and lines, deducts stock, appends movements, updates shortage intervals, consumes the quote, and clears the draft in one transaction.

Cash requires sufficient tender and calculates change. Transfer/card are **manually confirmed**, not verified gateway settlement. Do not label them gateway-verified.

Returns 201 `{ sale: Sale & { lines: SaleLine[] }, revision:1, balances, movementIds, cart }`.

```ts
type Sale = {
  id: string; businessId: string; number: string; businessName: string;
  actorId: string; actorName: string; occurredAt: string;
  paymentMethod: "cash" | "transfer" | "card";
  paymentStatus: "cash_received" | "manually_confirmed";
  customerName: string | null; customerContact: string | null;
  currency: "NGN"; totalMinor: number; totalCostMinor: number;
  tenderMinor: number | null; changeMinor: number; units: number; revision:1;
};
type SaleLine = {
  id: string; businessId: string; saleId: string; productId: string;
  productName: string; categoryId: string; categoryName: string;
  barcode: string | null; sku: string | null; quantity: number;
  sellingPriceMinor: number; purchaseCostMinor: number;
  totalMinor: number; totalCostMinor: number;
};
```

Receipt numbers have the shape `BP-YYYYMMDD-<uppercase UUID without dashes>` and are unique, not gap-free/sequential. Render receipts from sale snapshots; never replace product/category names or prices with today's catalogue values.

Idempotency keys are business-scoped and tied to the user, operation, target, and normalized request payload. Same key/same request returns the original committed response even after quote consumption/expiry. Same key/different request returns 409 IDEMPOTENCY_CONFLICT. Keys for receiving and sales must be different. A failed transaction does not consume a key. Replays return the original balance/cart snapshot; refetch current balances/draft after a retry when needed.

### GET B/sales

Query search (number/customer/actor/historical product name), paymentMethod, from, to, sort (`occurredAt_desc` default or `occurredAt_asc`), cursor, limit. Response `{ items: Sale[], nextCursor, total }`; lines are fetched through receipt detail.

### GET B/sales/:saleId

Response `{ sale: Sale & { lines: SaleLine[] } }`. Scoped ID; missing/foreign receipt: 404 SALE_NOT_FOUND. This remains unchanged after catalogue edits.

## Analytics and dates

### GET B/analytics

Use `period=today|7d|30d` (default 30d), or a from/to pair with optional productId/categoryId. Do not combine period with dates. Explicit range must span at most 366 days. Use UTC ISO timestamps; from inclusive, to exclusive. Period boundaries use Africa/Lagos midnight (UTC+01:00), independent of the browser timezone. Default periods include the current Lagos day. For example, Lagos Oct 11 spans `2026-10-10T23:00:00Z` through `2026-10-11T23:00:00Z`.

```ts
{
  currency: "NGN"; timezone: "Africa/Lagos"; from: string; to: string;
  revenueMinor: number; totalCostMinor: number; grossProfitMinor: number;
  saleCount: number; units: number; averageSaleMinor: number;
  daily: { date: string; revenueMinor: number; grossProfitMinor: number; units: number; saleCount: number }[];
  topProducts: { productId: string; name: string; units: number; revenueMinor: number; grossProfitMinor: number }[];
  categoryRevenue: { categoryId: string; name: string; revenueMinor: number; units: number }[];
  restock: Product[]; restockLimit: 100;
}
```

Daily points are zero-filled YYYY-MM-DD Lagos dates. Revenue/profit use immutable sales lines; filtered reports count distinct sales containing the matching lines and average the filtered revenue per matching sale. AverageSaleMinor is rounded to whole kobo. Category filters refer to historical sale categories, not the current product category. Restock is current inventory <= its threshold, capped at 100 and filtered by current product/category. Names in historical aggregation are snapshots; IDs are authoritative. Partial explicit days include only sales inside the requested time bounds.

## Sidebar preferences

`GET /api/account/preferences` returns:

```ts
{
  desktopNotifications: boolean; twoFactorEnabled: boolean; sidebarMinimized: boolean;
  onboarding: { useCases: string[]; usage: string | null; referralSource: string | null;
    referralDetails: string | null; completedAt: string | null };
}
```

`PATCH /api/account/preferences` with `{ sidebarMinimized: boolean }` returns the same shape. Omitted preferences stay unchanged; new/existing users default false. This display setting does not require a password or reauthToken. Existing two-factor changes retain their existing reauthentication requirements. `/api/account/me` and public preference responses also include sidebarMinimized. Use the per-user setting for both personal/business sidebars and stop treating browser storage as authoritative after hydration.

## Error contract and frontend states

Inventory errors: `{ statusCode, code, message, fieldErrors }`. message may be a validation-message array; fieldErrors is a keyed object for domain field errors (otherwise empty). All business scope/permission checks apply even on retries.

| Status/code | Frontend action |
| --- | --- |
| 400 VALIDATION_ERROR | Show validation messages; do not retry unchanged input |
| 400 CATEGORY_REQUIRED | Require an existing business category |
| 409 CATEGORY_EXISTS / BARCODE_EXISTS | Show duplicate field feedback |
| 409 CATEGORY_NOT_EMPTY | Require moving products first |
| 428 REVISION_REQUIRED | Fix request to include a revision |
| 409 REVISION_CONFLICT | Refetch/reconcile/requote; do not silently overwrite |
| 409 INSUFFICIENT_STOCK | Refresh balance and adjust cart |
| 409 PAYMENT_NOT_CONFIRMED | Require manual transfer/card confirmation |
| 400 INSUFFICIENT_TENDER | Increase cash tender |
| 409 QUOTE_EXPIRED / QUOTE_MISMATCH | Request/review a new quote |
| 409 IDEMPOTENCY_CONFLICT | Do not reuse a key for another payload |
| 400 IDEMPOTENCY_KEY_REQUIRED | Generate and retain a valid request key |
| 400 INVALID_CURSOR / INVALID_SORT / INVALID_PERIOD | Reset/fix query parameters |
| 400 AMOUNT_OUT_OF_RANGE / QUANTITY_OUT_OF_RANGE | Reduce unsupported amount/quantity |
| 401 UNAUTHORIZED | Use existing coordinated refresh/login behavior |
| 403 FORBIDDEN | Show permission state and disable the action |
| 404 PRODUCT_NOT_FOUND / BARCODE_NOT_FOUND / SALE_NOT_FOUND | Show a scoped missing-record state |

No partial stock mutations commit on sale/receiving failure. Disable duplicate submit buttons while pending, but still use idempotency because network retries/tab duplication can happen. Preserve cart/UI state during errors. Retry network failures with the exact original payload/key. Do not issue a new sale key until the original result has been resolved.

## Frontend migration checklist

1. Inspect existing `src/features/inventory/service.ts`, shared inventory layout/controller, all existing routes, checkout/review/receipt flows, analytics, and account preference integration. Search for every local-storage inventory adapter/fixture use and update those paths.
2. Replace synchronous calls with the project's async query/mutation hooks and shared authenticated API client. Add loading, empty, permission-denied, validation, conflict, retry, and error states. Consume server cursors and filters.
3. Server data determines onboarding. Do not inject fixtures on empty/error/loading. Do not silently import `business-paddi:inventory:v1:*` records; any future trial-data import must be explicit and reviewed. Remove fixture generation and browser inventory keys from the active flow.
4. Preserve URL-driven navigation and stable product URLs. Keep cart/dialog state in the shared inventory layout, but hydrate/synchronize the draft from the server using revisions.
5. Upload through Cloudinary first and pass only secure_url as imageUrl. Use the frontend's existing Cloudinary details. No inventory backend image upload route exists.
6. Before checkout, save/reconcile the draft and get a fresh quote. Show changed prices, insufficient balances and quote expiry. Require review before completing; submit quote ID/revision, matching lines, payment details, and retained idempotency key.
7. After catalogue/category writes invalidate business-scoped products, categories, summary, movements, price/shortage history, and analytics/restock as applicable. After receive/sale also invalidate affected details, cart/quotes, sales/receipts, and analytics. Never update another business's cache.
8. There is no push event/SSE/WebSocket inventory channel yet. Poll active catalogue/checkout balances approximately every 15 seconds and refetch on window focus/reconnect; always requote before completion. Backend locking/rechecks are authoritative even between polls.
9. Render saved receipts from server sale snapshots. Keep manually confirmed transfer/card separate from gateway settlement.
10. Connect sidebarMinimized to account preferences, preserving other settings and existing security/refresh behavior.
11. Verify empty onboarding, category requirements/deletion conflicts, product category moves, leading-zero barcode lookup, Cloudinary URLs, concurrent tills, retries, draft conflicts, historical receipt stability, shortage transitions, Lagos daily totals, and cross-device draft/preference hydration.

## Backend verification and setup

The migration is applied to the configured development database. The Prisma client and backend build are generated. For another environment, deploy the committed migration before using these endpoints.

Local startup uses `npm run start:dev` on port 5000. Keep the configured Redis service running; the backend waits for Redis during startup.

Migration: `prisma/migrations/20261011190000_inventory_sales/migration.sql`. It creates inventory tables, numeric/tenant constraints, append-only history guards, partial unique ongoing-shortage constraint, sidebarMinimized, and inventory permission/default role grants. It also extends the closed permission catalog and existing system-role permission guard with the intended inventory grants while preserving grant immutability. Deploy it before frontend integration and regenerate the Prisma client.

`npm run db:test:inventory` exercises real transactions and concurrent tills in a uniquely named temporary schema and removes that schema afterwards. It never imports browser fixtures or modifies public inventory. Existing authenticated test accounts can create an empty business via the existing onboarding flow; do not invent persistent credentials. Contract examples in this handoff are schemas, not authoritative fixture data.
