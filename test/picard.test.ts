// Picard: frozen food, read from the schema.org microdata and the breadcrumb on
// each product page. Pages captured from the live site on 2026-10-05: green
// beans, a cool box filed under the grocery department, and a product page that
// lists two barcodes.

import { describe, it, expect } from 'vitest'
import { readFixture, fixtureFetch, callsOf, collect, testLogger } from './helpers.ts'
import { readPicardPage, isPicardGrocery, buildPicardProduct, picardIdFrom } from '../src/retailers/picard/index.ts'
import { SCRAPERS } from '../src/core/registry.ts'

const BEANS = 'https://www.picard.fr/produits/haricots-verts-tres-fins-sans-residu-pesticides-000000000000087958.html'
const COOLER = 'https://www.picard.fr/produits/glaciere-coton-color-bloc-000000000000030635.html'
const MUSSELS = 'https://www.picard.fr/produits/24-moules-farcies-000000000000018274.html'
const page = (name: string) => readPicardPage(readFixture(`picard/${name}.html.gz`))

describe('reading a page', () => {
  it('reads the name from the breadcrumb, the size from the analytics, the rest from the microdata', () => {
    expect(page('food')).toEqual({
      name: 'Haricots verts très fins sans résidu de pesticides',
      shelf: 'legumes-et-fruits/legumes/haricots',
      price: 2.99,
      available: true,
      gtin: '3270160879588',
      brand: 'Picard',
      format: 'le sachet de 1 kg',
    })
  })

  it('takes the first of two barcodes', () => {
    expect(page('two-gtins').gtin).toBe('3270160182749')
  })

  it('reads the id from the URL, and refuses the retired R-numbered pages', () => {
    expect(picardIdFrom(BEANS)).toBe('000000000000087958')
    expect(picardIdFrom('https://www.picard.fr/produits/osso-bucco-d-agneau-aux-cepes-R0350.html')).toBeNull()
  })
})

describe('which products are groceries', () => {
  it('keeps the food and drops the cool boxes', () => {
    expect(isPicardGrocery(page('food'))).toBe(true)
    expect(isPicardGrocery(page('cooler'))).toBe(false)
  })

  it('refuses a department it has never seen', () => {
    expect(isPicardGrocery({ ...page('food'), shelf: 'diy-et-deco/bougies' })).toBe(false)
  })
})

describe('building a listing', () => {
  it('files frozen food as frozen and wine as alcohol', () => {
    expect(buildPicardProduct(page('food'), BEANS)).toEqual({
      retailer: 'picard',
      externalId: '000000000000087958',
      name: 'Haricots verts très fins sans résidu de pesticides',
      brand: 'Picard',
      gtin: '3270160879588',
      price: 2.99,
      currency: 'EUR',
      quantity: 1,
      unit: 'kg',
      category: 'frozen',
      productUrl: BEANS,
      available: true,
    })
    expect(buildPicardProduct({ ...page('food'), shelf: 'epicerie/vins-champagnes/vins' }, BEANS)!.category).toBe('alcohol')
  })
})

describe('crawling', () => {
  it('fetches only product pages, imports the food and excludes the cool box', async () => {
    const excluded: string[] = []
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', body: 'User-agent: *\nDisallow: /on/demandware.store/\n' },
      {
        match: '/sitemap_0.xml',
        body: `<urlset>${[BEANS, COOLER, MUSSELS, 'https://www.picard.fr/recettes/tarte-R1.html']
          .map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`,
      },
      { match: 'haricots', file: 'picard/food.html.gz' },
      { match: 'glaciere', file: 'picard/cooler.html.gz' },
      { match: 'moules', file: 'picard/two-gtins.html.gz' },
    ])
    const products = await collect(
      SCRAPERS.find((s) => s.retailer === 'picard')!.discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        reportExcluded: async (id) => void excluded.push(id),
      }),
    )
    expect(products.map((p) => p.externalId)).toEqual(['000000000000087958', '000000000000018274'])
    expect(excluded).toEqual(['000000000000030635'])
    expect(callsOf(fetchImpl).some((u) => u.includes('/recettes/'))).toBe(false)
  })
})
