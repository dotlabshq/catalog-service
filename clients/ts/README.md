# @baseworks/catalog

Typed client, event catalog, projections, and CLI plugin for **catalog-service** —
a per-org product / SKU directory with an optional list price. Contract-first,
versioned with the service.

```bash
pnpm add @baseworks/catalog
```

## Client

Products are **org-scoped** (`X-Org-Id` + identity token). **Money is integer
cents** — `priceCents` is the optional list price; leave it unset for no price.
(Contract/usage pricing lives in the billing core, not here — ADR-010's dual-price
rule: catalog holds the display/list price only.)

```ts
import { createCatalogClient } from '@baseworks/catalog'

const catalog = createCatalogClient({
  baseUrl: process.env.CATALOG_SERVICE_URL!,
  token:   identityJwt,
  orgId:   activeOrgId,
})

const widget = await catalog.create({
  name: 'Blue Widget',
  sku: 'WIDGET-1',
  priceCents: 1250,        // $12.50 — integer cents, never a float
  currency: 'USD',
  category: 'widgets',
  labels: ['featured'],
})

await catalog.list()              // Product[]
await catalog.get('WIDGET-1')     // by id, shortId, or sku
await catalog.update(widget.id, { priceCents: 999 })
await catalog.delete(widget.id)
```

A product with no list price has `priceCents: null` + `currency: null`. Errors throw
`CatalogError` (`.status`, `.code`, e.g. `409 sku_taken`).

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
