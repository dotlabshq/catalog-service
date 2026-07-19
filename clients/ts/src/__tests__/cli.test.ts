/// <reference types="vitest/globals" />
import { beforeAll, afterEach, afterAll, describe, it, expect } from 'vitest'
import { run, mocks, server } from './helpers.js'

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const PROD = {
  id: '019f6a3e-1111-7c71-beff-496d1be3fd1f',
  shortId: 'prd9x2',
  sku: 'WIDGET-1',
  name: 'Blue Widget',
  description: 'A blue widget',
  category: 'widgets',
  priceCents: 1250,
  currency: 'USD',
  labels: ['featured'],
  metadata: { color: 'blue' },
  createdAt: 1784200000000,
  updatedAt: 1784200000000,
}
const PROD2 = { ...PROD, id: '019f6a3e-2222-7c71-beff-496d1be3fd1f', shortId: 'prd7k1', sku: 'GADGET-2', name: 'Gadget', priceCents: null, currency: null }

describe('dtab catalog (list)', () => {
  it('default columns: ID → SKU → NAME → PRICE, no full UUID', async () => {
    mocks.mockGet('/v1/catalog', { products: [PROD, PROD2] })
    const r = await run(['catalog'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('prd9x2')
    expect(r.stdout).toContain('WIDGET-1')
    expect(r.stdout).toContain('Blue Widget')
    expect(r.stdout).toContain('12.50 USD') // integer cents → display
    expect(r.stdout).not.toContain(PROD.id)
  })

  it('cat + products aliases list', async () => {
    mocks.mockGet('/v1/catalog', { products: [PROD] })
    const a = await run(['cat'])
    expect(a.stdout).toContain('prd9x2')
    mocks.mockGet('/v1/catalog', { products: [PROD] })
    const b = await run(['products'])
    expect(b.stdout).toContain('prd9x2')
  })

  it('catalog ls -o wide shows CATEGORY + FULL ID', async () => {
    mocks.mockGet('/v1/catalog', { products: [PROD] })
    const r = await run(['catalog', 'ls', '-o', 'wide'])
    expect(r.stdout).toContain('CATEGORY')
    expect(r.stdout).toContain('widgets')
    expect(r.stdout).toContain('FULL ID')
    expect(r.stdout).toContain(PROD.id)
  })

  it('product with no price shows —', async () => {
    mocks.mockGet('/v1/catalog', { products: [PROD2] })
    const r = await run(['catalog'])
    expect(r.stdout).toContain('—')
  })

  it('-o json returns raw array', async () => {
    mocks.mockGet('/v1/catalog', { products: [PROD] })
    const r = await run(['catalog', '-o', 'json'])
    const parsed = JSON.parse(r.stdout)
    expect(parsed[0].shortId).toBe('prd9x2')
  })
})

describe('dtab catalog create', () => {
  it('converts --price to integer cents + sends fields', async () => {
    const captured = mocks.mockPostCapture('/v1/catalog', { product: PROD })
    const r = await run(['catalog', 'create', '--name', 'Blue Widget', '--sku', 'WIDGET-1', '--price', '12.50', '--currency', 'USD', '--category', 'widgets', '--label', 'featured', '--meta', 'color=blue'])
    expect(r.exitCode).toBe(0)
    const body = captured.body as Record<string, unknown>
    expect(body.priceCents).toBe(1250)
    expect(body.currency).toBe('USD')
    expect(body.sku).toBe('WIDGET-1')
    expect(body.labels).toEqual(['featured'])
    expect(body.metadata).toEqual({ color: 'blue' })
  })

  it('rejects --price without --currency', async () => {
    const r = await run(['catalog', 'create', '--name', 'X', '--price', '5'])
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('--price requires --currency')
  })

  it('rejects sub-cent price', async () => {
    const r = await run(['catalog', 'create', '--name', 'X', '--price', '1.999', '--currency', 'USD'])
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('sub-cent')
  })
})

describe('dtab catalog get / update / delete', () => {
  it('get by sku shows price + labels', async () => {
    mocks.mockGet('/v1/catalog/WIDGET-1', { product: PROD })
    const r = await run(['catalog', 'get', 'WIDGET-1'])
    expect(r.stdout).toContain('12.50 USD')
    expect(r.stdout).toContain('featured')
    const idLine = r.stdout.split('\n').find((l) => /^\s+id\s/.test(l))
    expect(idLine).toContain('prd9x2')
    expect(idLine).not.toContain(PROD.id)
  })

  it('update sends only changed fields', async () => {
    const captured = mocks.mockPatchCapture('/v1/catalog/prd9x2', { product: { ...PROD, priceCents: 999 } })
    const r = await run(['catalog', 'update', 'prd9x2', '--price', '9.99', '--currency', 'USD'])
    expect(r.exitCode).toBe(0)
    expect((captured.body as Record<string, unknown>).priceCents).toBe(999)
  })

  it('delete (rm alias) works', async () => {
    mocks.mockDelete('/v1/catalog/prd9x2')
    const r = await run(['catalog', 'rm', 'prd9x2'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('prd9x2')
  })
})
