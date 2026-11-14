// Product domain types. Foldbase-native: read-model row (snake_case, as stored)
// and the REST DTO (snake_case since 0.3.0, as API + CLI consume).

export interface ProductRow {
  id: string
  short_id: string
  sku: string
  name: string
  description: string
  category: string
  price_cents: number
  currency: string
  labels: string // JSON string array
  metadata: string // JSON string
  created_at: number
  updated_at: number
}

export interface Product {
  id: string
  short_id: string
  /** Caller-side SKU/code (e.g. the id in the consumer's own catalog). */
  sku: string | null
  name: string
  description: string | null
  category: string | null
  /** Optional list price — integer cents. `null` when no list price is set. */
  price_cents: number | null
  currency: string | null
  labels: string[]
  metadata: Record<string, unknown>
  created_at: number
  updated_at: number
  /** @deprecated Read `short_id`. Set by the client until the last caller has moved. */
  shortId: string
  /** @deprecated Read `price_cents`. Set by the client until the last caller has moved. */
  priceCents: number | null
  /** @deprecated Read `created_at`. Set by the client until the last caller has moved. */
  createdAt: number
  /** @deprecated Read `updated_at`. Set by the client until the last caller has moved. */
  updatedAt: number
}

export interface CreateProductInput {
  name: string
  sku?: string
  description?: string
  category?: string
  price_cents?: number
  currency?: string
  labels?: string[]
  metadata?: Record<string, unknown>
  /** @deprecated Send `price_cents`. Accepted until the last caller has moved. */
  priceCents?: number
}

export interface UpdateProductInput {
  name?: string
  sku?: string
  description?: string
  category?: string
  price_cents?: number
  currency?: string
  labels?: string[]
  metadata?: Record<string, unknown>
  /** @deprecated Send `price_cents`. Accepted until the last caller has moved. */
  priceCents?: number
}

/**
 * What the service answers: snake_case only. The client adds the camelCase
 * names of 0.2 on top (`Product`'s deprecated fields) so callers that have not
 * moved keep reading them.
 */
export type WireProduct = Omit<Product, 'shortId' | 'priceCents' | 'createdAt' | 'updatedAt'>
