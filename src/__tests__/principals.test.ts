/**
 * Workspace ADR 0004 for this service: who may write, and who is on the record.
 *
 * Every write route (create, update, archive) is called by every kind of
 * principal that can reach it: a signed-in person, the same person by a
 * read-only API token and by a write token, an agent of that person (write and
 * read-only), an organization's key (write and read-only), a service, and a
 * credential of another organization. Each is allowed or refused, a refused
 * write stores nothing, and for each allowed one the stored event's `actor` and
 * whole `metadata.audit` are read back raw and asserted.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FoldBase } from '@baseworks/foldbase'
import { signHs256Jwt } from '@baseworks/auth/jwt'
import { JWT_SECRET, bootTestFoldBase, fakeOrgService, makeServiceToken, makeTestApp, makeToken, newOrgId, type TestFoldBase } from './setup.js'

type App = Awaited<ReturnType<typeof makeTestApp>>
type Ev = { type: string; actor?: string; payload: Record<string, any>; metadata?: { audit?: Record<string, unknown> }; correlationId?: string }

let fb: TestFoldBase
let app: App
let orgId: string
let other: string
let restoreOrg: () => void
let reqN = 0
const USER = 'u-ada'

beforeAll(async () => { fb = await bootTestFoldBase() }, 30_000)
afterAll(async () => { await fb.stop() })
beforeEach(async () => {
  orgId = newOrgId()
  other = newOrgId()
  app = await makeTestApp(fb, orgId)
  restoreOrg = fakeOrgService({ [orgId]: 'owner', [`${orgId}|u-stranger-not-a-member`]: 'none' })
})
afterEach(() => restoreOrg())

const sign = (claims: Record<string, unknown>) => signHs256Jwt(claims as never, JWT_SECRET, 3600)
const raw = () => new FoldBase({ baseUrl: fb.base, token: fb.svcToken, tenant: orgId }).withAuth({ uid: 'catalog-service', role: 'admin' })
const stream = async (id: string) => (await raw().readStream(id)) as unknown as Ev[]
const logSize = async () => (await raw().readAll({ limit: 100_000 })).length

interface Kind {
  name: string
  token: () => string
  /** may it write? */
  writes: boolean
  actor: () => string
  audit: () => Record<string, unknown>
}
const KINDS: Kind[] = [
  { name: 'a signed-in person', writes: true, token: () => makeToken(USER), actor: () => `user:${USER}`,
    audit: () => ({ kind: 'human', actor: `user:${USER}`, actor_id: USER, via: 'session' }) },
  { name: 'the same person by a write API token', writes: true,
    token: () => sign({ sub: USER, type: 'human', kind: 'human', via: 'token', credential_id: 'tok_1', access: ['read', 'write'] }), actor: () => `user:${USER}`,
    audit: () => ({ kind: 'human', actor: `user:${USER}`, actor_id: USER, via: 'token', credential_id: 'tok_1' }) },
  { name: 'an agent of that person', writes: true,
    token: () => sign({ sub: 'agt-1', type: 'assistant', kind: 'agent', via: 'token', credential_id: 'tok_2', on_behalf_of: `user:${USER}`, actor: 'agent:dev@ada', access: ['read', 'write'] }), actor: () => 'agent:dev@ada',
    audit: () => ({ kind: 'agent', actor: 'agent:dev@ada', actor_id: 'agt-1', via: 'token', on_behalf_of: `user:${USER}`, credential_id: 'tok_2' }) },
  { name: 'an organization\'s write key', writes: true,
    token: () => sign({ sub: 'key-1', type: 'service', kind: 'machine', via: 'key', credential_id: 'key-1', org_id: orgId, role: 'member', access: ['read', 'write'] }), actor: () => `machine:key-1@${orgId}`,
    audit: () => ({ kind: 'machine', actor: `machine:key-1@${orgId}`, actor_id: 'key-1', via: 'key', credential_id: 'key-1' }) },
  { name: 'a service', writes: true, token: () => makeServiceToken('stripe-service'), actor: () => 'service:stripe-service',
    audit: () => ({ kind: 'service', actor: 'service:stripe-service', actor_id: 'stripe-service', via: 'client' }) },
]

/** Credentials that must be refused every write (they read where they may). */
const REFUSED: Array<{ name: string; token: () => string; reads: boolean }> = [
  { name: 'the same person by a read-only API token', reads: true,
    token: () => sign({ sub: USER, type: 'human', kind: 'human', via: 'token', credential_id: 'tok_1', access: ['read'] }) },
  { name: 'a read-only agent of that person', reads: true,
    token: () => sign({ sub: 'agt-1', type: 'assistant', kind: 'agent', via: 'token', on_behalf_of: `user:${USER}`, actor: 'agent:dev@ada', access: ['read'] }) },
  { name: 'an organization\'s read-only key', reads: true,
    token: () => sign({ sub: 'key-1', type: 'service', kind: 'machine', via: 'key', org_id: orgId, role: 'member', access: ['read'] }) },
  { name: 'a key of another organization (even with write)', reads: false,
    token: () => sign({ sub: 'key-9', type: 'service', kind: 'machine', via: 'key', org_id: other, role: 'owner', access: ['read', 'write'] }) },
  { name: 'a person who is not a member', reads: false, token: () => makeToken('u-stranger-not-a-member') },
]

