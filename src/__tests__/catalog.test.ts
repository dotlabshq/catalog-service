import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import {
  bootTestFoldBase, fakeOrgService, makeTestApp, newOrgId, type TestFoldBase,
} from './setup.js'

type App = Awaited<ReturnType<typeof makeTestApp>>
type Product = {
  id: string; short_id: string; name: string
  sku: string | null; category: string | null
  price_cents: number | null; currency: string | null
}

let fb: TestFoldBase
let app: App
let orgId: string
let restoreOrg: () => void

const json = <T>(res: Response) => res.json() as Promise<T>
const add = (body: Record<string, unknown>, o?: { token?: string; org?: string | null }) =>
  app.post('/api/catalog', body, o)

beforeAll(async () => { fb = await bootTestFoldBase() }, 30_000)
afterAll(async () => { await fb.stop() })
beforeEach(async () => {
  orgId = newOrgId()
  app = await makeTestApp(fb, orgId)
  restoreOrg = fakeOrgService({ [orgId]: 'owner' })
})
afterEach(() => restoreOrg())

// ── the two gates every request passes ───────────────────────────────────────

describe('a request needs an identity and an org', () => {
  it('no token is 401', async () => {
    expect((await app.unauth('/api/catalog')).status).toBe(401)
  })

  it('no X-Org-Id is 400, and says what to do about it', async () => {
    const res = await app.get('/api/catalog', { org: null })
    expect(res.status).toBe(400)
    expect((await json<{ error: string }>(res)).error).toBe('org_required')
  })

  it('an org the caller is not a member of is 403', async () => {
    expect((await app.get('/api/catalog', { org: 'org-somebody-elses' })).status).toBe(403)
  })
})

// ── the catalog ──────────────────────────────────────────────────────────────

describe('products', () => {
  it('adds one and reads it back by id and by short id', async () => {
    const res = await add({ name: 'Managed Postgres', sku: 'PG-SMALL', price_cents: 4900, currency: 'EUR' })
    expect(res.status).toBe(201)
    const { product } = await json<{ product: Product }>(res)
    expect(product).toMatchObject({ name: 'Managed Postgres', sku: 'PG-SMALL', price_cents: 4900 })

    for (const ref of [product.id, product.short_id]) {
      const got = await json<{ product: Product }>(await app.get(`/api/catalog/${ref}`))
      expect(got.product.id).toBe(product.id)
    }
  })

  it('lists what this org sells, and nothing another org sells', async () => {
    await add({ name: 'Ours' })
    const other = newOrgId()
    restoreOrg()
    restoreOrg = fakeOrgService({ [orgId]: 'owner', [other]: 'owner' })
    await add({ name: 'Theirs' }, { org: other })

    const ours = await json<{ products: Product[] }>(await app.get('/api/catalog'))
    expect(ours.products.map((p) => p.name)).toEqual(['Ours'])

    const theirs = await json<{ products: Product[] }>(await app.get('/api/catalog', { org: other }))
    expect(theirs.products.map((p) => p.name)).toEqual(['Theirs'])
  })

  it('refuses a second product with the same SKU', async () => {
    await add({ name: 'First', sku: 'DUP-1' })
    expect((await add({ name: 'Second', sku: 'DUP-1' })).status).toBe(409)
  })

  it('changes only the fields it is given', async () => {
    const { product } = await json<{ product: Product }>(
      await add({ name: 'Before', sku: 'KEEP-1', price_cents: 1000, currency: 'EUR' }),
    )
    const res = await app.patch(`/api/catalog/${product.short_id}`, { price_cents: 1500 })
    expect(res.status).toBe(200)

    const after = (await json<{ product: Product }>(res)).product
    expect(after.price_cents).toBe(1500)
    expect(after.sku).toBe('KEEP-1')
    expect(after.currency).toBe('EUR')
  })

  it('refuses an empty patch rather than writing an event that says nothing', async () => {
    const { product } = await json<{ product: Product }>(await add({ name: 'Thing' }))
    expect((await app.patch(`/api/catalog/${product.id}`, {})).status).toBe(400)
  })

  it('archiving takes a product out of the catalog', async () => {
    const { product } = await json<{ product: Product }>(await add({ name: 'Discontinued' }))
    expect((await app.del(`/api/catalog/${product.id}`)).status).toBe(204)

    expect((await app.get(`/api/catalog/${product.id}`)).status).toBe(404)
    const list = await json<{ products: Product[] }>(await app.get('/api/catalog'))
    expect(list.products).toHaveLength(0)
  })

  it('a product of another org is not found, not forbidden', async () => {
    const other = newOrgId()
    restoreOrg()
    restoreOrg = fakeOrgService({ [orgId]: 'owner', [other]: 'owner' })
    const { product } = await json<{ product: Product }>(await add({ name: 'Theirs' }, { org: other }))

    // 404 rather than 403: the caller is a member of the org they named, and
    // "forbidden" would confirm the id exists somewhere else.
    expect((await app.get(`/api/catalog/${product.id}`)).status).toBe(404)
  })
})

