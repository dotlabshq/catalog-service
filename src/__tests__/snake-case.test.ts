/**
 * catalog-service 0.3: payload fields are snake_case (`price_cents`, `short_id`,
 * not `priceCents`, `shortId`). History is not rewritten, so the log holds both
 * spellings; foldbase reads a snake_case path from a camelCase payload when the
 * snake_case key is absent. Nothing in this service reads a payload itself (the
 * store reads rows), so the fallback is all there is to prove: for every event
 * type, an old-shaped event appended raw folds to the same row as a new one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FoldBase } from '@baseworks/foldbase'
import { bootTestFoldBase, fakeOrgService, makeTestApp, newOrgId, type TestFoldBase } from './setup.js'

type App = Awaited<ReturnType<typeof makeTestApp>>
let fb: TestFoldBase
let app: App
let orgId: string
let restoreOrg: () => void

beforeAll(async () => { fb = await bootTestFoldBase() }, 30_000)
afterAll(async () => { await fb.stop() })
beforeEach(async () => {
  orgId = newOrgId()
  app = await makeTestApp(fb, orgId)
  restoreOrg = fakeOrgService({ [orgId]: 'owner' })
})
afterEach(() => restoreOrg())

const json = async <T = Record<string, any>>(res: Response) => (await res.json()) as T
const raw = () => new FoldBase({ baseUrl: fb.base, token: fb.svcToken, tenant: orgId }).withAuth({ uid: 'catalog-service', role: 'admin' })
let n = 0
const uid = (p: string) => `${p}-${++n}-${Math.random().toString(36).slice(2, 8)}`
const append = (stream: string, version: number, type: string, payload: Record<string, unknown>) =>
  raw().append(stream, version, [{ type, streamId: stream, actor: 'test', payload }], { streamType: 'product' })

/** A product as an older release wrote it: camelCase. */
const OLD = (o: Record<string, unknown> = {}) => ({
  sku: '', name: 'Widget', description: '', category: '', priceCents: 0, currency: '', labels: '[]', metadata: '{}', ...o,
})
/** A product as 0.3 writes it. */
const NEW = (o: Record<string, unknown> = {}) => ({
  sku: '', name: 'Widget', description: '', category: '', price_cents: 0, currency: '', labels: '[]', metadata: '{}', ...o,
})
const view = ({ id: _i, short_id: _s, updated_at: _u, ...p }: Record<string, any>) => p
const get = async (id: string) => (await json<{ product: Record<string, any> }>(await app.get(`/api/catalog/${id}`))).product

