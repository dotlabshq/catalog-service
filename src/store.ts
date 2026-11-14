import { type FoldBase, FoldBaseError } from '@baseworks/foldbase'
import type { EmitAudit } from '@baseworks/auth/principal'
import { ProductEvents } from '@baseworks/catalog/events'
import type {
  WireProduct,
  ProductRow,
  CreateProductInput,
  UpdateProductInput,
} from '@baseworks/catalog'
import { generateShortId } from '@baseworks/core'

/**
 * The catalog domain over foldbase. Products are genuinely per-org, so every
 * operation runs against `fb.withTenant(orgId)` — real tenant isolation. Reads
 * run as the service's own `admin` identity; route handlers enforce end-user
 * scoping (the org membership check). Money is integer cents; a missing list
 * price is `price_cents: 0` + `currency: ''`.
 */

/**
 * Who caused a write, and the request it belongs to: `auditOf(c, { org_id })`
 * from `@baseworks/auth/hono` in a route. Every store function that writes
 * takes one; none invents an actor (workspace ADR 0004 §6).
 */
export type Audit = EmitAudit

export class StoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'StoreError'
  }
}

/** Map a foldbase optimistic-concurrency conflict (409) to a retryable StoreError. */
function onConflict(e: unknown): never {
  if (e instanceof FoldBaseError && e.status === 409) throw new StoreError(409, 'conflict', 'Product changed concurrently — retry')
  throw e
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

const orNull = (s: string): string | null => (s === '' ? null : s)

function toProduct(r: ProductRow): WireProduct {
  return {
    id: r.id,
    short_id: r.short_id,
    sku: orNull(r.sku),
    name: r.name,
    description: orNull(r.description),
    category: orNull(r.category),
    price_cents: r.currency === '' ? null : r.price_cents,
    currency: orNull(r.currency),
    labels: parseJson<string[]>(r.labels, []),
    metadata: parseJson<Record<string, unknown>>(r.metadata, {}),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

export type Store = ReturnType<typeof createStore>

export function createStore(fb: FoldBase) {
  const scoped = (orgId: string) => {
    const t = fb.withTenant(orgId)
    return {
      q: t.withAuth({ uid: 'catalog-service', role: 'admin' }),
      products: t.catalog(ProductEvents),
      version: (streamId: string) => t.streamVersion(streamId).then((v) => v.version),
    }
  }

  async function rowByRef(orgId: string, ref: string): Promise<ProductRow | null> {
    const { q } = scoped(orgId)
    for (const field of ['id', 'short_id', 'sku'] as const) {
      const res = await q.query<ProductRow>('products', { where: { [field]: { eq: ref } }, limit: 1 })
      if (res.rows[0]) return res.rows[0]
    }
    return null
  }

  async function listProducts(orgId: string, opts: { limit?: number; offset?: number } = {}): Promise<WireProduct[]> {
    const { q } = scoped(orgId)
    const res = await q.query<ProductRow>('products', {
      sort: ['-created_at'],
      limit: opts.limit ?? 50,
      offset: opts.offset ?? 0,
    })
    return res.rows.map(toProduct)
  }

  async function getProduct(orgId: string, ref: string): Promise<WireProduct | null> {
    const row = await rowByRef(orgId, ref)
    return row ? toProduct(row) : null
  }

  async function getBySku(orgId: string, sku: string): Promise<WireProduct | null> {
    const { q } = scoped(orgId)
    const res = await q.query<ProductRow>('products', { where: { sku: { eq: sku } }, limit: 1 })
    return res.rows[0] ? toProduct(res.rows[0]) : null
  }

  async function createProduct(orgId: string, input: CreateProductInput, audit: Audit): Promise<WireProduct> {
    const { products } = scoped(orgId)
    if (input.sku) {
      const dup = await getBySku(orgId, input.sku)
      if (dup) throw new StoreError(409, 'sku_taken', `Product with sku '${input.sku}' already exists`)
    }
    const id = ProductEvents.newId()
    const now = Date.now()
    await products.emit(id, 0, 'ProductCreated', {
      sku: input.sku ?? '',
      name: input.name,
      description: input.description ?? '',
      category: input.category ?? '',
      price_cents: input.price_cents ?? 0,
      currency: input.currency ?? '',
      labels: JSON.stringify(input.labels ?? []),
      metadata: input.metadata ? JSON.stringify(input.metadata) : '{}',
      short_id: generateShortId(),
      at: now,
    }, audit)
    return (await getProduct(orgId, id))!
  }

  async function updateProduct(orgId: string, ref: string, patch: UpdateProductInput, audit: Audit): Promise<WireProduct> {
    const row = await rowByRef(orgId, ref)
    if (!row) throw new StoreError(404, 'not_found')
    const { products, version } = scoped(orgId)
    const expected = await version(row.id) // OCC base — captured before the work

    if (patch.sku && patch.sku !== row.sku) {
      const dup = await getBySku(orgId, patch.sku)
      if (dup) throw new StoreError(409, 'sku_taken', `Product with sku '${patch.sku}' already exists`)
    }
    const mergedMeta = patch.metadata
      ? { ...parseJson<Record<string, unknown>>(row.metadata, {}), ...patch.metadata }
      : parseJson<Record<string, unknown>>(row.metadata, {})

    await products.emit(row.id, expected, 'ProductUpdated', {
      sku: patch.sku ?? row.sku,
      name: patch.name ?? row.name,
      description: patch.description ?? row.description,
      category: patch.category ?? row.category,
      price_cents: patch.price_cents ?? row.price_cents,
      currency: patch.currency ?? row.currency,
      labels: patch.labels ? JSON.stringify(patch.labels) : row.labels,
      metadata: JSON.stringify(mergedMeta),
      at: Date.now(),
    }, audit).catch(onConflict)
    return (await getProduct(orgId, row.id))!
  }

  async function archiveProduct(orgId: string, ref: string, audit: Audit): Promise<void> {
    const row = await rowByRef(orgId, ref)
    if (!row) throw new StoreError(404, 'not_found')
    const { products, version } = scoped(orgId)
    const expected = await version(row.id)
    await products.emit(row.id, expected, 'ProductArchived', {}, audit).catch(onConflict)
  }

  return { listProducts, getProduct, getBySku, createProduct, updateProduct, archiveProduct }
}
