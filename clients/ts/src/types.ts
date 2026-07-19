// Product domain types. Foldbase-native: read-model row (snake_case, as stored)
// and the REST DTO (camelCase, as API + CLI consume).

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
  shortId: string
  /** Caller-side SKU/code (e.g. the id in the consumer's own catalog). */
  sku: string | null
  name: string
  description: string | null
  category: string | null
  /** Optional list price — integer cents. `null` when no list price is set. */
  priceCents: number | null
  currency: string | null
  labels: string[]
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface CreateProductInput {
  name: string
  sku?: string
  description?: string
  category?: string
  priceCents?: number
  currency?: string
  labels?: string[]
  metadata?: Record<string, unknown>
}

export interface UpdateProductInput {
  name?: string
  sku?: string
  description?: string
  category?: string
  priceCents?: number
  currency?: string
  labels?: string[]
  metadata?: Record<string, unknown>
}
