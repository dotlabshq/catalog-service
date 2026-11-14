/**
 * The catalog tools for an MCP server (`@baseworks/mcp`), over the same typed client the CLI uses:
 * a tool is a thin wrapper over catalog-service's `/api`, so it can never do what the API would
 * refuse. `permission` is the name the service registered with org-service (`product.read`,
 * `product.write`), used to hide a tool from somebody who may not use it.
 *
 *   import { catalogTools } from '@baseworks/catalog/mcp'
 *   composeTools(catalogTools())
 *   // ctx.clients.catalog is a CatalogClient built from the realm token
 *
 * Not offered, on purpose: archiving a product (`product.archive`), which a person does.
 */
import { z } from 'zod'
import { defineTool, type McpTool } from '@baseworks/mcp'
import type { CatalogClient } from './client.js'

/** What `ctx.clients` must hold for these tools. */
export interface CatalogMcpClients { catalog: CatalogClient }

const fields = {
  name: z.string().min(1).describe('The product\'s display name.'),
  sku: z.string().min(1).describe('The organization\'s own code for it. Unique: no two products share one.'),
  description: z.string(),
  category: z.string(),
  price_cents: z.number().int().min(0).describe('List price in integer cents (12.50 is 1250). Needs `currency`.'),
  currency: z.string().length(3).describe('ISO 4217 code, e.g. EUR, USD, TRY.'),
  labels: z.array(z.string()).describe('Free labels; on update they replace the ones there.'),
  metadata: z.record(z.unknown()).describe('Free-form key/values. On update they are merged into what is there.'),
}

export function catalogTools(): McpTool<CatalogMcpClients>[] {
  return [
    defineTool({
      name: 'catalog_list',
      title: 'List or look up products',
      description:
        'Lists the organization\'s product catalog (what it sells: name, SKU, optional list price), newest first. ' +
        'Use it first whenever you need to find a product, and before creating one, to avoid a duplicate. ' +
        'Pass `sku` to look one product up by its exact SKU (returns that one, or an empty list). ' +
        'Otherwise returns up to `limit` products from `offset`; keep paging while a page comes back full. ' +
        'Returns `{ products }`. Read only. Archived products are not listed.',
      input: z.object({
        sku: fields.sku.optional().describe('An exact SKU: returns that product, or an empty list.'),
        limit: z.number().int().min(1).max(100).optional().describe('Page size, 1 to 100 (default 25).'),
        offset: z.number().int().min(0).optional().describe('How many products to skip (default 0).'),
      }),
      access: 'read',
      permission: 'product.read',
      async run(ctx: { clients: CatalogMcpClients }, a: { sku?: string; limit?: number; offset?: number }) {
        if (a.sku) {
          const found = await ctx.clients.catalog.getBySku(a.sku).catch((e: { status?: number }) => (e.status === 404 ? null : Promise.reject(e)))
          return { products: found ? [found] : [] }
        }
        return { products: await ctx.clients.catalog.list({ limit: a.limit ?? 25, offset: a.offset ?? 0 }) }
      },
    }),

    defineTool({
      name: 'catalog_get',
      title: 'Get one product',
      description:
        'Returns one product in full: name, SKU, description, category, list price (integer cents and currency; both null when it has none), labels and metadata. ' +
        '`ref` is the product\'s id, its short id, or its SKU. Use it when you already know which product you want; to find one, use catalog_list. ' +
        'Fails with `not_found` if there is no such product. Read only.',
      input: z.object({ ref: z.string().min(1).describe('The product\'s id, short id or SKU.') }),
      access: 'read',
      permission: 'product.read',
      run: async (ctx: { clients: CatalogMcpClients }, a: { ref: string }) => ({ product: await ctx.clients.catalog.get(a.ref) }),
    }),

    defineTool({
      name: 'catalog_create',
      title: 'Create a product',
      description:
        'Adds a product to the catalog and returns it. WRITES. ' +
        'Look it up with catalog_list first: nothing here prevents two products with the same name, and a duplicate `sku` is refused with `sku_taken`. ' +
        'Only `name` is required. A list price is `price_cents` (integer cents, never a decimal) together with `currency`; leave both out for no price. ' +
        'It is recorded as you, the agent acting for the person who connected you.',
      input: z.object({
        name: fields.name, sku: fields.sku.optional(), description: fields.description.optional(), category: fields.category.optional(),
        price_cents: fields.price_cents.optional(), currency: fields.currency.optional(), labels: fields.labels.optional(), metadata: fields.metadata.optional(),
      }),
      access: 'write',
      permission: 'product.write',
      run: async (ctx: { clients: CatalogMcpClients }, a: Record<string, unknown>) => ({ product: await ctx.clients.catalog.create(a as never) }),
    }),

    defineTool({
      name: 'catalog_update',
      title: 'Update a product',
      description:
        'Changes fields of an existing product and returns it. WRITES. Send only what should change; `metadata` is merged, everything else is replaced. ' +
        'A price change is `price_cents` (integer cents) and, when the product has no price yet, `currency` too. A SKU already used by another product is refused with `sku_taken`. ' +
        'Fields cannot be cleared here. `ref` is the id, short id or SKU. Fails with `not_found` if there is no such product.',
      input: z.object({
        ref: z.string().min(1).describe('The product\'s id, short id or SKU.'),
        name: fields.name.optional(), sku: fields.sku.optional(), description: fields.description.optional(), category: fields.category.optional(),
        price_cents: fields.price_cents.optional(), currency: fields.currency.optional(), labels: fields.labels.optional(), metadata: fields.metadata.optional(),
      }),
      access: 'write',
      permission: 'product.write',
      async run(ctx: { clients: CatalogMcpClients }, a: { ref: string } & Record<string, unknown>) {
        const { ref, ...patch } = a
        if (Object.keys(patch).length === 0) throw Object.assign(new Error('Send at least one field to change'), { code: 'nothing_to_update', status: 400 })
        return { product: await ctx.clients.catalog.update(ref, patch as never) }
      },
    }),
  ]
}
