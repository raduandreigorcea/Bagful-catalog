// Condis: read from the product record in each page's Next.js flight data, and
// only the groceries, by the department path its category tree gives the
// product's aisle. Pages captured from the live site on 2026-10-05: basmati
// rice, a nicotine vape filed in a household aisle, and hair clips in the nail
// care aisle.

import { describe, it, expect } from 'vitest'
import { readFixture, fixtureFetch, callsOf, collect, testLogger } from './helpers.ts'
import { readCondisPage, isCondisGrocery, buildCondisProduct, condisIdFrom } from '../src/retailers/condis/index.ts'
import { SCRAPERS } from '../src/core/registry.ts'

const RICE = 'https://compraonline.condis.es/arroz-tilda-basmati-1-kg/p/104040/es_ES'
const page = (name: string) => readCondisPage(readFixture(`condis/${name}.html.gz`))!

describe('reading a page', () => {
  it('reads the product record, its price from cents and its aisle with the whole path', () => {
    expect(page('rice')).toMatchObject({
      id: '104040',
      name: 'ARROZ TILDA BASMATI 1 KG',
      brand: 'Tilda',
      price: 3.45,
      netAmount: '1.0 kilogramos',
      aisle: 'Arroces',
    })
    expect(page('rice').path).toMatch(/^c01__cat\d+__cat001900010004$/)
  })

  it('reads nothing from a page without the record', () => {
    expect(readCondisPage('<html><script>self.__next_f.push([1,"nothing"])</script></html>')).toBeNull()
  })

  it('reads the Spanish pages only', () => {
    expect(condisIdFrom(RICE)).toBe('104040')
    expect(condisIdFrom(RICE.replace('es_ES', 'ca_ES'))).toBeNull()
  })
})

describe('which products are groceries', () => {
  it('keeps the food', () => {
    expect(isCondisGrocery(page('rice'))).toBe(true)
  })

  it('drops nail care by its aisle and nicotine by its name', () => {
    expect(isCondisGrocery(page('nail-care'))).toBe(false)
    expect(page('vape').aisle).toBe('Resto de artículos')
    expect(isCondisGrocery(page('vape'))).toBe(false)
  })

  it('drops perfume, cosmetics and the pharmacy by their section, and refuses an unknown department', () => {
    const at = (path: string) => isCondisGrocery({ ...page('rice'), path, aisle: 'x' })
    expect(at('c08__cat00160001__cat1')).toBe(false)
    expect(at('c08__cat00160003__cat1')).toBe(false)
    expect(at('c08__cat00010012__cat1')).toBe(false)
    expect(at('c08__cat00160007__cat1')).toBe(true)
    expect(at('c12__cat1__cat2')).toBe(false)
  })
})

describe('building a listing', () => {
  it('puts the capitals in sentence case and reads the size from the net amount', () => {
    expect(buildCondisProduct(page('rice'), RICE)).toEqual({
      retailer: 'condis',
      externalId: '104040',
      name: 'Arroz tilda basmati 1 kg',
      brand: 'Tilda',
      gtin: null,
      price: 3.45,
      currency: 'EUR',
      quantity: 1,
      unit: 'kg',
      category: 'pantry',
      productUrl: RICE,
      available: true,
    })
  })
})

describe('crawling', () => {
  it('reads the Spanish product pages, imports the food and excludes the rest', async () => {
    const excluded: string[] = []
    const vape = 'https://compraonline.condis.es/vaper/p/999001/es_ES'
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', body: 'User-agent: *\nDisallow: /checkout\n' },
      {
        match: '/sitemap.xml',
        body: `<urlset>${[RICE, RICE.replace('es_ES', 'ca_ES'), vape, 'https://compraonline.condis.es/bebidas_cervezas/c/c07__cat00270001/es_ES']
          .map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`,
      },
      { match: '/p/104040/es_ES', file: 'condis/rice.html.gz' },
      { match: '/p/999001/es_ES', file: 'condis/vape.html.gz' },
    ])
    const products = await collect(
      SCRAPERS.find((s) => s.retailer === 'condis')!.discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        reportExcluded: async (id) => void excluded.push(id),
      }),
    )
    expect(products.map((p) => p.externalId)).toEqual(['104040'])
    expect(excluded).toEqual(['999001'])
    const calls = callsOf(fetchImpl)
    expect(calls.some((u) => u.includes('ca_ES') || u.includes('/c/'))).toBe(false)
  })
})