describe('every event type folds the same in either spelling', () => {
  it('ProductCreated: price_cents and short_id', async () => {
    const a = uid('p'), b = uid('p')
    await append(a, 0, 'ProductCreated', { ...OLD({ sku: 'S-1', priceCents: 1250, currency: 'EUR' }), shortId: 'sh0001', at: 5 })
    await append(b, 0, 'ProductCreated', { ...NEW({ sku: 'S-2', price_cents: 1250, currency: 'EUR' }), short_id: 'sh0002', at: 5 })
    const ra = await get(a), rb = await get(b)
    expect(ra).toMatchObject({ short_id: 'sh0001', price_cents: 1250, currency: 'EUR', created_at: 5 })
    expect(rb).toMatchObject({ short_id: 'sh0002', price_cents: 1250, currency: 'EUR', created_at: 5 })
    expect({ ...view(ra), sku: '' }).toEqual({ ...view(rb), sku: '' })
    // found by the short id an old event gave it, and through the store the same row shape comes out
    expect((await get('sh0001')).id).toBe(a)
    const made = await json<{ product: Record<string, any> }>(await app.post('/api/catalog', { name: 'Widget', sku: 'S-3', price_cents: 1250, currency: 'EUR' }))
    expect(Object.keys(made.product).sort()).toEqual(Object.keys(ra).sort())
  })

  it('ProductUpdated: an old-shaped update, a new one through the store, then an old-shaped one again', async () => {
    const id = uid('p')
    await append(id, 0, 'ProductCreated', { ...OLD(), shortId: 'sh1', at: 1 })
    await append(id, 1, 'ProductUpdated', { ...OLD({ name: 'Widget 2', priceCents: 300, currency: 'USD' }), at: 2 })
    expect(await get(id)).toMatchObject({ name: 'Widget 2', price_cents: 300, currency: 'USD', short_id: 'sh1' })
    const res = await app.patch(`/api/catalog/${id}`, { price_cents: 450 })
    expect(res.status).toBe(200)
    expect(await get(id)).toMatchObject({ name: 'Widget 2', price_cents: 450, currency: 'USD' })
    await append(id, 3, 'ProductUpdated', { ...OLD({ name: 'Widget 4', priceCents: 460, currency: 'USD' }), at: 4 })
    expect(await get(id)).toMatchObject({ name: 'Widget 4', price_cents: 460 })
    // what the store wrote is snake_case
    const stored = (await raw().readStream(id)) as unknown as Array<{ payload: Record<string, unknown> }>
    expect(Object.keys(stored[2]!.payload).filter((k) => /[A-Z]/.test(k))).toEqual([])
  })

  it('ProductArchived: the row goes, from either shape of history', async () => {
    const a = uid('p'), b = uid('p')
    await append(a, 0, 'ProductCreated', { ...OLD(), shortId: 'sa1', at: 1 })
    await append(b, 0, 'ProductCreated', { ...NEW(), short_id: 'sb1', at: 1 })
    await append(a, 1, 'ProductArchived', {})
    await append(b, 1, 'ProductArchived', {})
    expect((await app.get(`/api/catalog/${a}`)).status).toBe(404)
    expect((await app.get(`/api/catalog/${b}`)).status).toBe(404)
  })

  it('an old-shaped product can be updated and archived through the service', async () => {
    const id = uid('p')
    await append(id, 0, 'ProductCreated', { ...OLD({ sku: 'OLD-1', priceCents: 900, currency: 'EUR' }), shortId: 'sho1', at: 1 })
    expect((await app.patch(`/api/catalog/OLD-1`, { name: 'Renamed' })).status).toBe(200)
    expect(await get(id)).toMatchObject({ name: 'Renamed', price_cents: 900, currency: 'EUR', sku: 'OLD-1' })
    expect((await app.del(`/api/catalog/${id}`)).status).toBe(204)
  })
})

// ── nothing in src still speaks the old names ────────────────────────────────
// Not read: the GraphQL schema (camelCase is that contract's own), and cli.ts, where `opts.…` names are the
// ones commander gives to `--flags`.

const here = dirname(fileURLToPath(import.meta.url))
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? (f === '__tests__' || f === 'node_modules' || f === 'dist' ? [] : walk(p)) : p.endsWith('.ts') ? [p] : []
  })

describe('the source is snake_case, and never reads the Authorization header', () => {
  const OLDNAMES = /\.(userId|orgId|orgRole|scopeId|tokenType|requestId|realmToken|shortId|priceCents|createdAt|updatedAt)\b|get\('(orgId|orgRole|scopeId|requestId|realmToken)'\)|\bAuthorization\b.*\.(header|get)|header\('Authorization'\)|header\('authorization'\)/i
  const root = resolve(here, '../..')
  const files = [...walk(resolve(here, '..')), ...walk(resolve(root, 'clients/ts/src')).filter((f) => !f.endsWith('graphql.ts') && !f.endsWith('cli.ts'))]
  it.each(files.map((f) => [f.slice(root.length + 1), f] as const))('%s', (_n, f) => {
    const hits = readFileSync(f, 'utf8').split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => OLDNAMES.test(l) && !/deprecated/.test(l))
    expect(hits).toEqual([])
  })
})
