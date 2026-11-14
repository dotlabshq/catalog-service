/**
 * The realm, end to end, in one process, for catalog-service (workspace ADR 0004).
 *
 * ONE foldbase binary, and four real services built in-process: auth, iam, org
 * and catalog. A `fetch` router sends each service's base URL to its app, so
 * they call each other the way they do on a network: catalog → org, iam →
 * org, org → iam, auth → iam, and every service → auth's JWKS and
 * `/exchange-key`. The realm is ES256-only (no shared secret exists), with
 * service clients in AUTH_SERVICE_CLIENTS. Everything is generated here: no
 * `.env*` file is read, no running service or dev data is touched.
 *
 * What is NOT driven: a browser sign-in. A person "signs in" by auth-service
 * being told the identity the way it tells iam after an OIDC callback (iam
 * `/_/sync`, with a REAL service token from auth's `/api/service-token`), and
 * the session token is minted by auth-service's own mint function (the one its
 * callback uses). From there every step is a real HTTP route.
 *
 * The caches are off (role cache, permission cache, exchange memory) except
 * where a scenario is about one.
 *
 * The scenarios run in order and share the world they build.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FoldBase } from '../../../../foldbase/clients/ts/dist/index.js'
// @ts-expect-error — plain ESM helper, no types
import { bootServer, signJwt } from '../../../../foldbase/conformance/harness.mjs'
import { loadSigningKey, mint } from '@baseworks/auth/identity'
import { signHs256Jwt, parseJwtPayload } from '@baseworks/auth/jwt'
import { resetAuthExchange, resetAuthVerifier } from '@baseworks/auth/hono'
import { createApp as createAuth } from '../../../../auth-service/src/app.js'
import { mintIdentityToken } from '../../../../auth-service/src/lib/mint.js'
import { resetRealm } from '../../../../auth-service/src/lib/realm.js'
import { createApp as createIam, registerDefinitions as iamDefinitions } from '../../../../iam-service/src/app.js'
import { orgAccess as iamOrgAccess, registerWithOrg as iamRegister } from '../../../../iam-service/src/lib/org.js'
import { createApp as createOrg, registerDefinitions as orgDefinitions } from '../../../../org-service/src/app.js'
import { createApp as createCatalog, registerDefinitions as catalogDefinitions } from '../../app.js'
import { orgAccess as catalogOrgAccess } from '../../lib/org.js'

const here = dirname(fileURLToPath(import.meta.url))
const FB_SECRET = 'e2e-foldbase-secret-generated-in-test!'
const ISSUER = 'https://auth.e2e.test'
const AUDIENCE = 'e2e-realm'
const CLIENT_SECRETS = { 'auth-service': 's0-' + randomBytes(8).toString('hex'), catalog: 's1-' + randomBytes(8).toString('hex'), iam: 's2-' + randomBytes(8).toString('hex'), e2eapp: 's3-' + randomBytes(8).toString('hex') }

class Kv {
  private m = new Map<string, string>()
  async get(k: string) { return this.m.get(k) ?? null }
  async set(k: string, v: string) { this.m.set(k, v); return this }
  async del(k: string) { this.m.delete(k); return this }
}

// ── the world ─────────────────────────────────────────────────────────────────

type Seen = { host: string; method: string; path: string; authorization: string; body: string }
const traffic: Seen[] = []
/** Authorization headers carrying an API token that a service sent ONTO another service (never the first hop). */
const bwtOnward: Seen[] = []
let inFlight = 0
const savedEnv = { ...process.env }
const realFetch = globalThis.fetch

let fbStop: () => Promise<void>
let fbBase = ''
let svcToken = ''
let apps: Record<string, { fetch: (r: Request) => Response | Promise<Response> }>
const rawFor = (tenant: string) => new FoldBase({ baseUrl: fbBase, token: svcToken, tenant }).withAuth({ uid: 'e2e', role: 'admin' })

const router = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = new Request(input as never, init)
  const host = new URL(req.url).hostname
  const app = apps?.[host]
  if (!app) return realFetch(input as never, init)
  const body = ['GET', 'HEAD'].includes(req.method) ? '' : await req.clone().text()
  const seen = { host, method: req.method, path: new URL(req.url).pathname, authorization: req.headers.get('authorization') ?? '', body }
  traffic.push(seen)
  // the first hop of a test's request is the outermost router call; anything inside it is one service calling another
  if (inFlight > 0 && seen.authorization.startsWith('Bearer bwt_')) bwtOnward.push(seen)
  inFlight++
  try { return await app.fetch(req) } finally { inFlight-- }
}) as typeof fetch

