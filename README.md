# catalog-service

A per-org **product / SKU catalog** capability service (ADR-010). Foldbase-backed,
org-scoped (tenant = org id), membership enforced via org-service.

- **Client / CLI**: [`@baseworks/catalog`](./clients/ts) (npm).
- **Runtime**: Hono + `@baseworks/sdk` over the shared foldbase.

## REST surface (`/v1/catalog`)

`Authorization: Bearer <identity-jwt>` + `X-Org-Id: <org>`.

| Method | Path | |
|---|---|---|
| `GET` | `/v1/catalog` | list (`?limit&offset`, `?sku=` for lookup) |
| `GET` | `/v1/catalog/:ref` | by id / short_id / sku |
| `POST` | `/v1/catalog` | create |
| `PATCH` | `/v1/catalog/:ref` | update |
| `DELETE` | `/v1/catalog/:ref` | archive |

Fields: `name` (required), `sku`, `description`, `category`, **`priceCents`**
(integer cents, optional list price), `currency`, `labels`, `metadata`. Money is
never a float; rating/plan pricing is **not** here (ADR-010 dual-price rule).

## Env

`FOLDBASE_SERVICE_URL`, `ORG_SERVICE_URL`, `JWT_SECRET`, `PORT` (default 3000).

## Run

Runs inside the local plane ([`infra/local`](../../infra/local)). Image via justfile:
`just build-docker <tag>` → `ghcr.io/dotlabshq/catalog-service:<tag>`.
