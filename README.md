# catalog-service

A per-org **product / SKU catalog** capability service (ADR-010). Foldbase-backed,
org-scoped (tenant = org id), membership and permissions decided by org-service.

- **Client / CLI**: [`@baseworks/catalog`](./clients/ts) (npm).
- **Runtime**: Hono + `@baseworks/sdk` over the shared foldbase.
- **MCP tools**: `@baseworks/catalog/mcp` (`catalog_list`, `catalog_get`, `catalog_create`, `catalog_update`), for `mcp-service` to compose.

**In the local realm:** port 3009, published by the gateway at `/v1/catalog`.
From the workspace root: `just start catalog` · `just logs catalog` · `just restart catalog`.
See the workspace [README](../../README.md) for the whole map and
[AGENTS.md](../../AGENTS.md) for the rules every service here follows.

## Surfaces (workspace ADR 0003)

| Mount | What |
|---|---|
| `/api` | The API. A gateway publishes it at `/v1/catalog`, replacing the prefix. `/api/.well-known/service` and `/api/openapi.yaml` are part of it. |
| `/healthz` | Liveness, at the root, open. |
| `/ui`, `/_` | Not mounted: this service has no pages and no service-to-service routes yet. |

**Legacy aliases.** The same routes (and the manifest and the contract) are
still answered at the root (`/catalog`) and under `/v1` (`/v1/catalog`), behind
the same gates, for services given the bare address and for the gateway that
strips `/v1/catalog` without adding `/api`. They go when every caller names `/api`.

## REST surface

`Authorization: Bearer <realm token | bwt_ API token>` + `X-Org-Id: <org>`.

| Method | Path | Permission | |
|---|---|---|---|
| `GET` | `/api/catalog` | `product.read` | list (`?limit&offset`, `?sku=` for lookup) |
| `GET` | `/api/catalog/:ref` | `product.read` | by id / short_id / sku |
| `POST` | `/api/catalog` | `product.write` | create |
| `PATCH` | `/api/catalog/:ref` | `product.write` | update |
| `DELETE` | `/api/catalog/:ref` | `product.archive` | archive |

Fields are **snake_case**: `name` (required), `sku`, `description`, `category`,
**`price_cents`** (integer cents, optional list price), `currency`, `labels`,
`metadata`; an answer also carries `id`, `short_id`, `created_at`, `updated_at`.
Money is never a float; rating/plan pricing is **not** here (ADR-010 dual-price rule).

## Who may (workspace ADR 0004)

Nothing here names a role. At boot the service tells org-service what its
actions ask for (`POST /_/apps/register`, as the app `catalog`, with a service
token from auth-service), and on each request asks org-service, with the
caller's own realm token, which of them that caller may do in the organization.
A route names the action it needs; the default is refusal (until the
registration has succeeded nobody is allowed anything, and when org-service
cannot answer the request is a 502, never a yes).

| Action | Minimum role | Access | Routes |
|---|---|---|---|
| `product.read` | viewer | read | the two `GET`s |
| `product.write` | member | write | `POST`, `PATCH` |
| `product.archive` | member | write | `DELETE` |

A credential that may only read (a read-only API token, a read-only agent or
key) is never told it may write, whatever its person's role. A service token is a
plane caller acting as itself and passes without a membership (which services may do what
is not narrowed yet; ADR 0004 step 5b open point). Permission answers are
remembered per **credential** (`credentialKey(principal)`), never per person:
a person's session and their read-only token get different answers.
Nothing in this service is "person only" (no `isSession` guard).

**Audit.** Every event is emitted with `auditOf(c, { org_id })`: the event's `actor`
is the actor string (`user:<id>`, `agent:<name>@<handle>`, `machine:<key>@<org id>`,
`service:<name>`), `metadata.audit` the envelope (`kind`, `actor`, `actor_id`,
`on_behalf_of`, `via`, `credential_id`, `client`, `org_id`, `request_id`), and the
correlation id the request id. The realm token, not the raw `Authorization`
header, is what the service sends on: a `bwt_` token never travels past it.

## The org is resolved, not taken at its word

`X-Org-Id` may name an organization by id, slug or short id (ADR-042 §3) — a
console sends the id it has, a CLI that ran `use acme` sends the slug. The org
id is also the storage tenant, so using the header verbatim would give one
organization two catalogs, depending on which client wrote last.

The PDP answers with the scope it resolved, and that canonical id is what this
service stores against.

## Env

| Variable | |
|---|---|
| `FOLDBASE_SERVICE_URL` | the shared foldbase |
| `ORG_SERVICE_URL` | org-service's own address (not a gateway's): membership, permissions, registration |
| `AUTH_URL` | auth-service's API: accepts `bwt_` tokens (the exchange), verifies tokens, and issues this service's own token |
| `CATALOG_SERVICE_CLIENT_ID` | the name it registers as; default `catalog` |
| `CATALOG_SERVICE_CLIENT_SECRET` | its secret at auth-service (put `catalog:<secret>` in `AUTH_SERVICE_CLIENTS`) |
| `CATALOG_PERMISSION_CACHE_SECONDS` | how long a permission answer is kept; default 15 |
| `APP_PUBLIC_URL` | the origin it registers with org-service; default `catalog-service` |
| `PORT` | default 3000 |

A realm still on the shared `JWT_SECRET` signs this service's registration token
for itself (the legacy path).

## snake_case, and what cannot be rolled back

Data fields are snake_case on the wire, in code and in the stored event payloads
(`price_cents`, `short_id`; before 0.3: `priceCents`, `shortId`). History is not
rewritten: the log holds both spellings, and foldbase 0.5.1 reads a snake_case path
from a camelCase payload when the snake_case key is absent, so the projections fold
both. This service reads rows, not payloads, so nothing here reads a payload itself.
A body that still says `priceCents` is read the way it was meant; answers are
snake_case only.

**A release that writes snake_case cannot be rolled back**: a 0.2 service does not
read the `price_cents` and `short_id` of a 0.3 event (its projections look for the
camelCase names), so the rows come out without them. Deploy foldbase
0.5.1 or newer first.

## Deprecated names

`@baseworks/catalog` 0.3.0 keeps what 0.2 exposed, so a service that has not
moved still builds (stripe-service builds its client the old way):

- client options `baseUrl` and `orgId` beside `base_url` and `org_id`;
- on every `Product` the client returns: `shortId`, `priceCents`, `createdAt`,
  `updatedAt` beside the snake_case fields (set by the client; the service no longer
  sends them);
- inputs: `priceCents` beside `price_cents` in `create` and `update` (sent as `price_cents`).

`@baseworks/auth` 2.3.0 and `@baseworks/org` 2.7.0 still set the camelCase context
keys; catalog reads only the new names. They go when the last service has moved.

## Tests

`npx vitest run` in this directory. The e2e (`src/__tests__/e2e/realm.e2e.test.ts`)
builds the real auth, iam and org beside this service in one process (their sources
are imported from the neighbouring repositories) over one foldbase binary: a
person's session, a `bwt_` token (read-only and write), an agent and an
organization's key each call it through the real exchange.

## Run

From the workspace root: `just start catalog` (see the workspace
[README](../../README.md)). A container image is built from the monorepo root with
`Dockerfile.workspace` (`podman build -f projects/catalog-service/Dockerfile.workspace -t catalog-service:<tag> .`)
and runs the service from source with `tsx`. The local cluster manifests in `deploy/local`
do not carry this service yet; only auth, org and iam are published there.