interface Res { status: number; body: Record<string, any>; text: string }
async function call(host: string, method: string, path: string, o: { token?: string; body?: unknown; org?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (o.token) headers['authorization'] = `Bearer ${o.token}`
  if (o.org) headers['x-org-id'] = o.org
  const res = await router(`http://${host}${path}`, { method, headers, ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }) })
  const text = await res.text()
  let body: Record<string, any> = {}
  try { body = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, body, text }
}
const auth = (m: string, p: string, o?: Parameters<typeof call>[3]) => call('auth.test', m, `/api${p}`, o)
const iam = (m: string, p: string, o?: Parameters<typeof call>[3]) => call('iam.test', m, `/api${p}`, o)
const org = (m: string, p: string, o?: Parameters<typeof call>[3]) => call('org.test', m, `/api${p}`, o)
const cat = (m: string, p: string, o?: Parameters<typeof call>[3]) => call('catalog.test', m, `/api${p}`, o)

const decode = (jwt: string) => parseJwtPayload(jwt) as Record<string, any>
const bearerOf = (s: Seen) => s.authorization.replace(/^Bearer /, '')
async function eventually<T>(fn: () => Promise<T | false | undefined | null>, ms = 5000): Promise<T> {
  const until = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) throw new Error('eventually: gave up'); await new Promise((r) => setTimeout(r, 25)) }
}

interface Person { id: string; handle: string; email: string; session: string }
async function signIn(name: string): Promise<Person> {
  // What auth-service does after an OIDC callback: tell iam who this is, as itself.
  const svc = await auth('POST', '/service-token', { body: { client_id: 'auth-service', client_secret: CLIENT_SECRETS['auth-service'] } })
  expect(svc.status).toBe(200)
  const synced = await call('iam.test', 'POST', '/_/sync', { token: svc.body['token'], body: { subject: `sub-${name}`, issuer: 'https://idp.e2e.test', email: `${name}@e2e.test`, name } })
  expect(synced.status).toBe(200)
  const id = synced.body['user'].id as string
  const session = (await mintIdentityToken({ sub: id, type: 'human', expires_in_seconds: 3600 }))!
  const me = await iam('GET', '/me', { token: session })
  return { id, handle: me.body['user'].handle, email: `${name}@e2e.test`, session }
}

const P = {} as Record<'ada' | 'bob' | 'carol' | 'dan' | 'eve', Person>
let A = { id: '', slug: 'acme', short_id: '' }
let B = { id: '', slug: 'globex', short_id: '' }

beforeAll(async () => {
  // The realm: an ES256 key made here, a realm with no shared secret.
  const pemKey = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  Object.assign(process.env, {
    AUTH_SIGNING_KEY: Buffer.from(pemKey()).toString('base64'),
    AUTH_ISSUER: ISSUER, AUTH_AUDIENCE: AUDIENCE, APP_PUBLIC_URL: ISSUER,
    AUTH_SERVICE_CLIENTS: Object.entries(CLIENT_SECRETS).map(([k, v]) => `${k}:${v}`).join(','),
    AUTH_JWKS_URI: 'http://auth.test/api/.well-known/jwks.json', AUTH_URL: 'http://auth.test/api',
    IAM_SERVICE_URL: 'http://iam.test', ORG_SERVICE_URL: 'http://org.test',
    ORG_ROLE_CACHE_SECONDS: '0', CATALOG_PERMISSION_CACHE_SECONDS: '0', AUTH_EXCHANGE_CACHE: 'off',
    IAM_VERIFY_CALLERS: 'auth-service', CATALOG_SERVICE_CLIENT_SECRET: CLIENT_SECRETS.catalog, IAM_SERVICE_CLIENT_SECRET: CLIENT_SECRETS.iam,
  })
  delete process.env['JWT_SECRET']
  delete process.env['IAM_ORG_TOKEN_ISSUERS']
  delete process.env['ORG_MEMBERSHIP_WRITERS']
  resetRealm(); resetAuthVerifier(); resetAuthExchange()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('fetch', router)

  const es = await bootServer({ cmd: './bin/foldbase', dir: resolve(here, '../../../../foldbase/go'), env: { FOLDBASE_AUTH: 'service-jwt', FOLDBASE_JWT_SECRET: FB_SECRET } })
  fbBase = es.base; fbStop = es.stop
  svcToken = signJwt({ sub: 'e2e-services', type: 'service' }, FB_SECRET)
  const fbFor = (tenant: string) => new FoldBase({ baseUrl: fbBase, token: svcToken, tenant })

  const iamFb = fbFor('iam'); await iamDefinitions(iamFb)
  const orgFb = fbFor('org'); await orgDefinitions(orgFb)
  const catFb = fbFor('catalog'); await catalogDefinitions(catFb)

  const iamOrg = iamOrgAccess(process.env, router)!
  const catOrg = catalogOrgAccess('http://org.test', process.env, router)
  apps = {
    'auth.test': createAuth({ kv: new Kv() as never }),
    'iam.test': createIam(iamFb, { org: iamOrg }),
    'org.test': createOrg(orgFb),
    'catalog.test': createCatalog(catFb, 'http://org.test', { org: catOrg }),
  }
  ;(globalThis as Record<string, unknown>)['__e2e'] = { iamOrg, catOrg }
}, 60_000)

