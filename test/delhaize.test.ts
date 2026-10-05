// Delhaize Belgium: groceries by the department in the URL, one language, and a
// price read out of the offer's priceSpecification. Page captured 2026-09-14.

import { describe, it, expect } from 'vitest'
import { readFixture, fixtureFetch, callsOf, collect, testLogger } from './helpers.ts'
import { extractJsonLd, findProduct, readProduct } from '../src/core/jsonld.ts'
import { delhaizeIsGrocery, delhaizeIdFrom, buildDelhaizeProduct, delhaizeDepartments } from '../src/retailers/delhaize/index.ts'
import { SCRAPERS } from '../src/core/registry.ts'

const url = (path: string) => `https://www.delhaize.be${path}`
const MUSHROOMS = url('/nl/shop/Verse-groenten-en-fruit/Verse-groenten/Champignons/Witte-champignons/Witte-champignons-Belgisch/p/F2015021100304110000')
const DECORATION = url('/nl/shop/Keuken-wonen-en-vrije-tijd/Huisdecoratie/Kaarsen/Geurkaars-Vanille/p/S2023010100000000000')

describe('delhaize: which departments are groceries', () => {
  it('keeps the supermarket, including the kitchen corner of the home aisle', () => {
    expect(delhaizeIsGrocery(MUSHROOMS)).toBe(true)
    expect(delhaizeIsGrocery(url('/nl/shop/Onderhoud-en-huishouden/Wassen/Wasmiddel/p/S1'))).toBe(true)
    expect(delhaizeIsGrocery(url('/nl/shop/Keuken-wonen-en-vrije-tijd/Keukengerei-en-accessoires/Garde/p/S2'))).toBe(true)
  })

  it('drops decorations, plants, electrics and party accessories', () => {
    expect(delhaizeIsGrocery(DECORATION)).toBe(false)
    expect(delhaizeIsGrocery(url('/nl/shop/Keuken-wonen-en-vrije-tijd/Insecten-en-planten/Orchidee/p/S3'))).toBe(false)
    expect(delhaizeIsGrocery(url('/nl/shop/Keuken-wonen-en-vrije-tijd/Elektriciteit/Lamp/p/S4'))).toBe(false)
    expect(delhaizeIsGrocery(url('/nl/shop/Eindejaarsproducten/Feest-accessoires/Slingers/p/S5'))).toBe(false)
    expect(delhaizeIsGrocery(url('/nl/shop/Hygiene-en-verzorging/Make-up/Mascara/Mascara-Zwart/p/S6'))).toBe(false)
    expect(delhaizeIsGrocery(url('/nl/shop/Hygiene-en-verzorging/Shampoos/Shampoo/p/S7'))).toBe(true)
  })

  it('refuses a French page and anything that is not a product', () => {
    expect(delhaizeIdFrom(url('/fr/shop/Legumes/Champignons/p/F2015021100304110000'))).toBeNull()
    expect(delhaizeIdFrom(url('/nl/shop/Verse-groenten-en-fruit/c/v2VEG'))).toBeNull()
  })
})

describe('delhaize: a listing', () => {
  it('reads the price from the priceSpecification and the department as a shelf', () => {
    const html = readFixture('delhaize/food.html.gz')
    const listing = buildDelhaizeProduct(readProduct(findProduct(extractJsonLd(html))!), MUSHROOMS)!
    expect(listing).toMatchObject({
      retailer: 'delhaize',
      externalId: 'F2015021100304110000',
      brand: 'Delhaize',
      currency: 'EUR',
      category: 'produce',
      gtin: null,
      available: true,
    })
    expect(listing.price).toBeGreaterThan(0)
  })
})

describe('delhaize: the crawl', () => {
  it('fetches the groceries, never the decorations, and reports what it skipped', async () => {
    const excluded: string[] = []
    let coverage: [number, number] | null = null
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', body: 'User-agent: *\nDisallow: /login\n' },
      // The homepage tiles, then one department: a page of two products
      // (each linked twice, as the image and the name are), then an empty page.
      { match: /\.be\/nl$/, body: '<a href="/c/v2FRU">Fruit</a><a href="/c/v2FRU">Fruit</a>' },
      {
        match: '/c/v2FRU?pageNumber=0',
        body: [MUSHROOMS, MUSHROOMS, DECORATION, url('/fr/shop/Legumes/p/F2015021100304110000')]
          .map((u) => `<a href="${new URL(u).pathname}">x</a>`).join(''),
      },
      { match: '/c/v2FRU?pageNumber=1', body: '<div>0 producten</div>' },
      { match: '/p/F2015021100304110000', file: 'delhaize/food.html.gz' },
    ])
    const products = await collect(
      SCRAPERS.find((s) => s.retailer === 'delhaize')!.discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        reportExcluded: (id: string) => excluded.push(id),
        reportCoverage: (seen: number, advertised: number) => {
          coverage = [seen, advertised]
        },
      }),
    )
    expect(products).toHaveLength(1)
    expect(excluded).toEqual(['S2023010100000000000'])
    expect(callsOf(fetchImpl).some((u) => u.includes('Huisdecoratie'))).toBe(false)
    expect(coverage).toEqual([2, 2])
  })
})

describe('delhaize: the departments the homepage links', () => {
  it('reads each tile once', () => {
    expect(delhaizeDepartments('<a href="/c/v2DRI">x</a><a href="/c/v2DRI">x</a><a href="/c/v2ALC">x</a><a href="/nl/shop/Baby/c/v2BAB">x</a>'))
      .toEqual(['v2DRI', 'v2ALC'])
  })
})

describe('delhaize: a nightly slice', () => {
  it('walks only its share of the departments, and reads every product in them', async () => {
    const page = (path: string) => `<a href="${path}">x</a>`
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', body: 'User-agent: *\nDisallow: /login\n' },
      { match: /\.be\/nl$/, body: '<a href="/c/v2FRU">a</a><a href="/c/v2DRI">b</a><a href="/c/v2BAB">c</a>' },
      { match: '/c/v2DRI?pageNumber=0', body: page('/nl/shop/Koude-en-warme-dranken/Water/Spa/p/S1') + page('/nl/shop/Koude-en-warme-dranken/Thee/Thee/p/S2') },
      { match: '/p/S', file: 'delhaize/food.html.gz' },
    ])
    const products = await collect(
      SCRAPERS.find((s) => s.retailer === 'delhaize')!.discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        shard: { index: 1, of: 3 },
      }),
    )
    const calls = callsOf(fetchImpl)
    expect(calls.some((u) => u.includes('v2FRU') || u.includes('v2BAB'))).toBe(false)
    expect(calls.filter((u) => u.includes('/p/S'))).toHaveLength(2)
    expect(products).toHaveLength(2)
  })
})
