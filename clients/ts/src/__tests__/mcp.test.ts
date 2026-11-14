/** The catalog tools: names, access, permissions, inputs, what they call, what a model is told. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { composeTools, runStdio } from '@baseworks/mcp'
import { CatalogError } from '../client.js'
import { catalogTools } from '../mcp.js'

const calls: Array<[string, ...unknown[]]> = []
const fake = {
  list: async (o: unknown) => { calls.push(['list', o]); return [{ id: 'p1', name: 'Widget' }] },
  getBySku: async (sku: string) => { calls.push(['getBySku', sku]); if (sku === 'missing') throw new CatalogError(404, 'not_found', 'nope'); return { id: 'p2', sku } },
  get: async (ref: string) => { calls.push(['get', ref]); if (ref === 'gone') throw new CatalogError(404, 'not_found', 'Product not found'); return { id: 'p3', name: ref } },
  create: async (a: unknown) => { calls.push(['create', a]); return { id: 'new', ...(a as object) } },
  update: async (ref: string, a: unknown) => { calls.push(['update', ref, a]); return { id: ref, ...(a as object) } },
}

async function session(over: Partial<Parameters<typeof runStdio>[0]> = {}) {
  const [a, b] = InMemoryTransport.createLinkedPair()
  await runStdio({ tools: composeTools(catalogTools()), token: 'x.y.z', transport: a, clients: () => ({ catalog: fake }), ...over } as never)
  const client = new Client({ name: 'c', version: '1' })
  await client.connect(b)
  calls.length = 0
  return client
}
const out = (r: { content?: unknown }) => JSON.parse(((r.content as Array<{ text: string }>)[0]!).text)

describe('the tool set', () => {
  it('is <service>_<verb>, composes with itself once, and says read or write with the permission the service registered', () => {
    const tools = catalogTools()
    expect(tools.map((t) => [t.name, t.access, t.permission])).toEqual([
      ['catalog_list', 'read', 'product.read'], ['catalog_get', 'read', 'product.read'],
      ['catalog_create', 'write', 'product.write'], ['catalog_update', 'write', 'product.write'],
    ])
    expect(composeTools(tools)).toHaveLength(4)
    expect(() => composeTools(tools, catalogTools())).toThrow(/duplicate/)
  })
  it('permission names are the ones catalog-service registers', async () => {
    const { CATALOG_ACTIONS } = await import('../../../../src/lib/org.js')
    for (const t of catalogTools()) expect(Object.keys(CATALOG_ACTIONS)).toContain(t.permission)
    for (const t of catalogTools()) expect((CATALOG_ACTIONS as Record<string, { access: string }>)[t.permission]!.access).toBe(t.access)
  })
  it('descriptions are written for a model: when to use it, what it returns, what is refused', () => {
    const d = Object.fromEntries(catalogTools().map((t) => [t.name, t.description]))
    expect(d['catalog_list']).toMatch(/before creating/i)
    expect(d['catalog_get']).toMatch(/id, its short id, or its SKU/)
    expect(d['catalog_create']).toMatch(/WRITES/)
    expect(d['catalog_create']).toMatch(/sku_taken/)
    expect(d['catalog_create']).toMatch(/integer cents/)
    expect(d['catalog_update']).toMatch(/WRITES/)
    for (const t of catalogTools()) expect(t.description.length, t.name).toBeGreaterThan(120)
  })
  it('does not offer archiving', () => {
    expect(catalogTools().map((t) => t.name).join(' ')).not.toMatch(/archive|delete|remove/)
  })
})

describe('through a real MCP client', () => {
  it('lists the four tools with their schemas and read-only hints', async () => {
    const t = (await (await session()).listTools()).tools
    expect(t.map((x) => x.name)).toEqual(['catalog_list', 'catalog_get', 'catalog_create', 'catalog_update'])
    expect(t.find((x) => x.name === 'catalog_create')!.annotations).toMatchObject({ readOnlyHint: false })
    expect(t.find((x) => x.name === 'catalog_list')!.annotations).toMatchObject({ readOnlyHint: true })
    expect((t.find((x) => x.name === 'catalog_create')!.inputSchema as { required?: string[] }).required).toEqual(['name'])
  })

  it('list: a page, defaults 25 and 0; an exact sku returns that one or an empty list', async () => {
    const c = await session()
    expect(out(await c.callTool({ name: 'catalog_list', arguments: { limit: 5, offset: 10 } }))).toEqual({ products: [{ id: 'p1', name: 'Widget' }] })
    expect(calls).toEqual([['list', { limit: 5, offset: 10 }]])
    calls.length = 0
    await c.callTool({ name: 'catalog_list', arguments: {} })
    expect(calls).toEqual([['list', { limit: 25, offset: 0 }]])
    expect(out(await c.callTool({ name: 'catalog_list', arguments: { sku: 'S-1' } }))).toEqual({ products: [{ id: 'p2', sku: 'S-1' }] })
    expect(out(await c.callTool({ name: 'catalog_list', arguments: { sku: 'missing' } }))).toEqual({ products: [] })
  })
  it('list refuses a page size out of range', async () => {
    const c = await session()
    for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 }]) {
      const r = await c.callTool({ name: 'catalog_list', arguments: args }).catch((e) => e)
      expect(r instanceof Error || (r as { isError?: boolean }).isError, JSON.stringify(args)).toBeTruthy()
    }
    expect(calls).toEqual([])
  })

  it('get: by any ref; a miss is a tool error carrying the service\'s code', async () => {
    const c = await session()
    expect(out(await c.callTool({ name: 'catalog_get', arguments: { ref: 'abc' } }))).toEqual({ product: { id: 'p3', name: 'abc' } })
    const r = await c.callTool({ name: 'catalog_get', arguments: { ref: 'gone' } })
    expect(r.isError).toBe(true)
    expect(out(r)).toEqual({ error: 'not_found', status: 404, message: 'Product not found' })
  })

  it('create: only what was given reaches the client, in snake_case; unknown fields are dropped', async () => {
    const c = await session()
    const r = out(await c.callTool({ name: 'catalog_create', arguments: { name: 'W', sku: 'S', price_cents: 1250, currency: 'EUR', labels: ['a'], metadata: { k: 1 }, priceCents: 5, secret: 1 } }))
    expect(r.product).toMatchObject({ id: 'new', name: 'W' })
    expect(calls).toEqual([['create', { name: 'W', sku: 'S', price_cents: 1250, currency: 'EUR', labels: ['a'], metadata: { k: 1 } }]])
  })
  it('create refuses what the API would: no name, a decimal or negative price, a bad currency', async () => {
    const c = await session()
    for (const args of [{}, { name: '' }, { name: 'x', price_cents: 12.5 }, { name: 'x', price_cents: -1 }, { name: 'x', currency: 'EURO' }]) {
      const r = await c.callTool({ name: 'catalog_create', arguments: args }).catch((e) => e)
      expect(r instanceof Error || (r as { isError?: boolean }).isError, JSON.stringify(args)).toBeTruthy()
    }
    expect(calls).toEqual([])
  })
  it('create with a duplicate sku is the service\'s error, not ours', async () => {
    const c = await session({ clients: () => ({ catalog: { ...fake, create: async () => { throw new CatalogError(409, 'sku_taken', 'already exists') } } }) } as never)
    const r = await c.callTool({ name: 'catalog_create', arguments: { name: 'x', sku: 'e' } })
    expect(r.isError).toBe(true)
    expect(out(r)).toMatchObject({ error: 'sku_taken', status: 409 })
  })

  it('update: the ref is split from the patch; nothing to change is refused', async () => {
    const c = await session()
    expect(out(await c.callTool({ name: 'catalog_update', arguments: { ref: 'p9', price_cents: 300, currency: 'EUR' } }))).toEqual({ product: { id: 'p9', price_cents: 300, currency: 'EUR' } })
    expect(calls).toEqual([['update', 'p9', { price_cents: 300, currency: 'EUR' }]])
    calls.length = 0
    const none = await c.callTool({ name: 'catalog_update', arguments: { ref: 'p9' } })
    expect(none.isError).toBe(true)
    expect(out(none).error).toBe('nothing_to_update')
    expect(calls).toEqual([])
  })

  it('a permission reader hides what the person may not do', async () => {
    const c = await session({ permissions: async () => ['product.read'] })
    expect((await c.listTools()).tools.map((x) => x.name)).toEqual(['catalog_list', 'catalog_get'])
  })
})
