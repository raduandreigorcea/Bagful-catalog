// Morrisons: read from the category pages' state, because the product pages
// answer 403. The fixture is the live Household page captured on 2026-10-05 and
// trimmed to the fields the reader uses; it holds a pack of facial tissues filed
// under a themed aisle ("Savers"), which is the case the grocery rule exists for.

import { describe, it, expect } from 'vitest'
import { readFixture, fixtureFetch, callsOf, collect, testLogger } from './helpers.ts'
import {
  readMorrisonsPage,
  buildMorrisonsProduct,
  morrisonsPathOf,
  morrisonsSlug,
  isMorrisonsGroceryPath,
  isMorrisonsNonGrocery,
} from '../src/retailers/morrisons/index.ts'
import { SCRAPERS } from '../src/core/registry.ts'

const household = () => readMorrisonsPage(readFixture('morrisons/household.html.gz'))!

describe('reading a category page', () => {
  it('reads every product in the state', () => {
    const products = household()
    expect(products).toHaveLength(50)
    expect(products[0]).toMatchObject({ retailerProductId: '115670776', brand: 'Dylon', size: { value: '1543ml' } })
  })

  it('reads nothing from a page without the state, so a redesign is loud', () => {
    expect(readMorrisonsPage('<html>Request blocked.</html>')).toBeNull()
  })
})

describe('which products are groceries', () => {
  it('makes the same slugs as the shop URLs', () => {
    expect(morrisonsSlug('Make Up & Nails')).toBe('make-up-nails')
    expect(morrisonsSlug("Men's Toiletries")).toBe('men-s-toiletries')
    expect(morrisonsSlug('Beer, Wines & Spirits')).toBe('beer-wines-spirits')
  })

  it('fetches grocery category pages only', () => {
    expect(isMorrisonsGroceryPath('household/laundry')).toBe(true)
    expect(isMorrisonsGroceryPath('toiletries-beauty/hair-care')).toBe(true)
    expect(isMorrisonsGroceryPath('toiletries-beauty/make-up-nails/lipstick')).toBe(false)
    expect(isMorrisonsGroceryPath('toys-clothing-entertainment')).toBe(false)
    expect(isMorrisonsGroceryPath('events-inspiration-ways-to-save/savers')).toBe(false)
  })

  it('keeps a grocery filed under a themed aisle, and refuses only positive evidence', () => {
    const tissues = household().find((p) => p.retailerProductId === '113178622')!
    expect(morrisonsPathOf(tissues)).toMatch(/^events-inspiration-ways-to-save\//)
    expect(isMorrisonsNonGrocery(morrisonsPathOf(tissues))).toBe(false)
    expect(isMorrisonsNonGrocery('toiletries-beauty/make-up-nails/nail-polish')).toBe(true)
    expect(isMorrisonsNonGrocery('kiosk/cigarettes')).toBe(true)
  })
})

describe('building a listing', () => {
  it('reads price in pounds and the size from the pack size', () => {
    expect(buildMorrisonsProduct(household()[0], 'household')).toEqual({
      retailer: 'morrisons',
      externalId: '115670776',
      name: 'Dylon Light and White Colour Washing Detergent Liquid 30 Washes',
      brand: 'Dylon',
      gtin: null,
      price: 7,
      currency: 'GBP',
      quantity: 1543,
      unit: 'ml',
      category: 'household',
      productUrl: 'https://groceries.morrisons.com/products/dylon-light-and-white-colour-washing-detergent-liquid-30-washes/115670776',
      available: true,
    })
  })

  it('takes the shelf from the page for a product filed under a themed aisle', () => {
    const tissues = household().find((p) => p.retailerProductId === '113178622')!
    expect(buildMorrisonsProduct(tissues, 'household')!.category).toBe('household')
  })
})

describe('crawling', () => {
  it('reads the grocery pages from the sitemap, never a product page, and dedupes', async () => {
    const page = 'https://groceries.morrisons.com/categories/household/102063'
    const excluded: string[] = []
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', body: 'User-agent: *\nDisallow: /api/\n' },
      {
        match: 'sitemap-categories-part1.xml',
        body: `<urlset>${[page, `${page.replace('102063', '1')}/laundry/2`, 'https://groceries.morrisons.com/categories/kiosk/193483']
          .map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`,
      },
      { match: '/categories/household/', file: 'morrisons/household.html.gz' },
    ])
    const scraper = SCRAPERS.find((s) => s.retailer === 'morrisons')!
    expect(scraper.sweeps).toBe(false)
    const products = await collect(
      scraper.discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        reportExcluded: async (id) => void excluded.push(id),
      }),
    )
    expect(products).toHaveLength(50)
    expect(excluded).toEqual([])
    const calls = callsOf(fetchImpl)
    expect(calls.some((u) => u.includes('kiosk'))).toBe(false)
    expect(calls.some((u) => u.includes('/products/'))).toBe(false)
  })
})
