// Aldi Nord: France and Spain, read from each page's Next.js state, and only
// the groceries.
//
// No schema.org block on these pages: the product sits in __NEXT_DATA__ as a
// string of JSON inside it, with the shelf it is filed on beside it. Captured
// from the live sites on 2026-10-03, including a French page kept online for
// search engines after the product was retired (`maintien-seo`, no price) and a
// Spanish one that holds no product at all.

import { describe, it, expect } from 'vitest'
import { readFixture, fixtureFetch, callsOf, collect, testLogger } from './helpers.ts'
import {
  ALDI_NORD_COUNTRIES,
  readAldiNordPage,
  isAldiNordGrocery,
  buildAldiNordProduct,
  aldiNordIdFrom,
} from '../src/retailers/aldi-nord/index.ts'
import { SCRAPERS } from '../src/core/registry.ts'
import { MARKETS } from '../src/core/types.ts'

const page = (name: string): string => readFixture(`aldi-nord/${name}.html.gz`)
const country = (slug: string) => ALDI_NORD_COUNTRIES.find((c) => c.slug === slug)!
const keeps = (slug: string, name: string) => isAldiNordGrocery(country(slug), readAldiNordPage(page(name)))

describe('the Aldi Nord countries', () => {
  it('registers a scraper for each, on its own domain and market', () => {
    for (const c of ALDI_NORD_COUNTRIES) {
      expect(MARKETS).toContain(c.country)
      const scraper = SCRAPERS.find((s) => s.retailer === c.slug)
      expect(scraper, c.slug).toBeDefined()
      expect(`https://www.${scraper!.domain}`).toBe(c.origin)
    }
  })
})

describe('reading a page', () => {
  it('reads the product out of the string inside __NEXT_DATA__', () => {
    expect(readAldiNordPage(page('fr-food'))).toEqual({
      id: '4416',
      name: 'Cornichons extra fins',
      brand: 'REGALO®',
      salesUnit: '360G',
      price: 1.65,
      available: true,
      shelf: 'epiceriesalee',
      aisle: '41-fruits-et-legumes-en-conserve',
    })
  })

  it("falls back to the product's own category when it has no parent", () => {
    expect(readAldiNordPage(page('fr-produce'))).toMatchObject({ shelf: '42-fruits-et-legumes-frais', price: 1.49 })
  })

  it('reads a retired French product as the SEO shelf, with no price', () => {
    expect(readAldiNordPage(page('fr-retired'))).toMatchObject({ shelf: 'maintien-seo', price: null, available: false })
  })

  it('reads nothing from a page that holds no product', () => {
    expect(readAldiNordPage(page('es-gone'))).toBeNull()
    expect(readAldiNordPage('<html><body>redesigned</body></html>')).toBeNull()
  })
})

describe('which shelves are groceries', () => {
  it('keeps food in both countries, fresh produce included', () => {
    expect(keeps('aldi-fr', 'fr-food')).toBe(true)
    expect(keeps('aldi-fr', 'fr-produce')).toBe(true)
    expect(keeps('aldi-es', 'es-food')).toBe(true)
    expect(keeps('aldi-es', 'es-produce')).toBe(true)
  })

  it('drops the retired pages, food or not', () => {
    expect(keeps('aldi-fr', 'fr-retired')).toBe(false) // a deodorant
    expect(keeps('aldi-fr', 'fr-nonfood')).toBe(false) // a fitted sheet
  })

  it('drops makeup and perfume, and not the rest of personal care', () => {
    const care = { id: '1', name: 'x', brand: null, salesUnit: null, price: 1, available: true, shelf: 'cuidado-personal' }
    expect(isAldiNordGrocery(country('aldi-es'), { ...care, aisle: 'maquillaje' })).toBe(false)
    expect(isAldiNordGrocery(country('aldi-es'), { ...care, aisle: 'cosmetica' })).toBe(false) // eau de parfum
    expect(isAldiNordGrocery(country('aldi-es'), { ...care, aisle: 'higiene-bucal' })).toBe(true)
  })

  it('drops the promotion placeholders France files as products', () => {
    const slot = { ...readAldiNordPage(page('fr-food'))!, name: 'Assortment in Promotion II -  Next week offer' }
    expect(isAldiNordGrocery(country('aldi-fr'), slot)).toBe(false)
  })

  it('reads each country against its OWN list', () => {
    const food = readAldiNordPage(page('es-food'))
    expect(isAldiNordGrocery(country('aldi-fr'), food)).toBe(false)
  })
})

