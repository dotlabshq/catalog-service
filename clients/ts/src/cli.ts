import { Command } from 'commander'
import { clr, kv, table, summary, success, warn, fatal, printOutput, outputOption } from '@baseworks/cli/display'
import { fmtDate } from '@baseworks/cli/fmt'
import type { ColDef } from '@baseworks/cli/display'
import type { ApiClient } from '@baseworks/cli/client'

/**
 * Importable `catalog` command group for any CLI. The `http` ApiClient points at
 * the app's catalog mount and carries the caller's identity token; it must also
 * send the active org (X-Org-Id) — products are org-scoped. Mounts as:
 *
 *   program.addCommand(buildCatalogCommand({ http, cliName: 'dtab' }))
 *
 * Usage: `dtab catalog` (list) · `cat` / `products` aliases · `catalog create` ·
 *        `catalog get <ref>` · `catalog update <ref>` · `catalog delete <ref>`
 */
export interface CatalogCliDeps {
  http: ApiClient
  cliName?: string
}

type ProductRow = {
  id: string
  short_id: string
  sku: string | null
  name: string
  category: string | null
  price_cents: number | null
  currency: string | null
  created_at?: number
}

const die = (e: unknown): never => fatal(e instanceof Error ? e.message : String(e))

/** Integer cents + currency → a display string (e.g. `12.50 USD`, or `—`). */
function fmtPrice(cents: number | null, currency: string | null): string {
  if (cents === null || !currency) return '—'
  return `${(cents / 100).toFixed(2)} ${currency}`
}

function parseKvPairs(pairs: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pairs ?? []) {
    const i = p.indexOf('=')
    if (i < 0) fatal(`--meta expects key=value, got '${p}'`)
    out[p.slice(0, i)] = p.slice(i + 1)
  }
  return out
}

/** `12.50` | `12` → integer cents (1250 / 1200). Rejects sub-cent precision. */
function priceToCents(price: string): number {
  const n = Number(price)
  if (!Number.isFinite(n) || n < 0) fatal(`--price must be a non-negative number, got '${price}'`)
  const cents = Math.round(n * 100)
  if (Math.abs(cents - n * 100) > 1e-6) fatal(`--price has sub-cent precision: '${price}'`)
  return cents
}