afterAll(async () => {
  vi.unstubAllGlobals(); vi.restoreAllMocks()
  process.env = { ...savedEnv }
  resetRealm(); resetAuthVerifier(); resetAuthExchange()
  await fbStop?.()
})

const handlers = () => (globalThis as Record<string, any>)['__e2e'] as { iamOrg: { register(): Promise<void> }; catOrg: { register(): Promise<void> } }

const stored = async (tenant: string) => (await rawFor(tenant).query('products', {})).rows as Array<Record<string, any>>
const streamOf = async (tenant: string, id: string) => (await rawFor(tenant).readStream(id)) as unknown as Array<{ type: string; actor?: string; metadata?: { audit?: Record<string, any> } }>

// ── 1 ─────────────────────────────────────────────────────────────────────────

describe('1. boot: a member is refused until catalog has registered its actions', () => {
  it('refused before, allowed after, and the manifest names the product actions', async () => {
    for (const n of ['ada', 'bob', 'carol', 'dan', 'eve'] as const) P[n] = await signIn(n)
    const a = await org('POST', '/orgs', { token: P.ada.session, body: { name: 'Acme', slug: 'acme' } })
    expect(a.status).toBe(201)
    A = { id: a.body['org'].id, slug: 'acme', short_id: a.body['org'].short_id }
    const b = await org('POST', '/orgs', { token: P.eve.session, body: { name: 'Globex', slug: 'globex' } })
    B = { id: b.body['org'].id, slug: 'globex', short_id: b.body['org'].short_id }
    for (const [who, role] of [['bob', 'member'], ['carol', 'viewer'], ['dan', 'admin']] as const) {
      expect((await org('POST', '/orgs/acme/members', { token: P.ada.session, body: { user_id: P[who].id, role } })).status).toBe(201)
    }
    expect((await org('POST', '/orgs/globex/members', { token: P.eve.session, body: { user_id: P.bob.id, role: 'member' } })).status).toBe(201)

    // before: org-service knows no `catalog` app, so nothing is allowed
    const before = await cat('GET', '/catalog', { token: P.bob.session, org: 'acme' })
    expect(before.status).toBe(403)
    expect(before.body).toMatchObject({ error: 'forbidden', permission: 'product.read' })
    expect((await cat('GET', '/catalog', { token: P.ada.session, org: 'acme' })).status).toBe(403)

    // catalog registers as itself, with a service token auth-service issued to it
    await handlers().catOrg.register()
    // iam registers its own actions too (organization keys are made under one of them)
    await handlers().iamOrg.register()
    const registered = (await org('GET', '/apps', { token: P.ada.session })).body['apps'] as Array<{ name: string; actions?: Record<string, unknown> }>
    expect(registered.map((x) => x.name)).toContain('catalog')
    const after = await cat('GET', '/catalog', { token: P.bob.session, org: 'acme' })
    expect(after.status).toBe(200)
    expect(after.body).toMatchObject({ products: [] })
    expect((await rawFor('org').readAll({ limit: 10_000 })).some((e) => e.type === 'AppRegistered' && e.actor === 'service:catalog')).toBe(true)
  })
})