describe('building a listing', () => {
  it('takes the size from the sales unit and drops the trademark sign', () => {
    const url = 'https://www.aldi.fr/fiches-produits/cornichons-extra-fins-4416.html'
    const listing = buildAldiNordProduct(readAldiNordPage(page('fr-food'))!, url, country('aldi-fr'))
    expect(listing).toMatchObject({
      retailer: 'aldi-fr',
      externalId: '4416',
      name: 'Cornichons extra fins',
      brand: 'REGALO',
      price: 1.65,
      currency: 'EUR',
      quantity: 360,
      unit: 'g',
      category: 'pantry',
      gtin: null,
      available: true,
    })
  })

  it('reads a Spanish bottle in litres', () => {
    const url = 'https://www.aldi.es/producto/vino-blanco-verdejo-dop-rueda-103700.html'
    const listing = buildAldiNordProduct(readAldiNordPage(page('es-food'))!, url, country('aldi-es'))
    expect(listing).toMatchObject({ externalId: '103700', category: 'alcohol', quantity: 0.75, unit: 'l', price: 3.69 })
  })

  it('keeps a product sold by weight, with no price', () => {
    const url = 'https://www.aldi.es/producto/coliflor-997600.html'
    const listing = buildAldiNordProduct(readAldiNordPage(page('es-produce'))!, url, country('aldi-es'))
    expect(listing).toMatchObject({ name: 'Coliflor', category: 'produce', price: null, currency: null })
  })

  it('puts a shouted name in sentence case', () => {
    const shouted = { ...readAldiNordPage(page('fr-food'))!, name: 'LESSIVE LIQUIDE' }
    expect(buildAldiNordProduct(shouted, 'https://www.aldi.fr/fiches-produits/x-1.html', country('aldi-fr'))!.name).toBe(
      'Lessive liquide',
    )
  })

  it('keeps the leading zero of an id', () => {
    expect(aldiNordIdFrom('https://www.aldi.fr/fiches-produits/potimarron-0811.html')).toBe('0811')
  })
})

describe('crawling a country', () => {
  it('imports the groceries, excludes the rest and fetches no store pages', async () => {
    const urlset = (urls: string[]) =>
      `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
        .map((u) => `<url><loc>${u}</loc></url>`)
        .join('')}</urlset>`
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', body: 'User-agent: *\nDisallow: /can/\n' },
      {
        match: '/sitemaps/.aldi-nord-sitemap-products.xml',
        body: urlset([
          'https://www.aldi.fr/fiches-produits/cornichons-extra-fins-4416.html',
          'https://www.aldi.fr/fiches-produits/potimarron-0811.html',
          'https://www.aldi.fr/fiches-produits/deodorant-apollo-5026548.html',
          'https://www.aldi.fr/magasins-et-horaires-d-ouverture/arles/3-rue-de-sagne/3435376.html',
        ]),
      },
      { match: 'cornichons', file: 'aldi-nord/fr-food.html.gz' },
      { match: 'potimarron', file: 'aldi-nord/fr-produce.html.gz' },
      { match: 'deodorant', file: 'aldi-nord/fr-retired.html.gz' },
    ])
    const excluded: string[] = []
    const scraper = SCRAPERS.find((s) => s.retailer === 'aldi-fr')!
    const products = await collect(
      scraper.discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        reportExcluded: async (id) => void excluded.push(id),
      }),
    )
    expect(products.map((p) => p.externalId)).toEqual(['4416', '0811'])
    expect(excluded).toEqual(['5026548'])
    expect(callsOf(fetchImpl).some((u) => u.includes('magasins'))).toBe(false)
  })
})