export function buildCatalogCommand(deps: CatalogCliDeps): Command {
  const { http } = deps
  const cli = deps.cliName ?? 'cli'

  const listProducts = async (opts: { output: string }) => {
    const res = await http.get<{ products: ProductRow[] }>('/catalog').catch(die)
    printOutput(res.products, opts.output, (wide) => {
      table(res.products, [
        { key: 'short_id', label: 'ID' },
        { key: 'sku', label: 'SKU', fmt: (v) => (v as string) ?? '' },
        { key: 'name', label: 'NAME' },
        { key: 'price_cents', label: 'PRICE', fmt: (_v, row) => fmtPrice((row as ProductRow).price_cents, (row as ProductRow).currency) },
        { key: 'category', label: 'CATEGORY', wide: true, fmt: (v) => (v as string) ?? '' },
        { key: 'created_at', label: 'CREATED', wide: true, fmt: (v) => fmtDate(v as number) },
        { key: 'id', label: 'FULL ID', wide: true },
      ] as ColDef<ProductRow>[], { wide, emptyHint: `No products yet.  Run: ${cli} catalog create --name <n>` })
      summary(`${res.products.length} product${res.products.length !== 1 ? 's' : ''}`)
    }, 'id')
  }

  // `catalog` (bare) → list. `cat` / `products` aliases; `catalog ls` is the same.
  const cmd = new Command('catalog')
    .aliases(['cat', 'products'])
    .description('Manage products / catalog (org-scoped — run `use <org>` first)')
    .option(...outputOption())
    .action(listProducts)

  cmd.addCommand(
    new Command('ls')
      .description('List products (alias of the bare command)')
      .option(...outputOption())
      .action(function (this: Command) {
        const self = this.opts() as { output?: string }
        const parent = (this.parent?.opts() ?? {}) as { output?: string }
        return listProducts({ output: self.output && self.output !== 'table' ? self.output : parent.output ?? 'table' })
      }),
  )

  cmd.addCommand(
    new Command('create')
      .description('Create a product')
      .requiredOption('--name <name>', 'Display name')
      .option('--sku <sku>', 'Caller-side SKU/code')
      .option('--description <text>', 'Description')
      .option('--category <cat>', 'Category')
      .option('--price <amount>', 'List price, e.g. 12.50 (requires --currency)')
      .option('--currency <cur>', 'ISO-4217 currency (e.g. USD)')
      .option('--label <label...>', 'Label (repeatable)')
      .option('--meta <k=v...>', 'Metadata key=value (repeatable)')
      .action(async (opts: { name: string; sku?: string; description?: string; category?: string; price?: string; currency?: string; label?: string[]; meta?: string[] }) => {
        if (opts.price !== undefined && !opts.currency) fatal('--price requires --currency')
        const body = {
          name: opts.name,
          ...(opts.sku ? { sku: opts.sku } : {}),
          ...(opts.description ? { description: opts.description } : {}),
          ...(opts.category ? { category: opts.category } : {}),
          ...(opts.price !== undefined ? { price_cents: priceToCents(opts.price) } : {}),
          ...(opts.currency ? { currency: opts.currency } : {}),
          ...(opts.label ? { labels: opts.label } : {}),
          ...(opts.meta ? { metadata: parseKvPairs(opts.meta) } : {}),
        }
        const res = await http.post<{ product: ProductRow }>('/catalog', body).catch(die)
        success(`Product created: ${res.product.name}`)
        kv([['id', res.product.short_id], ['name', res.product.name], ['price', fmtPrice(res.product.price_cents, res.product.currency)]])
      }),
  )

  cmd.addCommand(
    new Command('get').argument('<ref>', 'id, short_id, or sku')
      .description('Show product details')
      .option(...outputOption())
      .action(async (ref: string, opts: { output: string }) => {
        const res = await http.get<{ product: Record<string, unknown> }>(`/catalog/${ref}`).catch(die)
        const p = res.product as Record<string, unknown>
        printOutput(p, opts.output, () => {
          kv([
            ['id', String(p['short_id'])],
            ['name', String(p['name'])],
            ['sku', (p['sku'] as string) ?? '—'],
            ['price', fmtPrice((p['price_cents'] as number) ?? null, (p['currency'] as string) ?? null)],
            ['category', (p['category'] as string) ?? '—'],
            ['description', (p['description'] as string) ?? '—'],
            ['labels', ((p['labels'] as string[]) ?? []).join(', ') || '—'],
            ['full_id', String(p['id'])],
          ])
          const meta = (p['metadata'] as Record<string, unknown>) ?? {}
          if (Object.keys(meta).length) {
            console.log(`  ${clr.dim}── metadata ──${clr.reset}`)
            kv(Object.entries(meta).map(([k, v]) => [k, JSON.stringify(v)] as [string, string]))
          }
        }, 'id')
      }),
  )

  cmd.addCommand(
    new Command('update').argument('<ref>')
      .description('Update a product')
      .option('--name <name>', 'New name')
      .option('--sku <sku>', 'Caller-side SKU/code')
      .option('--description <text>', 'Description')
      .option('--category <cat>', 'Category')
      .option('--price <amount>', 'List price, e.g. 12.50')
      .option('--currency <cur>', 'ISO-4217 currency')
      .option('--label <label...>', 'Labels (replaces existing)')
      .option('--meta <k=v...>', 'Metadata key=value (repeatable)')
      .action(async (ref: string, opts: { name?: string; sku?: string; description?: string; category?: string; price?: string; currency?: string; label?: string[]; meta?: string[] }) => {
        const body: Record<string, unknown> = {}
        if (opts.name !== undefined) body['name'] = opts.name
        if (opts.sku !== undefined) body['sku'] = opts.sku
        if (opts.description !== undefined) body['description'] = opts.description
        if (opts.category !== undefined) body['category'] = opts.category
        if (opts.price !== undefined) body['price_cents'] = priceToCents(opts.price)
        if (opts.currency !== undefined) body['currency'] = opts.currency
        if (opts.label !== undefined) body['labels'] = opts.label
        if (opts.meta !== undefined) body['metadata'] = parseKvPairs(opts.meta)
        if (!Object.keys(body).length) { warn('Provide at least one field to update.'); return }
        const res = await http.patch<{ product: ProductRow }>(`/catalog/${ref}`, body).catch(die)
        success('Product updated.')
        kv([['id', res.product.short_id], ['name', res.product.name], ['price', fmtPrice(res.product.price_cents, res.product.currency)]])
      }),
  )

  cmd.addCommand(
    new Command('delete').alias('rm').argument('<ref>')
      .description('Delete a product')
      .action(async (ref: string) => {
        await http.del(`/catalog/${ref}`).catch(die)
        success(`Product deleted: ${ref}`)
      }),
  )

  return cmd
}
