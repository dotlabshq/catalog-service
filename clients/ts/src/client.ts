import type { Product, WireProduct, CreateProductInput, UpdateProductInput } from './types.js'

export type {
  Product,
  ProductRow,
  CreateProductInput,
  UpdateProductInput,
  WireProduct,
} from './types.js'

export interface CatalogClientOptions {
  /** Base URL of catalog-service (resolved by the SDK, e.g. CATALOG_SERVICE_URL). */
  base_url?: string
  /** Bearer token — the caller's identity JWT. */
  token?: string
  /** Active org id — sent as X-Org-Id (products are org-scoped, tenant = org). */
  org_id?: string
  /** @deprecated Read `base_url`. Accepted until the last caller has moved. */
  baseUrl?: string
  /** @deprecated Read `org_id`. Accepted until the last caller has moved. */
  orgId?: string
  /** Injectable fetch (tests / non-global environments). */
  fetch?: typeof fetch
}

/** Thrown on any non-2xx response from catalog-service. */
export class CatalogError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'CatalogError'
  }
}

/** Minimal ApiClient shape — structurally compatible with @baseworks/cli. */
export interface HttpClient {
  api<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T>
  get<T>(path: string, headers?: Record<string, string>): Promise<T>
  post<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T>
  patch<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T>
  del<T>(path: string, headers?: Record<string, string>): Promise<T>
}

/**
 * Typed HTTP client for catalog-service. Thin wrapper over the REST surface; the
 * service validates. Every call carries the org id (X-Org-Id) — products are
 * per-org, and the identity JWT is org-less by design (ADR-009).
 */
/**
 * Paths here are the service's own — `/catalog`, not `/v1/catalog`. A gateway
 * publishes the service at `/v1/<name>` and strips that prefix (ADR-042 §4), so
 * the client says what the service serves and `baseUrl` says where it is.
 */
export class CatalogClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  constructor(private readonly opts: CatalogClientOptions) {
    const base = opts.base_url ?? opts.baseUrl
    if (!base) throw new Error('CatalogClient needs base_url')
    this.baseUrl = base.replace(/\/$/, '')
    this.fetchImpl = opts.fetch ?? globalThis.fetch
  }

  /** Return a new client scoped to a different org. */
  withOrg(orgId: string): CatalogClient {
    return new CatalogClient({ ...this.opts, org_id: orgId, orgId })
  }

  private headers(json: boolean, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {}
    if (json) h['Content-Type'] = 'application/json'
    if (this.opts.token) h['Authorization'] = `Bearer ${this.opts.token}`
    const org = this.opts.org_id ?? this.opts.orgId // deprecated spelling, read until the last caller has moved
    if (org) h['X-Org-Id'] = org
    return { ...h, ...extra }
  }

  async api<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined, extra),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (res.status === 204) return null as T
    const text = await res.text()
    const data = text ? (JSON.parse(text) as unknown) : undefined
    if (!res.ok) {
      const e = (data ?? {}) as { error?: string | { code?: string; message?: string }; message?: string }
      const code = typeof e.error === 'string' ? e.error : e.error?.code ?? 'error'
      const msg = typeof e.error === 'object' ? e.error?.message : e.message
      throw new CatalogError(res.status, code, msg)
    }
    return data as T
  }

  /** Generic ApiClient (get/post/patch/del) — used by the CLI plugin. */
  get http(): HttpClient {
    return {
      api: this.api.bind(this),
      get: <T>(p: string, h?: Record<string, string>) => this.api<T>('GET', p, undefined, h),
      post: <T>(p: string, b: unknown, h?: Record<string, string>) => this.api<T>('POST', p, b, h),
      patch: <T>(p: string, b: unknown, h?: Record<string, string>) => this.api<T>('PATCH', p, b, h),
      del: <T>(p: string, h?: Record<string, string>) => this.api<T>('DELETE', p, undefined, h),
    }
  }

  // ── products ──────────────────────────────────────────────────────────────

  async list(opts: { limit?: number; offset?: number } = {}): Promise<Product[]> {
    const q = new URLSearchParams()
    if (opts.limit !== undefined) q.set('limit', String(opts.limit))
    if (opts.offset !== undefined) q.set('offset', String(opts.offset))
    const qs = q.toString()
    const { products } = await this.api<{ products: WireProduct[] }>('GET', `/catalog${qs ? `?${qs}` : ''}`)
    return products.map(withAliases)
  }
  async get(ref: string): Promise<Product> {
    const { product } = await this.api<{ product: WireProduct }>('GET', `/catalog/${encodeURIComponent(ref)}`)
    return withAliases(product)
  }
  async getBySku(sku: string): Promise<Product> {
    const { product } = await this.api<{ product: WireProduct }>('GET', `/catalog?sku=${encodeURIComponent(sku)}`)
    return withAliases(product)
  }
  async create(input: CreateProductInput): Promise<Product> {
    const { product } = await this.api<{ product: WireProduct }>('POST', '/catalog', snakeInput(input))
    return withAliases(product)
  }
  async update(ref: string, input: UpdateProductInput): Promise<Product> {
    const { product } = await this.api<{ product: WireProduct }>('PATCH', `/catalog/${encodeURIComponent(ref)}`, snakeInput(input))
    return withAliases(product)
  }
  async delete(ref: string): Promise<void> {
    await this.api('DELETE', `/catalog/${encodeURIComponent(ref)}`)
  }
}

/** The service answers snake_case; the camelCase names of 0.2 are set beside them, deprecated. */
function withAliases(p: WireProduct): Product {
  return { ...p, shortId: p.short_id, priceCents: p.price_cents, createdAt: p.created_at, updatedAt: p.updated_at }
}

/** A body in the wire's spelling: the deprecated `priceCents` becomes `price_cents` (the new name wins). */
function snakeInput<T extends { price_cents?: number; priceCents?: number }>(input: T): Omit<T, 'priceCents'> {
  const { priceCents, ...rest } = input
  return priceCents !== undefined && rest.price_cents === undefined ? { ...rest, price_cents: priceCents } : rest
}

/** Factory used by the SDK capability registry. */
export function createCatalogClient(opts: CatalogClientOptions): CatalogClient {
  return new CatalogClient(opts)
}
