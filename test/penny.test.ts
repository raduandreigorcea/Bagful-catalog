// Penny Romania: its current offers, one product page each, with the Product
// block carried in an HTML attribute. Pages captured 2026-09-29.

import { describe, it, expect } from 'vitest'
import { readFixture, fixtureFetch, callsOf, collect, testLogger } from './helpers.ts'
import { extractJsonLd, findProduct, readProduct } from '../src/core/jsonld.ts'
import { pennyPath, pennyIsGrocery, pennyIdFrom, buildPennyProduct } from '../src/retailers/penny/index.ts'
import { SCRAPERS } from '../src/core/registry.ts'

const MEAT = 'https://www.penny.ro/products/hanul-boieresc-ceafa-porc-fara-os-feliata-rr922548'
const BEER = 'https://www.penny.ro/products/carlsberg-bere-blonda-52alc-garantie-sgr-050-ron-rr963910'
const SUPPLEMENT = 'https://www.penny.ro/products/respiran-hyal-spray-nazal-rr968087'

const listing = (file: string, url: string) => {
  const html = readFixture(file)
  return buildPennyProduct(readProduct(findProduct(extractJsonLd(html))!), url, pennyPath(html))
}

describe('penny: the page', () => {
  it('finds the Product block inside an attribute', () => {
    expect(findProduct(extractJsonLd(readFixture('penny/meat.html.gz')))).not.toBeNull()
  })

  it('reads the shop category rather than the promotion it sits in', () => {
    expect(pennyPath(readFixture('penny/meat.html.gz'))).toBe('carne, mezeluri si peste > carne proaspata porc si vita')
    expect(pennyIsGrocery(pennyPath(readFixture('penny/supplement.html.gz')))).toBe(false)
  })

  it('takes the id from the URL, in the sku form', () => {
    expect(pennyIdFrom(MEAT)).toBe('RR-922548')
    expect(pennyIdFrom('https://www.penny.ro/categorie/vin-5732')).toBeNull()
  })
})

describe('penny: a listing', () => {
  it('writes a shouted name and brand in normal case, with no price', () => {
    expect(listing('penny/meat.html.gz', MEAT)).toMatchObject({
      retailer: 'penny',
      externalId: 'RR-922548',
      name: 'Hanul boieresc ceafa porc fara os feliata',
      brand: 'Hanul Boieresc',
      category: 'meat',
      price: null,
      available: true,
    })
  })

  it('drops the bottle deposit from the name', () => {
    expect(listing('penny/beer.html.gz', BEER)).toMatchObject({ name: 'Carlsberg bere blonda 5.2%alc', category: 'alcohol' })
  })

  it('skips an offer that is not one product', () => {
    const product = readProduct(findProduct(extractJsonLd(readFixture('penny/beer.html.gz')))!)
    expect(buildPennyProduct({ ...product, name: '1958 VIN ALB/ROSU/ROSE DEMISEC' }, BEER, null)).toBeNull()
    expect(buildPennyProduct({ ...product, name: 'CLEAR SAMPON DIVERSE SORTIMENTE' }, BEER, null)).toBeNull()
  })
})

describe('penny: the crawl', () => {
  it('imports the groceries, reports the rest, and never sweeps', async () => {
    const excluded: string[] = []
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', body: 'Sitemap: https://www.penny.ro/sitemap.xml' },
      {
        match: 'sitemap.xml',
        body: `<urlset><url><loc>https://www.penny.ro/retete/balmos</loc></url><url><loc>${MEAT}</loc></url><url><loc>${BEER}</loc></url><url><loc>${SUPPLEMENT}</loc></url></urlset>`,
      },
      { match: '-rr922548', file: 'penny/meat.html.gz' },
      { match: '-rr963910', file: 'penny/beer.html.gz' },
      { match: '-rr968087', file: 'penny/supplement.html.gz' },
    ])
    const scraper = SCRAPERS.find((s) => s.retailer === 'penny')!
    const products = await collect(scraper.discoverProducts({
      log: testLogger(),
      fetchImpl,
      minIntervalMs: 0,
      reportExcluded: (id: string) => excluded.push(id),
    }))
    expect(products.map((p) => p.externalId)).toEqual(['RR-922548', 'RR-963910'])
    expect(excluded).toEqual(['RR-968087'])
    expect(callsOf(fetchImpl).some((u) => u.includes('/retete/'))).toBe(false)
    expect(scraper.sweeps).toBe(false)
  })
})
