import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { FoldBase } from '@baseworks/foldbase'
import { parseJwtPayload, signHs256Jwt } from '@baseworks/auth/jwt'
// The foldbase conformance harness boots the Go binary as a private sibling.
// @ts-expect-error — plain ESM helper, no types
import { bootServer, signJwt } from '../../../foldbase/conformance/harness.mjs'
import { createApp, registerDefinitions } from '../app.js'

const here = dirname(fileURLToPath(import.meta.url))
const FB_SECRET = 'catalog-service-foldbase-secret-32chr'

export const JWT_SECRET = 'test-secret-32-chars-long-enough!'
export const USER_ID = 'user-test-001'

/**
 * A fresh organization per test.
 *
 * The org id IS the storage tenant here, so two tests sharing one would share a
 * directory — and the isolation this service is built on would be the thing not
 * under test. A unique foldbase tenant on the client does nothing: the store
 * overrides it per request with the org id.
 */
export const newOrgId = (): string => `org-${randomUUID()}`

process.env['JWT_SECRET'] = JWT_SECRET

export interface TestFoldBase {
  base: string
  svcToken: string
  stop: () => Promise<void>
}

/** One foldbase Go sibling per test file, on an in-memory SQLite. */
export async function bootTestFoldBase(): Promise<TestFoldBase> {
  const es = await bootServer({
    cmd: './bin/foldbase',
    dir: resolve(here, '../../../foldbase/go'),
    env: { FOLDBASE_AUTH: 'service-jwt', FOLDBASE_JWT_SECRET: FB_SECRET },
  })
  const svcToken = signJwt({ sub: 'catalog-service', type: 'service' }, FB_SECRET)
  return { base: es.base, svcToken, stop: es.stop }
}

export function makeToken(userId = USER_ID): string {
  return signHs256Jwt({ sub: userId, type: 'human' }, JWT_SECRET, 3600)
}

export function makeServiceToken(name = 'svc'): string {
  return signHs256Jwt({ sub: name, type: 'service' }, JWT_SECRET, 3600)
}

/** What a role is allowed by this service's manifest, the way org-service would answer. */
const BY_ROLE: Record<string, string[]> = {
  viewer: ['product.read'],
  member: ['product.read', 'product.write', 'product.archive'],
  admin: ['product.read', 'product.write', 'product.archive'],
  owner: ['product.read', 'product.write', 'product.archive'],
}

export interface FakeOrgOptions {
  /** A slug or short id that names an org: the real service resolves these. */
  aliases?: Record<string, string>
  /** false: the app's manifest is not registered, so nobody is allowed anything. */
  registered?: boolean
  /** true: `/authz/permissions` fails, as when org-service is down mid-request. */
  permissionsDown?: boolean
}

const claimsOf = (init?: RequestInit): Record<string, unknown> => {
  const bearer = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /i, '') ?? ''
  try { return parseJwtPayload(bearer) as Record<string, unknown> } catch { return {} }
}

/** An organization's key belongs to one organization; a person's standing is whatever `roles` says (`<org>|<user>` names one person). */
function roleFor(roles: Record<string, string>, claims: Record<string, unknown>, scope: string): string {
  if (claims['kind'] === 'machine') return claims['org_id'] === scope ? String(claims['role'] ?? 'none') : 'none'
  // `<org>|<user>` is one person's own standing, over the organization's default.
  return roles[`${scope}|${String(claims['sub'])}`] ?? roles[scope] ?? 'none'
}

/**
 * Stand in for org-service, the PDP.
 *
 * Every request here asks it whether the caller is a member, so a test that did
 * not answer that question would be testing nothing but a 502. `roles` maps an
 * org id to what the PDP says; anything absent answers `none`, which is how a
 * non-member looks.
 */
export function fakeOrgService(roles: Record<string, string>, o: FakeOrgOptions = {}) {
  const aliases = o.aliases ?? {}
  const realFetch = globalThis.fetch
  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const calls = { permissions: 0 }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/authz/permissions')) {
      calls.permissions++
      if (o.permissionsDown) return answer({ error: 'internal' }, 500)
      const asked = JSON.parse(String(init?.body ?? '{}')) as { app: string; scope_id: string }
      const claims = claimsOf(init)
      const role = roleFor(roles, claims, asked.scope_id)
      let permissions = o.registered === false ? [] : BY_ROLE[role] ?? []
      // org-service answers for the credential, not only for the person: a token that may only read is
      // never told it may write (the real answer is proven in the e2e).
      if (Array.isArray(claims['access']) && !(claims['access'] as string[]).includes('write')) {
        permissions = permissions.filter((a) => a === 'product.read')
      }
      return answer({ app: asked.app, scope_id: asked.scope_id, role, permissions })
    }
    if (!url.includes('/authz/role')) return realFetch(input as never, init)
    const named = new URL(url).searchParams.get('scope') ?? ''
    // The real service resolves an id, a slug or a short id and answers with
    // the scope it landed on. `aliases` is how a test says "this slug is that org".
    const scope = aliases[named] ?? named
    const role = roleFor(roles, claimsOf(init), scope)
    return answer(role === 'none' ? { role: 'none' } : { role, via: { scope_id: scope, scope_kind: 'org' } })
  }) as typeof fetch
  const restore = () => { globalThis.fetch = realFetch }
  return Object.assign(restore, { calls })
}

/**
 * An app on the shared foldbase, with `orgId` as the org every request names
 * unless it says otherwise.
 */
export async function makeTestApp(fb: TestFoldBase, orgId: string) {
  const client = new FoldBase({ baseUrl: fb.base, token: fb.svcToken, tenant: 'unused' })
  await registerDefinitions(client)
  // No answer is remembered between requests: each test sets its own org-service.
  process.env['CATALOG_PERMISSION_CACHE_SECONDS'] = '0'
  const app = createApp(client, 'http://org.test')

  function req(method: string, path: string, body?: unknown, o: { token?: string; org?: string | null } = {}) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${o.token ?? makeToken()}`,
      'Content-Type': 'application/json',
    }
    // `org: null` is how a test says "send no X-Org-Id at all".
    if (o.org !== null) headers['X-Org-Id'] = o.org ?? orgId
    const init: RequestInit = { method, headers }
    if (body !== undefined) init.body = JSON.stringify(body)
    return app.fetch(new Request(`http://localhost${path}`, init))
  }

  return {
    app,
    get: (path: string, o?: Parameters<typeof req>[3]) => req('GET', path, undefined, o),
    post: (path: string, body: unknown, o?: Parameters<typeof req>[3]) => req('POST', path, body, o),
    patch: (path: string, body: unknown, o?: Parameters<typeof req>[3]) => req('PATCH', path, body, o),
    del: (path: string, o?: Parameters<typeof req>[3]) => req('DELETE', path, undefined, o),
    unauth: (path: string) => app.fetch(new Request(`http://localhost${path}`, { method: 'GET' })),
  }
}
