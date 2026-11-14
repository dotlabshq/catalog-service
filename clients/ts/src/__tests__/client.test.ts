import { describe, expect, it } from 'vitest'
import { CatalogClient } from '../client.js'

const WIRE = { id: 'p1', short_id: 'sh1', sku: 'S', name: 'W', description: null, category: null, price_cents: 1250, currency: 'EUR', labels: [], metadata: {}, created_at: 10, updated_at: 20 }

function fake() {
  const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify({ product: WIRE, products: [WIRE] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { seen, fetchImpl }
}

describe('the client speaks snake_case and keeps the camelCase names of 0.2 as deprecated aliases', () => {
  it('options: base_url and org_id, or the deprecated baseUrl and orgId', async () => {
    for (const opts of [{ base_url: 'http://c.test/', org_id: 'org1' }, { baseUrl: 'http://c.test/', orgId: 'org1' }]) {
      const f = fake()
      await new CatalogClient({ ...opts, token: 't', fetch: f.fetchImpl }).get('sh1')
      expect(f.seen[0]!.url).toBe('http://c.test/catalog/sh1')
      expect(f.seen[0]!.headers['X-Org-Id']).toBe('org1')
      expect(f.seen[0]!.headers['Authorization']).toBe('Bearer t')
    }
    expect(() => new CatalogClient({})).toThrow(/base_url/)
  })

  it('withOrg scopes to another org under either option name', async () => {
    const f = fake()
    await new CatalogClient({ baseUrl: 'http://c.test', orgId: 'a', fetch: f.fetchImpl }).withOrg('b').list()
    expect(f.seen[0]!.headers['X-Org-Id']).toBe('b')
  })

  it('a product has the wire names and, deprecated, the old ones', async () => {
    const f = fake()
    const c = new CatalogClient({ base_url: 'http://c.test', fetch: f.fetchImpl })
    for (const p of [await c.get('x'), (await c.list())[0]!, await c.getBySku('S')]) {
      expect(p).toMatchObject({ short_id: 'sh1', price_cents: 1250, created_at: 10, updated_at: 20 })
      expect(p).toMatchObject({ shortId: 'sh1', priceCents: 1250, createdAt: 10, updatedAt: 20 })
    }
  })

  it('input: price_cents goes as it is; the deprecated priceCents is sent as price_cents, and never both', async () => {
    const f = fake()
    const c = new CatalogClient({ base_url: 'http://c.test', fetch: f.fetchImpl })
    await c.create({ name: 'A', price_cents: 5 })
    await c.create({ name: 'B', priceCents: 6 })
    await c.update('x', { priceCents: 7 })
    await c.update('x', { price_cents: 8, priceCents: 9 })
    expect(f.seen.map((s) => s.body)).toEqual([{ name: 'A', price_cents: 5 }, { name: 'B', price_cents: 6 }, { price_cents: 7 }, { price_cents: 8 }])
  })
})
