// SuperValu Ireland: read from the department listings' page state, never from
// the product pages. The fixture is a live listing (Everyday Biscuits, page 1)
// captured on 2026-10-05 and trimmed to the state script and the product links.

import { describe, it, expect } from 'vitest'
import { readFixture, fixtureFetch, callsOf, collect, testLogger } from './helpers.ts'
import {
  readSuperValuPage,
  isSuperValuGrocery,
  buildSuperValuProduct,
  SUPERVALU_DEPARTMENTS,
} from '../src/retailers/supervalu/index.ts'
import type { SuperValuCard } from '../src/retailers/supervalu/index.ts'
import { SCRAPERS } from '../src/core/registry.ts'

const listing = () => readSuperValuPage(readFixture('supervalu/biscuits.html.gz'))!

/** A listing page as the shop renders one, holding `cards` of `total`. */
function page(cards: SuperValuCard[], total: number): string {
  const state = {
    search: {
      pagination: { category: { totalItems: total, activePage: 1, itemsPerPage: 30 } },
      products: { category: cards.map((c) => c.sku) },
      productCardDictionary: Object.fromEntries(cards.map((c) => [c.sku, c])),
    },
  }
  return `<script>window.__PRELOADED_STATE__ = ${JSON.stringify(state)};</script><script>var other = {"a":1}</script>`
}
const card = (sku: string, ...categories: string[]): SuperValuCard => ({
  sku,
  name: `Product ${sku} (500 g)`,
  brand: 'SuperValu',
  price: '€1.29',
  available: true,
  sellBy: 'each',
  categories: categories.map((retailerId) => ({ retailerId })),
})

describe('reading a listing', () => {
  it('reads the cards in the order shown, the total, and the product links', () => {
    const read = listing()
    expect(read.total).toBe(102)
    expect(read.cards).toHaveLength(30)
    expect(read.cards[0]).toMatchObject({ sku: '1026676001', name: 'SuperValu Milk Chocolate Digestives Biscuits (300 g)' })
    expect(read.links.get('1026676001')).toBe(
      'https://shop.supervalu.ie/product/supervalu-milk-chocolate-digestives-biscuits-300-g-id-1026676001',
    )
  })

  it('reads nothing from a page without the state, so a redesign is loud', () => {
    expect(readSuperValuPage('<html><body>new design</body></html>')).toBeNull()
  })
})

describe('building a listing', () => {
  it('takes the price in euro, the size from the name and the shelf from the department', () => {
    const read = listing()
    const first = read.cards[0]
    expect(buildSuperValuProduct(first, 'O100035', read.links.get(first.sku!))).toEqual({
      retailer: 'supervalu',
      externalId: '1026676001',
      name: 'SuperValu Milk Chocolate Digestives Biscuits (300 g)',
      brand: 'SuperValu',
      gtin: null,
      price: 0.79,
      currency: 'EUR',
      quantity: 300,
      unit: 'g',
      category: 'pantry',
      productUrl: 'https://shop.supervalu.ie/product/supervalu-milk-chocolate-digestives-biscuits-300-g-id-1026676001',
      available: true,
    })
  })

  it('leaves out the estimate on a product sold by weight', () => {
    expect(buildSuperValuProduct({ ...card('7'), sellBy: 'weight' }, 'O100015', undefined)).toMatchObject({ price: null, currency: null })
  })

  it('falls back to the id-only product URL, which the shop answers', () => {
    expect(buildSuperValuProduct(card('7'), 'O100015', undefined)!.productUrl).toBe('https://shop.supervalu.ie/product/id-7')
  })
})

describe('which products are groceries', () => {
  it('keeps food and personal care, and drops cosmetics, supplements and batteries', () => {
    expect(isSuperValuGrocery(card('1', 'Grocery', 'O100035', 'O200335'))).toBe(true)
    expect(isSuperValuGrocery(card('2', 'Grocery', 'O100055', 'O200455'))).toBe(true)
    expect(isSuperValuGrocery(card('3', 'Grocery', 'O100055', 'O200495'))).toBe(false)
    expect(isSuperValuGrocery(card('4', 'Grocery', 'O100027', 'O200690'))).toBe(false)
    expect(isSuperValuGrocery(card('5', 'Grocery', 'O100065', 'O200560'))).toBe(false)
  })

  it('never reads the newsagent and tobacconist department', () => {
    expect(Object.keys(SUPERVALU_DEPARTMENTS)).not.toContain('O100080')
  })
})

describe('crawling', () => {
  it('pages through each department, imports the groceries and reports coverage', async () => {
    const depts = Object.keys(SUPERVALU_DEPARTMENTS)
    const routes = depts.map((d) => ({ match: `-id-${d}?page=1&`, body: page([], 0) }))
    // The first department: two pages of a 31-product listing, one card on the
    // second excluded as cosmetics.
    const full = Array.from({ length: 30 }, (_, i) => card(String(100 + i), 'O100001'))
    routes[0] = { match: `-id-${depts[0]}?page=1&skip=0`, body: page(full, 31) }
    const excluded: string[] = []
    let coverage: [number, number] | null = null
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', body: 'User-agent: *\nAllow: /\n' },
      { match: `-id-${depts[0]}?page=2&skip=30`, body: page([card('999', 'O100055', 'O200495')], 31) },
      ...routes,
    ])
    const products = await collect(
      SCRAPERS.find((s) => s.retailer === 'supervalu')!.discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        reportExcluded: async (id) => void excluded.push(id),
        reportCoverage: (seen, advertised) => {
          coverage = [seen, advertised]
        },
      }),
    )
    expect(products).toHaveLength(30)
    expect(excluded).toEqual(['999'])
    expect(coverage).toEqual([31, 31])
    expect(callsOf(fetchImpl).some((u) => u.includes(`${depts[0]}?page=3`))).toBe(false)
    expect(callsOf(fetchImpl).some((u) => u.includes('/product/'))).toBe(false)
  })

  it('stops and says so when a listing cannot be read', async () => {
    const reasons: string[] = []
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', body: 'User-agent: *\nAllow: /\n' },
      { match: '-id-O100001?page=1', body: '<html>maintenance</html>' },
    ])
    const products = await collect(
      SCRAPERS.find((s) => s.retailer === 'supervalu')!.discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        reportIncomplete: (reason) => void reasons.push(reason),
      }),
    )
    expect(products).toHaveLength(0)
    expect(reasons).toHaveLength(1)
  })
})
