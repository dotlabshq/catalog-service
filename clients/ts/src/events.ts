import { z } from 'zod'
import { defineAggregate } from '@baseworks/foldbase'

/**
 * Event catalog — the single source of truth for catalog-service payloads.
 * One aggregate: `product`, a per-org catalog entry (SKU + optional list price).
 *
 * Money is integer cents (`priceCents`, never a float). A product with no list
 * price has `priceCents: 0` + `currency: ''` (the "has a price" signal is a
 * non-empty currency, so a genuinely free product sets currency explicitly).
 * Contract/usage pricing (plans, charges) is NOT here — it stays in the billing
 * core; a plan MAY reference a product by id (ADR-010's dual-price rule).
 *
 * Foldbase infers column types from event field types, so optional strings are
 * `''` (never null) and JSON blobs are serialized — stable TEXT columns. Tenant
 * = org id (genuinely per-org partitioned).
 */
export const ProductEvents = defineAggregate('product', {
  ProductCreated: z.object({
    sku: z.string(), // caller-side SKU/code; '' if none
    name: z.string().min(1),
    description: z.string(),
    category: z.string(),
    priceCents: z.number().int(), // 0 if no list price
    currency: z.string(), // ISO-4217; '' = no list price
    labels: z.string(), // JSON string array
    metadata: z.string(), // JSON object, serialized
    shortId: z.string().min(1),
    at: z.number().int(),
  }),
  ProductUpdated: z.object({
    sku: z.string(),
    name: z.string().min(1),
    description: z.string(),
    category: z.string(),
    priceCents: z.number().int(),
    currency: z.string(),
    labels: z.string(),
    metadata: z.string(),
    at: z.number().int(),
  }),
  ProductArchived: z.object({
    reason: z.string().optional(),
  }),
})
