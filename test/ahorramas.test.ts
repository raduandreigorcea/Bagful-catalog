// Ahorramas: a Madrid supermarket, groceries only.
//
// Fixtures are pages captured from the live site on 2026-10-21 with the
// crawler's own user agent. THE FILTER READS THE FIRST BREADCRUMB LINK, whose
// address the page writes as `id` rather than `@id`; a reader that only knows
// the spec's spelling sees no shelf at all and would refuse the whole shop.

import { describe, it, expect } from 'vitest'
import { readFixture } from './helpers.ts'
import { extractJsonLd, findProduct, readProduct } from '../src/core/jsonld.ts'
import { ahorramas, ahorramasIdFrom, ahorramasShelf, isAhorramasGrocery, buildAhorramasProduct } from '../src/retailers/ahorramas/index.ts'
import { SCRAPERS } from '../src/core/registry.ts'

const page = (name: string): string => readFixture(`ahorramas/${name}.html.gz`)

describe('Ahorramas', () => {
  it('is registered for Spain, on its own domain', () => {
    expect(SCRAPERS).toContain(ahorramas)
    expect(ahorramas.country).toBe('ES')
    expect(ahorramas.domain).toBe('ahorramas.com')
  })

  it('reads the number a product URL ends in, and nothing from other pages', () => {
    expect(ahorramasIdFrom('https://www.ahorramas.com/sardinas-albo-85g-en-aceite-de-oliva-9423.html')).toBe('9423')
    expect(ahorramasIdFrom('https://www.ahorramas.com/alimentacion/')).toBeNull()
    expect(ahorramasIdFrom('https://www.ahorramas.com/')).toBeNull()
  })

  it('reads the section from a breadcrumb that spells its address `id`', () => {
    expect(ahorramasShelf(page('alimentacion'))).toBe('alimentacion')
    expect(ahorramasShelf(page('frescos'))).toBe('frescos')
    expect(ahorramasShelf(page('hogar'))).toBe('hogar')
  })

  it('keeps food, fresh and cleaning, and refuses cosmetics and homeware', () => {
    expect(isAhorramasGrocery(ahorramasShelf(page('alimentacion')))).toBe(true)
    expect(isAhorramasGrocery(ahorramasShelf(page('frescos')))).toBe(true)
    expect(isAhorramasGrocery(ahorramasShelf(page('limpieza')))).toBe(true)
    expect(isAhorramasGrocery(ahorramasShelf(page('cuidado-personal')))).toBe(false)
    expect(isAhorramasGrocery(ahorramasShelf(page('hogar')))).toBe(false)
    expect(isAhorramasGrocery(null)).toBe(false)
  })

  it('builds a listing with the id, brand, price, size and shelf, and no barcode', () => {
    const html = page('alimentacion')
    const url = 'https://www.ahorramas.com/garbanzos-con-espinacas-litoral-425g-13.html'
    const row = buildAhorramasProduct(readProduct(findProduct(extractJsonLd(html))!), url, ahorramasShelf(html))!
    expect(row).toMatchObject({
      retailer: 'ahorramas',
      externalId: '13',
      brand: 'LITORAL',
      gtin: null,
      price: 2.15,
      currency: 'EUR',
      quantity: 425,
      unit: 'g',
      category: 'pantry',
      productUrl: url,
      available: true,
    })
  })

  it('files a mixed section under no category', () => {
    const html = page('frescos')
    const url = 'https://www.ahorramas.com/jamon-cocido-extra-campofrio-1712.html'
    const row = buildAhorramasProduct(readProduct(findProduct(extractJsonLd(html))!), url, ahorramasShelf(html))!
    expect(row.category).toBeNull()
  })
})
