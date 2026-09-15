import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { createOrgClient, OrgError } from '@baseworks/org'
import { requireAuth } from '../lib/auth.js'
import { StoreError, type Store } from '../store.js'

const CreateSchema = z.object({
  name: z.string().min(1),
  sku: z.string().min(1).optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  priceCents: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  labels: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
})

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  sku: z.string().min(1).optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  priceCents: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  labels: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'Provide at least one field' })

function fail(err: unknown): never {
  if (err instanceof StoreError) throw err
  throw new StoreError(500, 'internal', (err as Error).message)
}

/**
 * catalog-service routes. Every request is authenticated (identity JWT → userId),
 * bound to an org via `X-Org-Id` whose membership is verified against org-service
 * (the PDP) by forwarding the caller's token. The org id is the foldbase tenant.
 *
 * Routes live at the service ROOT. A gateway publishes the realm at
 * `/v1/catalog/...` and strips that prefix (ADR-042 §4), so the service never
 * encodes where it happens to be mounted; app.ts also mounts them under `/v1`
 * for callers that predate the gateway.
 */
export function catalogRouter(store: Store, orgBaseUrl: string) {
  const app = new Hono()
  app.use('*', requireAuth)

  app.use('*', async (c, next) => {
    // `X-Org-Id` may carry an id, a slug or a short id (ADR-042 §3), and the org
    // id is also the storage tenant — so the header is resolved before anything
    // is stored against it. Taken verbatim, `acme` and the org's real id would
    // be two separate tenants for one organization, and which one you saw would
    // depend on which client wrote last.
    const orgRef = c.req.header('X-Org-Id')
    if (!orgRef) {
      return c.json({ error: 'org_required', message: 'Missing X-Org-Id — run `use <org>` first' }, 400)
    }
    const bearer = c.req.header('Authorization')!.slice(7)
    const org = createOrgClient({ baseUrl: orgBaseUrl, token: bearer })
    try {
      const { role, via } = await org.effectiveRole(orgRef)
      if (role === 'none') return c.json({ error: 'forbidden', message: 'Not a member of this org' }, 403)
      c.set('orgId' as never, (via?.scopeId ?? orgRef) as never)
    } catch (e) {
      if (e instanceof OrgError && e.status === 404) {
        return c.json({ error: 'org_not_found', message: 'Active org does not exist — run `use <org>` with a valid org' }, 404)
      }
      return c.json({ error: 'authz_unavailable', message: (e as Error).message }, 502)
    }
    return next()
  })

  const orgOf = (c: { get: (k: string) => unknown }) => c.get('orgId') as string
  const actorOf = (c: { get: (k: string) => unknown }) => (c.get('auth') as { userId: string }).userId

  app.get('/catalog', async (c) => {
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

  app.get('/catalog/:ref', async (c) => {
    const product = await store.getProduct(orgOf(c), c.req.param('ref'))
    if (!product) return c.json({ error: 'not_found', message: 'Product not found' }, 404)
    return c.json({ product })
  })

  app.post('/catalog', zValidator('json', CreateSchema), async (c) => {
    const product = await store.createProduct(orgOf(c), c.req.valid('json'), actorOf(c)).catch(fail)
    return c.json({ product }, 201)
  })

  app.patch('/catalog/:ref', zValidator('json', UpdateSchema), async (c) => {
    const product = await store.updateProduct(orgOf(c), c.req.param('ref'), c.req.valid('json'), actorOf(c)).catch(fail)
    return c.json({ product })
  })

  app.delete('/catalog/:ref', async (c) => {
    await store.archiveProduct(orgOf(c), c.req.param('ref'), actorOf(c)).catch(fail)
    return c.body(null, 204)
  })

  return app
}
