# Bank catalogue: frontend integration

## Endpoint and authentication

`GET /api/banks` is public reference data. No access-token cookie, bearer token, business ID or permission is required. It follows the public `/api/plans` catalogue convention. Cookie credentials may be sent by the existing API client but are not required. The application's existing CORS configuration still applies.

The initial catalogue is a manually maintained snapshot of 256 entries adapted from Aurex `src/modules/paystack/bank-list.ts` on 2026-10-31. It is not a live Paystack list or a guarantee that a bank currently accepts transfers. Retrieval needs no Paystack key, network request, Redis lookup or database query. The module does not import the sibling repository at runtime.

## Queries

| Parameter  | Behaviour                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `q`        | Optional string, at most 100 characters after trimming. Case-insensitive substring search across bank name, code and slug.                              |
| `country`  | Optional string, at most 80 characters after trimming. Case-insensitive exact country name, e.g. `Nigeria`. Country codes such as `NG` are not aliases. |
| `currency` | Optional three-letter code, e.g. `NGN`; case-insensitive.                                                                                               |

Filters combine with AND. Omitted, empty and whitespace-only filters are ignored. Unsupported countries/currencies and unmatched searches return an empty list with 200. Repeated parameters, invalid types, overlong values and unknown parameters return 400. `type` is a response field, not a query parameter. There is no pagination; without filters all supported entries are returned, sorted by display name using English case-insensitive ordering, with ID as a tie-breaker. The current snapshot contains Nigerian nuban entries: 255 use NGN and one (Zenith Bank, ID `bp-bank-65`) uses USD. The two Zenith entries share code `057` and must remain separate.

## Response and unwrapping

Business Paddi currently returns controller payloads directly; there is no global `{ success, data, message }` wrapper. Preserve that existing convention: fetch JSON is `{ items }`; Axios raw response is `response.data.items`. If the shared frontend client already unwraps Axios `data`, use `result.items`, not `result.data.items`. Aurex's `{ data: banks, message, success }` envelope is not used here.

Complete response for `GET /api/banks?q=guaranty-trust-bank&country=Nigeria&currency=NGN`:

```json
{
  "items": [
    {
      "id": "bp-bank-9",
      "name": "Guaranty Trust Bank",
      "code": "058",
      "slug": "guaranty-trust-bank",
      "country": "Nigeria",
      "currency": "NGN",
      "type": "nuban"
    }
  ]
}
```

Complete response for `GET /api/banks?currency=EUR` (200):

```json
{ "items": [] }
```

Use `id` as the option/React key and preserve the selected record; display `name` and submit its `code` as a string. Never convert codes to numbers: `058` and `090629` must retain leading zeroes. Codes are not unique: the snapshot deliberately contains distinct entries sharing codes, including `057`. Do not deduplicate by code. Existing employee patch DTOs accept `bankCode` and `bankName`; when saving through that existing workflow, use the selected code and name. The catalogue ID itself is not a new employee DTO field.

Selection is local UI state. This read-only endpoint does not modify bank details, account verification, payment eligibility, or balances. It does not resolve account names or initiate payments. Existing employee update rules remain authoritative.

## Complete error examples

`GET /api/banks?currency=naira` (400):

```json
{
  "message": ["currency must be a three-letter currency code or empty"],
  "error": "Bad Request",
  "statusCode": 400
}
```

`GET /api/banks?type=nuban` (400):

```json
{
  "message": ["property type should not exist"],
  "error": "Bad Request",
  "statusCode": 400
}
```

Unexpected server error (500), using the standard Nest error response:

```json
{
  "statusCode": 500,
  "message": "Internal server error"
}
```

Validation errors can contain multiple messages; display them without relying on array order. This public endpoint has no authentication-required 401 response. No provider-specific 429/502 response is introduced because there is no provider call.

## Caching

Successful responses, including empty search results, set `Cache-Control: public, max-age=300`, consistent with `/api/plans`. Responses may be cached for five minutes by browsers/shared caches. Each complete URL/query string is a separate cache key. Validation and unexpected errors set `Cache-Control: no-store`. Express may generate an ETag through its existing settings; no custom ETag or conditional-request layer is added. Backend data stays in process memory and changes on restart/redeployment, not on a timer. Previously cached responses may retain retired entries for up to five minutes after deployment; honour normal cache expiry when refreshing a dropdown.

## Maintenance and retirement

The source of truth is `src/banks/bank-catalogue.snapshot.ts`. IDs are explicitly stored, seeded once from the source record IDs as `bp-bank-<source-id>`. They are not derived from names, codes, slugs, array order or search results. Keep an existing ID when correcting/rebranding a bank. Assign a new, never-used ID for a genuinely new record. Duplicate codes are valid and must not cause record merging.

Review additions and corrections against reliable provider information, edit the local snapshot in a PR, update its provenance comment, and run the bank tests/build. Do not fetch or overwrite the list automatically at runtime. Update the snapshot-count assertion when intentionally adding/retiring entries; retain pinned identity/code assertions. Do not change historical migrations or stored employee bank strings as part of a catalogue update.

To retire a bank, move its full record from `BANK_CATALOGUE_SNAPSHOT` to `RETIRED_BANKS` in the same file. Retired records are not returned and their IDs must never be recycled. The test suite checks identity uniqueness across active and retired records. Keep existing employee data readable; an absent dropdown option must not silently clear or replace an existing bank selection. Exposing historical entries or a retirement-status API would be a separate contract change.

## Existing functionality and compatibility

Business Paddi source inspection found no previous bank-list, Paystack or account-name-resolution endpoint. There are no compatibility aliases: use only `/api/banks`. Aurex's Paystack bank list and protected bank-account resolution routes belong to that separate application and are not copied or mounted in Business Paddi.

Business Paddi accepts manually entered account holder names in its employee payment-details workflow, but that is not provider resolution or verification. No account-resolution contract is available in this backend yet. Do not invent a request to `/api/paystack/bank-account/resolve` or treat a bank selection as verified. No employee service, verification workflow, permissions or frontend code is changed by this catalogue module.