// ── 2 ─────────────────────────────────────────────────────────────────────────

describe('2. a person\'s session: writes, is on the record, and another organization sees none of it', () => {
  it('creates a product by slug, finds it by id, short id and sku, and what was stored says who', async () => {
    const made = await cat('POST', '/catalog', { token: P.ada.session, org: 'acme', body: { name: 'Managed Postgres', sku: 'PG-1', price_cents: 4900, currency: 'EUR' } })
    expect(made.status).toBe(201)
    const product = made.body['product']
    expect(product).toMatchObject({ name: 'Managed Postgres', sku: 'PG-1', price_cents: 4900 })
    expect(Object.keys(product).filter((k) => /[A-Z]/.test(k))).toEqual([])

    for (const ref of [product.id, product.short_id, 'PG-1']) {
      expect((await cat('GET', `/catalog/${ref}`, { token: P.bob.session, org: A.id })).body['product'].id, ref).toBe(product.id)
    }
    // eve is in the other organization: not a member of acme, and sees none of its products in her own
    expect((await cat('GET', '/catalog', { token: P.eve.session, org: 'acme' })).status).toBe(403)
    expect((await cat('GET', '/catalog', { token: P.eve.session, org: 'globex' })).body['products']).toEqual([])
    expect(await stored(A.id)).toHaveLength(1)
    expect(await stored(B.id)).toHaveLength(0)

    const ev = (await streamOf(A.id, product.id))[0]!
    expect(ev.actor).toBe(`user:${P.ada.id}`)
    expect(ev.metadata?.audit).toMatchObject({ kind: 'human', actor: `user:${P.ada.id}`, via: 'session', org_id: A.id, client: 'api' })
  })
})

// ── 3 ─────────────────────────────────────────────────────────────────────────

let roToken = { secret: '', id: '' }
describe('3. a read-only personal API token', () => {
  it('reads, is refused every write (permission named), and nothing is stored', async () => {
    const issued = await iam('POST', '/tokens', { token: P.bob.session, body: { name: 'ro', type: 'user', scopes: ['read'] } })
    expect(issued.status).toBe(201)
    roToken = { secret: issued.body['secret'], id: issued.body['token'].id }
    expect(roToken.secret).toMatch(/^bwt_/)

    const read = await cat('GET', '/catalog', { token: roToken.secret, org: 'acme' })
    expect(read.status).toBe(200)
    expect(read.body['products'].map((p: { name: string }) => p.name)).toEqual(['Managed Postgres'])

    const id = read.body['products'][0].id
    const w1 = await cat('POST', '/catalog', { token: roToken.secret, org: 'acme', body: { name: 'Nope' } })
    expect(w1.status).toBe(403)
    expect(w1.body).toMatchObject({ error: 'forbidden', permission: 'product.write' })
    expect((await cat('PATCH', `/catalog/${id}`, { token: roToken.secret, org: 'acme', body: { name: 'Nope' } })).status).toBe(403)
    const w3 = await cat('DELETE', `/catalog/${id}`, { token: roToken.secret, org: 'acme' })
    expect(w3.status).toBe(403)
    expect(w3.body).toMatchObject({ permission: 'product.archive' })

    expect((await stored(A.id)).map((r) => r['name'])).toEqual(['Managed Postgres'])
    expect((await streamOf(A.id, id)).map((e) => e.type)).toEqual(['ProductCreated'])
    // and the token still works afterwards: a refusal is not a revocation
    expect((await cat('GET', '/catalog', { token: roToken.secret, org: 'acme' })).status).toBe(200)
  })
})

// ── 4 ─────────────────────────────────────────────────────────────────────────

