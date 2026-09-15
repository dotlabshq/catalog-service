# catalog-service

A per-org **product / SKU catalog** capability service (ADR-010). Foldbase-backed,
org-scoped (tenant = org id), membership enforced via org-service.

- **Client / CLI**: [`@baseworks/catalog`](./clients/ts) (npm).
- **Runtime**: Hono + `@baseworks/sdk` over the shared foldbase.

## REST surface

`Authorization: Bearer <identity-jwt>` + `X-Org-Id: <org>`.

| Method | Path | |
|---|---|---|
| `GET` | `/catalog` | list (`?limit&offset`, `?sku=` for lookup) |
| `GET` | `/catalog/:ref` | by id / short_id / sku |
| `POST` | `/catalog` | create |
| `PATCH` | `/catalog/:ref` | update |
| `DELETE` | `/catalog/:ref` | archive |

Fields: `name` (required), `sku`, `description`, `category`, **`priceCents`**
(integer cents, optional list price), `currency`, `labels`, `metadata`. Money is
never a float; rating/plan pricing is **not** here (ADR-010 dual-price rule).

## The org is resolved, not taken at its word

`X-Org-Id` may name an organization by id, slug or short id (ADR-042 §3) — a
console sends the id it has, a CLI that ran `use acme` sends the slug. The org
id is also the storage tenant, so using the header verbatim would give one
organization two catalogs, depending on which client wrote last.

The PDP answers with the scope it resolved, and that canonical id is what this
service stores against.

## Env

`FOLDBASE_SERVICE_URL`, `ORG_SERVICE_URL`, `JWT_SECRET`, `PORT` (default 3000).

## Run

Runs inside the local plane ([`infra/local`](../../infra/local)). Image via justfile:
`just build-docker <tag>` → `ghcr.io/dotlabshq/catalog-service:<tag>`.
