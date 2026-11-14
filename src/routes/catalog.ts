import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { requireOrg } from '@baseworks/org/hono'
import { auditOf, requireAuth } from '../lib/auth.js'
import { permit, type OrgAccess } from '../lib/org.js'
import { StoreError, type Store } from '../store.js'

const CreateSchema = z.object({
  name: z.string().min(1),
  sku: z.string().min(1).optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  price_cents: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  labels: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
})

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  sku: z.string().min(1).optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  price_cents: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  labels: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'Provide at least one field' })

/**
 * The wire is snake_case (ADR 0003). Until 0.3.0 this service spoke camelCase,
 * and callers that still do are read the way they meant: the one field that
 * changed, `priceCents`, is renamed on the way in (the new name wins when both
 * are sent). Answers are snake_case only. To be removed once no caller sends it.
 */
function renamed(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const { priceCents, ...rest } = body as Record<string, unknown>
  return priceCents !== undefined && rest['price_cents'] === undefined ? { ...rest, price_cents: priceCents } : rest
}
const body = <T extends z.ZodTypeAny>(schema: T) => zValidator('json', z.preprocess(renamed, schema) as unknown as T)

function fail(err: unknown): never {
  if (err instanceof StoreError) throw err
  throw new StoreError(500, 'internal', (err as Error).message)
}

/**
 * catalog-service routes. They are the API: app.ts mounts them under `/api`,
 * and a gateway publishes that at `/v1/catalog` by replacing the prefix
 * (workspace ADR 0003), so the service never encodes where it is published.
 *
 * Every request is:
 *   1. authenticated (`requireAuth`: session, API token, agent, key or service), then
 *   2. bound to an org via `X-Org-Id`, resolved to the canonical id and
 *      checked for membership at org-service (`requireOrg`). The org id is the
 *      foldbase tenant. Then
 *   3. allowed or refused by permission: org-service says which of this
 *      service's actions the caller may do there, and the route names the one
 *      it needs. No role is named here.
 */
export function catalogRouter(store: Store, orgBaseUrl: string, org: OrgAccess) {
  const app = new Hono()
  app.use('*', requireAuth)

  // `X-Org-Id` may carry an id, a slug or a short id (ADR-042 §3), and the org
  // id is also the storage tenant, so the header is resolved before anything
  // is stored against it: `acme` and the org's real id are one tenant.
  app.use('*', requireOrg({ base_url: orgBaseUrl }))

  const orgOf = (c: { get: (k: string) => unknown }) => c.get('org_id') as string

  app.get('/catalog', permit(org, 'product.read'), async (c) => {
    const orgId = orgOf(c)
    const sku = c.req.query('sku')
    if (sku) {
      const product = await store.getBySku(orgId, sku)
      if (!product) return c.json({ error: 'not_found', message: 'Product not found' }, 404)
      return c.json({ product })
    }
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 500)
    const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0
    return c.json({ products: await store.listProducts(orgId, { limit, offset }) })
  })

  app.get('/catalog/:ref', permit(org, 'product.read'), async (c) => {
    const product = await store.getProduct(orgOf(c), c.req.param('ref'))
    if (!product) return c.json({ error: 'not_found', message: 'Product not found' }, 404)
    return c.json({ product })
  })

  app.post('/catalog', permit(org, 'product.write'), body(CreateSchema), async (c) => {
    const product = await store.createProduct(orgOf(c), c.req.valid('json'), auditOf(c, { org_id: orgOf(c) })).catch(fail)
    return c.json({ product }, 201)
  })

  app.patch('/catalog/:ref', permit(org, 'product.write'), body(UpdateSchema), async (c) => {
    const product = await store.updateProduct(orgOf(c), c.req.param('ref'), c.req.valid('json'), auditOf(c, { org_id: orgOf(c) })).catch(fail)
    return c.json({ product })
  })

  app.delete('/catalog/:ref', permit(org, 'product.archive'), async (c) => {
    await store.archiveProduct(orgOf(c), c.req.param('ref'), auditOf(c, { org_id: orgOf(c) })).catch(fail)
    return c.body(null, 204)
  })

  return app
}
