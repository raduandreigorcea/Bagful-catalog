// Kaufland Romania: its weekly leaflet, the only product data the site has.
// Page captured 2026-09-29, holding the week of 23-29 September and the next.

import { describe, it, expect } from 'vitest'
import { readFixture, fixtureFetch, collect, testLogger } from './helpers.ts'
import { parseLeaflet, kauflandProducts, buildKauflandProduct } from '../src/retailers/kaufland/index.ts'
import { SCRAPERS } from '../src/core/registry.ts'

const html = readFixture('kaufland/leaflet.html.gz')

describe('kaufland: an offer', () => {
  it('reads the title as the brand when the description repeats it', () => {
    expect(buildKauflandProduct({
      klNr: '1', title: 'Cris-Tim', subtitle: 'Salam uscat', unit: '350 g',
      detailTitle: 'Salam uscat', detailDescription: 'Cris-Tim',
    }, 'meat')).toMatchObject({ brand: 'Cris-Tim', name: 'Salam uscat', quantity: 350, unit: 'g', price: null, available: true })
  })

  it('reads an unbranded offer by its own heading', () => {
    expect(buildKauflandProduct({
      klNr: '2', title: 'Ardei gras', subtitle: 'rotund\ncalitatea I', unit: 'kg',
      detailTitle: 'Ardei gras rotund', detailDescription: 'calitatea I',
    }, 'produce')).toMatchObject({ brand: null, name: 'Ardei gras rotund' })
  })

  it('skips an offer that is not one product', () => {
    const base = { klNr: '3', title: 'Dove', subtitle: 'Gel de duș\n720 ml', unit: '720 ml', detailTitle: 'Gel de duș' }
    expect(buildKauflandProduct({ ...base, detailDescription: 'Dove\ndiverse sortimente' }, null)).toBeNull()
    expect(buildKauflandProduct({ ...base, title: 'Snickers / Twix', detailDescription: 'Snickers / Twix' }, null)).toBeNull()
    expect(buildKauflandProduct({ ...base, detailTitle: 'Reducere cu Kaufland Card', detailDescription: 'Preț special la Dove' }, null)).toBeNull()
  })
})

describe('kaufland: the leaflet', () => {
  const products = kauflandProducts(parseLeaflet(html)!)

  it('finds both weeks, groceries only, each article once', () => {
    expect(products.length).toBeGreaterThan(200)
    expect(new Set(products.map((p) => p.externalId)).size).toBe(products.length)
    // Heineken, Bere blondă, in the drinks aisle.
    expect(products.find((p) => p.externalId === '20678495')).toMatchObject({ brand: 'Heineken', category: 'drinks' })
    // Parkside is tools, and cosmetics are left out whole.
    expect(products.some((p) => p.brand === 'Parkside')).toBe(false)
    expect(products.some((p) => p.brand === 'Nivea')).toBe(false)
  })

  it('never carries the leaflet price', () => {
    expect(products.every((p) => p.price === null)).toBe(true)
  })
})

describe('kaufland: the crawl', () => {
  const scraper = SCRAPERS.find((s) => s.retailer === 'kaufland')!

  it('reads one page and never sweeps', async () => {
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', body: 'User-agent: *\nDisallow: /etc.clientlibs/\n' },
      { match: 'saptamana-curenta', file: 'kaufland/leaflet.html.gz' },
    ])
    const products = await collect(scraper.discoverProducts({ log: testLogger(), fetchImpl, minIntervalMs: 0 }))
    expect(products.length).toBeGreaterThan(200)
    expect(scraper.sweeps).toBe(false)
  })

  it('fails loudly when the offers are gone, rather than yielding nothing', async () => {
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', body: 'User-agent: *\n' },
      { match: 'saptamana-curenta', body: '<html>redesigned</html>' },
    ])
    await expect(collect(scraper.discoverProducts({ log: testLogger(), fetchImpl, minIntervalMs: 0 }))).rejects.toThrow(/no offer data/)
  })
})