async function call(method: string, path: string, token: string, body?: unknown, org = orgId) {
  const id = `req-audit-${String(++reqN).padStart(4, '0')}`
  const res = await app.app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Org-Id': org, 'X-Request-Id': id },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }))
  return { res, id, status: res.status }
}
const idOf = async (r: { res: Response }) => ((await r.res.clone().json()) as Record<string, any>)['product'].id as string

describe.each(KINDS)('$name', (k) => {
  const expectAudit = (ev: Ev, req: string) => {
    expect(ev.actor).toBe(k.actor())
    expect(ev.metadata?.audit).toEqual({ ...k.audit(), client: 'api', org_id: orgId, request_id: req })
    expect(ev.correlationId).toBe(req)
  }

  it('creates, updates and archives, and every event carries the envelope of its own request', async () => {
    const created = await call('POST', '/api/catalog', k.token(), { name: 'Widget', sku: 'W-1', price_cents: 500, currency: 'EUR' })
    expect(created.status).toBe(201)
    const id = await idOf(created)
    expect((await stream(id))[0]!.type).toBe('ProductCreated')
    expectAudit((await stream(id))[0]!, created.id)

    const updated = await call('PATCH', `/api/catalog/${id}`, k.token(), { name: 'Widget 2' })
    expect(updated.status).toBe(200)
    expect((await stream(id)).at(-1)!.type).toBe('ProductUpdated')
    expectAudit((await stream(id)).at(-1)!, updated.id)

    const archived = await call('DELETE', `/api/catalog/${id}`, k.token())
    expect(archived.status).toBe(204)
    expect((await stream(id)).at(-1)!.type).toBe('ProductArchived')
    expectAudit((await stream(id)).at(-1)!, archived.id)
  })

  it('reads', async () => {
    expect((await call('GET', '/api/catalog', k.token())).status).toBe(200)
  })
})

describe.each(REFUSED)('$name', (k) => {
  it('is refused every write, and the log does not move', async () => {
    const made = await call('POST', '/api/catalog', makeToken(USER), { name: 'Keep', sku: 'KEEP' })
    const id = await idOf(made)
    const before = await logSize()
    const t = k.token()
    for (const [method, path, body] of [
      ['POST', '/api/catalog', { name: 'No' }],
      ['PATCH', `/api/catalog/${id}`, { name: 'No' }],
      ['DELETE', `/api/catalog/${id}`, undefined],
    ] as const) {
      const r = await call(method, path, t, body)
      expect(r.status, `${method} ${path}`).toBe(403)
    }
    expect(await logSize()).toBe(before)
    expect((await stream(id)).map((e) => e.type)).toEqual(['ProductCreated'])
  })

  it(k.reads ? 'reads' : 'does not even read', async () => {
    expect((await call('GET', '/api/catalog', k.token())).status).toBe(k.reads ? 200 : 403)
  })
})

describe('a read-only credential is told which permission it lacks', () => {
  it('403 forbidden naming product.write', async () => {
    const r = await call('POST', '/api/catalog', REFUSED[0]!.token(), { name: 'No' })
    expect(await r.res.json()).toMatchObject({ error: 'forbidden', permission: 'product.write' })
    const d = await call('DELETE', '/api/catalog/x', REFUSED[0]!.token())
    expect(await d.res.json()).toMatchObject({ error: 'forbidden', permission: 'product.archive' })
  })
})

describe('closed by default', () => {
  it('before the manifest is registered a person is refused everything, a service is not asked', async () => {
    restoreOrg()
    restoreOrg = fakeOrgService({ [orgId]: 'owner' }, { registered: false })
    expect((await call('GET', '/api/catalog', makeToken(USER))).status).toBe(403)
    expect((await call('POST', '/api/catalog', makeToken(USER), { name: 'x' })).status).toBe(403)
  })

  it('when org-service cannot answer the permission question, the answer is 502, not yes', async () => {
    restoreOrg()
    restoreOrg = fakeOrgService({ [orgId]: 'owner' }, { permissionsDown: true })
    const before = await logSize()
    expect((await call('POST', '/api/catalog', makeToken(USER), { name: 'x' })).status).toBe(502)
    expect(await logSize()).toBe(before)
  })

  it('the permission memory is the credential\'s: a read-only token and a session of one person do not share an answer', async () => {
    process.env['CATALOG_PERMISSION_CACHE_SECONDS'] = '60'
    try {
      const cached = await makeTestApp(fb, orgId) // new access object, cache on
      const w = (token: string) => cached.app.fetch(new Request('http://localhost/api/catalog', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Org-Id': orgId }, body: JSON.stringify({ name: `p-${Math.random()}` }),
      }))
      // the read-only token asks first and is refused; the session of the same person must still be allowed
      expect((await w(REFUSED[0]!.token())).status).toBe(403)
      expect((await w(makeToken(USER))).status).toBe(201)
      // and the other way: the allowed session's answer is not lent to the read-only token
      expect((await w(REFUSED[0]!.token())).status).toBe(403)
    } finally {
      process.env['CATALOG_PERMISSION_CACHE_SECONDS'] = '0'
    }
  })
})
