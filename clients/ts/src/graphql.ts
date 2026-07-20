import type { createCatalogClient } from './client.js'

/** GraphQL read module for the catalog capability — products (org-level). */
export interface CatalogGraphContext {
  catalog: ReturnType<typeof createCatalogClient>
}

export const typeDefs = /* GraphQL */ `
  type Product {
    id: ID!
    shortId: String!
    sku: String
    name: String!
    description: String
    category: String
    priceCents: Int
    currency: String
    createdAt: Float!
  }
  extend type Query {
    product(ref: String!): Product
    products(limit: Int, offset: Int): [Product!]!
  }
`

export const resolvers = {
  Query: {
    product: (_: unknown, { ref }: { ref: string }, ctx: CatalogGraphContext) => ctx.catalog.get(ref).catch(() => null),
    products: (_: unknown, args: { limit?: number; offset?: number }, ctx: CatalogGraphContext) => ctx.catalog.list(args),
  },
}