// ── one organization, one catalog ────────────────────────────────────────────

describe('the org is resolved before it is stored against', () => {
  it('a product added under a slug is found under the id, and the other way round', async () => {
    restoreOrg()
    restoreOrg = fakeOrgService({ [orgId]: 'owner' }, { aliases: { acme: orgId } })

    await add({ name: 'Added by the CLI' }, { org: 'acme' })
    const byId = await json<{ products: Product[] }>(await app.get('/api/catalog', { org: orgId }))
    expect(byId.products.map((p) => p.name)).toEqual(['Added by the CLI'])

    await add({ name: 'Added by the console' }, { org: orgId })
    const bySlug = await json<{ products: Product[] }>(await app.get('/api/catalog', { org: 'acme' }))
    expect(bySlug.products.map((p) => p.name).sort()).toEqual(['Added by the CLI', 'Added by the console'])
  })
})

// ── where the routes live ────────────────────────────────────────────────────

describe('mount paths', () => {
  it('serves the API under /api, and the same resource at the root and under the legacy /v1 prefix', async () => {
    await add({ name: 'Thing' })
    const api = await app.get('/api/catalog')
    const root = await app.get('/catalog')
    const legacy = await app.get('/v1/catalog')
    expect(api.status).toBe(200)
    const body = await api.json()
    expect(await root.json()).toEqual(body)
    expect(await legacy.json()).toEqual(body)
  })

  it('answers the manifest and the contract without a token, at /api and at the legacy root', async () => {
    for (const base of ['/api', '']) {
      const res = await app.app.fetch(new Request(`http://localhost${base}/.well-known/service`))
      expect(res.status).toBe(200)
      expect(await json<{ name: string; api_version: string }>(res)).toMatchObject({ name: 'catalog', api_version: '1.0' })
      expect((await app.app.fetch(new Request(`http://localhost${base}/openapi.yaml`))).status).toBe(200)
    }
  })

  it('/healthz is at the root, open', async () => {
    const res = await app.app.fetch(new Request('http://localhost/healthz'))
    expect(await res.json()).toEqual({ ok: true, service: 'catalog-service' })
  })

  it('a caller that still sends priceCents is read the way it meant, and is answered in snake_case', async () => {
    const res = await add({ name: 'Old caller', priceCents: 700, currency: 'EUR' })
    expect(res.status).toBe(201)
    const { product } = await json<Record<string, any>>(res)
    expect(product).toMatchObject({ price_cents: 700, currency: 'EUR' })
    expect(Object.keys(product).filter((k) => /[A-Z]/.test(k))).toEqual([])
    const patched = await json<Record<string, any>>(await app.patch(`/api/catalog/${product.id}`, { priceCents: 800 }))
    expect(patched['product'].price_cents).toBe(800)
  })
})
