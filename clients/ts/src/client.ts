import type { Product, CreateProductInput, UpdateProductInput } from './types.js'

export type {
  Product,
  ProductRow,
  CreateProductInput,
  UpdateProductInput,
} from './types.js'

export interface CatalogClientOptions {
  /** Base URL of catalog-service (resolved by the SDK, e.g. CATALOG_SERVICE_URL). */
  baseUrl: string
  /** Bearer token — the caller's identity JWT. */
  token?: string
  /** Active org id — sent as X-Org-Id (products are org-scoped, tenant = org). */
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
export class CatalogClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  constructor(private readonly opts: CatalogClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.fetchImpl = opts.fetch ?? globalThis.fetch
  }

  /** Return a new client scoped to a different org. */
  withOrg(orgId: string): CatalogClient {
    return new CatalogClient({ ...this.opts, orgId })
  }

  private headers(json: boolean, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {}
    if (json) h['Content-Type'] = 'application/json'
    if (this.opts.token) h['Authorization'] = `Bearer ${this.opts.token}`
    if (this.opts.orgId) h['X-Org-Id'] = this.opts.orgId
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
    const { products } = await this.api<{ products: Product[] }>('GET', `/v1/catalog${qs ? `?${qs}` : ''}`)
    return products
  }
  async get(ref: string): Promise<Product> {
    const { product } = await this.api<{ product: Product }>('GET', `/v1/catalog/${ref}`)
    return product
  }
  async getBySku(sku: string): Promise<Product> {
    const { product } = await this.api<{ product: Product }>('GET', `/v1/catalog?sku=${encodeURIComponent(sku)}`)
    return product
  }
  async create(input: CreateProductInput): Promise<Product> {
    const { product } = await this.api<{ product: Product }>('POST', '/v1/catalog', input)
    return product
  }
  async update(ref: string, input: UpdateProductInput): Promise<Product> {
    const { product } = await this.api<{ product: Product }>('PATCH', `/v1/catalog/${ref}`, input)
    return product
  }
  async delete(ref: string): Promise<void> {
    await this.api('DELETE', `/v1/catalog/${ref}`)
  }
}

/** Factory used by the SDK capability registry. */
export function createCatalogClient(opts: CatalogClientOptions): CatalogClient {
  return new CatalogClient(opts)
}