describe('4. a write personal API token', () => {
  it('writes a product as the person (via token), and no bwt_ travels past catalog', async () => {
    const issued = await iam('POST', '/tokens', { token: P.bob.session, body: { name: 'rw', type: 'user', scopes: ['read', 'write'] } })
    const rw = { secret: issued.body['secret'] as string, id: issued.body['token'].id as string }
    traffic.length = 0; bwtOnward.length = 0
    const made = await cat('POST', '/catalog', { token: rw.secret, org: 'acme', body: { name: 'Beta Plan', sku: 'BETA' } })
    expect(made.status).toBe(201)
    expect((await stored(A.id)).map((r) => r['name']).sort()).toEqual(['Beta Plan', 'Managed Postgres'])

    // catalog received the API token; it went to auth once to be exchanged…
    expect(traffic.find((t) => t.host === 'catalog.test')!.authorization).toBe(`Bearer ${rw.secret}`)
    const exchanges = traffic.filter((t) => t.host === 'auth.test' && t.path === '/api/exchange-key')
    expect(exchanges.length).toBeGreaterThanOrEqual(1)
    expect(JSON.parse(exchanges[0]!.body).token).toBe(rw.secret)
    // …and everything it sent on to org-service carried the realm token
    const toOrg = traffic.filter((t) => t.host === 'org.test')
    expect(toOrg.length).toBeGreaterThanOrEqual(2)
    for (const t of toOrg) {
      expect(t.authorization, `${t.method} ${t.path}`).not.toContain('bwt_')
      expect(t.authorization.split('.')).toHaveLength(3)
    }
    expect(decode(bearerOf(toOrg[0]!))).toMatchObject({ sub: P.bob.id, kind: 'human', via: 'token', credential_id: rw.id, access: ['read', 'write'], iss: ISSUER, aud: AUDIENCE })
    expect(bwtOnward).toEqual([])
    // the secret appears nowhere else on the wire than in the request to be exchanged
    const leaks = traffic.filter((t) => (t.authorization + t.body).includes(rw.secret) && !(t.host === 'catalog.test' || (t.host === 'auth.test' && t.path === '/api/exchange-key') || (t.host === 'iam.test' && t.path === '/_/tokens/verify')))
    expect(leaks).toEqual([])

    const ev = (await streamOf(A.id, made.body['product'].id))[0]!
    expect(ev.actor).toBe(`user:${P.bob.id}`)
    expect(ev.metadata?.audit).toMatchObject({ kind: 'human', via: 'token', credential_id: rw.id, org_id: A.id })
  })
})

// ── 5 ─────────────────────────────────────────────────────────────────────────

let agent = { id: '', actor: '', secret: '', tokenId: '' }
describe('5. an agent', () => {
  it('is made by the person, writes under its own name and the person\'s, and is bound to its organization', async () => {
    const created = await iam('POST', '/agents', { token: P.bob.session, body: { name: 'dev' } })
    expect(created.status).toBe(201)
    agent.id = created.body['agent'].id
    agent.actor = created.body['agent'].actor
    expect(agent.actor).toBe(`agent:dev@${P.bob.handle}`)
    const issued = await iam('POST', `/agents/${agent.id}/tokens`, { token: P.bob.session, body: { name: 'laptop', access: 'write', org_id: A.id } })
    expect(issued.status).toBe(201)
    agent.secret = issued.body['secret']; agent.tokenId = issued.body['token'].id

    bwtOnward.length = 0
    const made = await cat('POST', '/catalog', { token: agent.secret, org: 'acme', body: { name: 'Agent Plan' } })
    expect(made.status).toBe(201)
    expect(bwtOnward).toEqual([])
    const ev = (await streamOf(A.id, made.body['product'].id))[0]!
    expect(ev.actor).toBe(agent.actor)
    expect(ev.metadata?.audit).toMatchObject({ kind: 'agent', actor: agent.actor, actor_id: agent.id, on_behalf_of: `user:${P.bob.id}`, via: 'token', credential_id: agent.tokenId, org_id: A.id })

    // bob is also a member of globex, and his own session works there; the agent's token is bound to acme
    expect((await cat('GET', '/catalog', { token: P.bob.session, org: 'globex' })).status).toBe(200)
    for (const ref of [B.slug, B.id, B.short_id]) expect((await cat('GET', '/catalog', { token: agent.secret, org: ref })).status, ref).toBe(403)
    expect(await stored(B.id)).toHaveLength(0)
  })
})

// ── 6 ─────────────────────────────────────────────────────────────────────────

