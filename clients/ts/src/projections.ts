import { defineProjection, type PolicyDef } from '@baseworks/foldbase'
import { ProductEvents } from './events.js'

/**
 * Read-model definition registered on boot (idempotent, like a migration).
 * Columns are inferred from event field types; `updated_at` is foldbase's
 * server-maintained spine and is never declared. Archive deletes the row — the
 * events remain the durable audit trail. Projection name has NO `read_` prefix:
 * foldbase adds it (table becomes `read_products`). The read policy is permissive
 * for the service's own `admin` identity (route handlers enforce end-user scope).
 */
export const readProducts = defineProjection('products', ProductEvents, (on) => ({
  ProductCreated: on.ProductCreated.upsert((e) => ({
    sku: e.sku,
    name: e.name,
    description: e.description,
    category: e.category,
    price_cents: e.priceCents,
    currency: e.currency,
    labels: e.labels,
    metadata: e.metadata,
    short_id: e.shortId,
    created_at: e.at,
  })),
  ProductUpdated: on.ProductUpdated.upsert((e) => ({
    sku: e.sku,
    name: e.name,
    description: e.description,
    category: e.category,
    price_cents: e.priceCents,
    currency: e.currency,
    labels: e.labels,
    metadata: e.metadata,
  })),
  ProductArchived: on.ProductArchived.delete(),
}))

export const PROJECTIONS = [readProducts] as const

/** Permissive policy for the service's own `admin` identity (see ADR 0001). */
export const POLICIES: PolicyDef[] = [{ name: 'products', role: 'admin' }]
