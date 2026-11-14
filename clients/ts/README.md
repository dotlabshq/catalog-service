# @baseworks/catalog

Typed client, event catalog, projections, and CLI plugin for **catalog-service** —
a per-org product / SKU directory with an optional list price. Contract-first,
versioned with the service.

```bash
pnpm add @baseworks/catalog
```

## Client

Products are **org-scoped** (`X-Org-Id` + identity token). **Money is integer
cents** — `price_cents` is the optional list price; leave it unset for no price.
(Contract/usage pricing lives in the billing core, not here — ADR-010's dual-price
rule: catalog holds the display/list price only.)

```ts
import { createCatalogClient } from '@baseworks/catalog'

const catalog = createCatalogClient({
  base_url: process.env.CATALOG_SERVICE_URL!,
  token:    realmToken,      // forward `c.get('realm_token')`, never the raw Authorization header
  org_id:   activeOrgId,
})

const widget = await catalog.create({
  name: 'Blue Widget',
  sku: 'WIDGET-1',
  price_cents: 1250,       // $12.50 — integer cents, never a float
  currency: 'USD',
  category: 'widgets',
  labels: ['featured'],
})

await catalog.list()              // Product[]
await catalog.get('WIDGET-1')     // by id, shortId, or sku
await catalog.update(widget.id, { price_cents: 999 })
await catalog.delete(widget.id)
```

A product with no list price has `price_cents: null` + `currency: null`. Errors throw
`CatalogError` (`.status`, `.code`, e.g. `409 sku_taken`, `403 forbidden`).

## 0.3.0: snake_case, and the names it keeps

Options and data fields are snake_case (`base_url`, `org_id`, `short_id`,
`price_cents`, `created_at`, `updated_at`), and so are the stored event payload
fields. The service answers snake_case only; **the client keeps the 0.2 names,
deprecated, so a service that has not moved still builds**:

| Deprecated | Use | Where |
|---|---|---|
| `baseUrl`, `orgId` | `base_url`, `org_id` | client options (`withOrg()` sets both) |
| `shortId`, `priceCents`, `createdAt`, `updatedAt` | `short_id`, `price_cents`, `created_at`, `updated_at` | on every `Product` the client returns (set by the client from the answer) |
| `priceCents` | `price_cents` | `create` and `update` input (sent as `price_cents`; the new name wins when both are given) |

The GraphQL module (`@baseworks/catalog/graphql`) keeps its camelCase schema; it
resolves from the aliases. They go when the last caller has moved. The wire and
the stored events cannot go back: see the service README.

## MCP tools

```ts
import { catalogTools } from '@baseworks/catalog/mcp'
import { composeTools } from '@baseworks/mcp'

composeTools(catalogTools())   // ctx.clients.catalog must be a CatalogClient built from the realm token
```

`catalog_list` (also an exact `sku` lookup), `catalog_get`, `catalog_create`,
`catalog_update`: read or write, with the permission the service registers
(`product.read`, `product.write`). Archiving is not offered. `@baseworks/mcp` is a
dependency; `@modelcontextprotocol/sdk` is an optional peer, needed only by the
server that runs the tools.

## CLI plugin

```ts
import { buildCatalogCommand } from '@baseworks/catalog/cli'

program.addCommand(buildCatalogCommand({ http, cliName: 'dtab' }))
// → dtab catalog | cat | products  (list) · create · get · update · delete · ls
//   `--price 12.50 --currency USD` converts to cents (sub-cent rejected); `-o wide`.
```

## Service integration

```ts
import { PROJECTIONS, POLICIES } from '@baseworks/catalog/projections'
import { ProductEvents } from '@baseworks/catalog/events'
```

Projection `products` → foldbase table `read_products`. Tenant = org id.

## See also

Service: `projects/catalog-service` · [ADR-010](../../../../docs/decisions/010-driptab-erp-decomposition.md).