describe('6. an organization\'s key', () => {
  it('a read key reads and is refused a write; a write key writes as a machine; neither is anybody in another organization', async () => {
    const mk = async (access: 'read' | 'write') => {
      const made = await iam('POST', '/orgs/acme/keys', { token: P.dan.session, body: { name: `ci-${access}`, role: 'member', access } })
      expect(made.status).toBe(201)
      return { id: made.body['token'].id as string, secret: made.body['secret'] as string }
    }
    const r = await mk('read'), w = await mk('write')
    expect((await cat('GET', '/catalog', { token: r.secret, org: 'acme' })).status).toBe(200)
    const refused = await cat('POST', '/catalog', { token: r.secret, org: 'acme', body: { name: 'Machine Co' } })
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ permission: 'product.write' })
    expect((await stored(A.id)).map((p) => p['name'])).not.toContain('Machine Co')

    const made = await cat('POST', '/catalog', { token: w.secret, org: 'acme', body: { name: 'Machine Co' } })
    expect(made.status).toBe(201)
    const ev = (await streamOf(A.id, made.body['product'].id))[0]!
    expect(ev.actor).toBe(`machine:ci-write@${A.id}`)
    expect(ev.metadata?.audit).toMatchObject({ kind: 'machine', via: 'key', credential_id: w.id, org_id: A.id })

    expect((await cat('GET', '/catalog', { token: w.secret, org: 'globex' })).status).toBe(403)
    expect(await stored(B.id)).toHaveLength(0)
  })
})

// ── 7 ─────────────────────────────────────────────────────────────────────────

describe('7. a viewer\'s agent can read and cannot write; a revoked token is refused', () => {
  it('carol\'s agent has her standing, not bob\'s; revoking the token ends it', async () => {
    const created = await iam('POST', '/agents', { token: P.carol.session, body: { name: 'scribe' } })
    const id = created.body['agent'].id
    const secret = (await iam('POST', `/agents/${id}/tokens`, { token: P.carol.session, body: { name: 't', access: 'write', org_id: A.id } })).body['secret'] as string
    expect((await cat('GET', '/catalog', { token: secret, org: 'acme' })).status).toBe(200)
    const write = await cat('POST', '/catalog', { token: secret, org: 'acme', body: { name: 'Viewer Plan' } })
    expect(write.status).toBe(403)
    expect(write.body).toMatchObject({ permission: 'product.write' })
    expect((await stored(A.id)).map((p) => p['name'])).not.toContain('Viewer Plan')

    // suspended: refused at the exchange
    expect((await iam('PATCH', `/agents/${id}`, { token: P.carol.session, body: { state: 'suspended' } })).status).toBe(200)
    expect((await cat('GET', '/catalog', { token: secret, org: 'acme' })).status).toBe(401)
  })
})

// ── 8 ─────────────────────────────────────────────────────────────────────────

describe('8. update and archive through the realm', () => {
  it('the person updates and archives; the log holds all three events with their own request ids', async () => {
    const made = await cat('POST', '/catalog', { token: P.dan.session, org: 'acme', body: { name: 'Short-lived' } })
    const id = made.body['product'].id as string
    expect((await cat('PATCH', `/catalog/${id}`, { token: P.dan.session, org: 'acme', body: { price_cents: 100, currency: 'EUR' } })).status).toBe(200)
    expect((await cat('DELETE', `/catalog/${id}`, { token: P.dan.session, org: 'acme' })).status).toBe(204)
    const events = await streamOf(A.id, id)
    expect(events.map((e) => e.type)).toEqual(['ProductCreated', 'ProductUpdated', 'ProductArchived'])
    expect(new Set(events.map((e) => e.metadata?.audit?.['request_id'])).size).toBe(3)
    for (const e of events) expect(e.actor).toBe(`user:${P.dan.id}`)
    expect((await cat('GET', `/catalog/${id}`, { token: P.dan.session, org: 'acme' })).status).toBe(404)
  })
})

// ── 9 ─────────────────────────────────────────────────────────────────────────

describe('9. the legacy mounts answer the same, behind the same gates', () => {
  it('/catalog and /v1/catalog at the root need the same token and permission', async () => {
    for (const path of ['/catalog', '/v1/catalog']) {
      const ok = await call('catalog.test', 'GET', path, { token: P.bob.session, org: 'acme' })
      expect(ok.status, path).toBe(200)
      expect((await call('catalog.test', 'GET', path, { org: 'acme' })).status, path).toBe(401)
      expect((await call('catalog.test', 'GET', path, { token: P.eve.session, org: 'acme' })).status, path).toBe(403)
    }
  })
})
