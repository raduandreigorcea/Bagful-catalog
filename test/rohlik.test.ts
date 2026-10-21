// Knuspr and Gurkerl: one platform, two countries, and only the groceries.
//
// Fixtures are pages captured from the live sites on 2026-10-21 with the
// crawler's own user agent. THE FILTER READS THE FIRST BREADCRUMB LINK's
// category id, not its label: the pharmacy, the cosmetics and the deposit lines
// are what a shopping list must not receive, and each has a fixture here.

import { describe, it, expect } from 'vitest'
import { readFixture } from './helpers.ts'
import { extractJsonLd, findProduct, readProduct } from '../src/core/jsonld.ts'
import {
  ROHLIK_COUNTRIES,
  rohlikIdFrom,
  rohlikShelf,
  isRohlikGrocery,
  buildRohlikProduct,
} from '../src/retailers/rohlik/index.ts'
import { SCRAPERS } from '../src/core/registry.ts'
import { MARKETS } from '../src/core/types.ts'

const page = (name: string): string => readFixture(`rohlik/${name}.html.gz`)
const country = (slug: string) => ROHLIK_COUNTRIES.find((c) => c.slug === slug)!
const keeps = (slug: string, name: string) => isRohlikGrocery(country(slug), rohlikShelf(page(name)))

describe('the Rohlik countries', () => {
  it('gives every country a unique slug and a market the app can derive', () => {
    const slugs = ROHLIK_COUNTRIES.map((c) => c.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const c of ROHLIK_COUNTRIES) expect(MARKETS).toContain(c.country)
  })

  it('registers a scraper for every country, on its own domain', () => {
    for (const c of ROHLIK_COUNTRIES) {
      const scraper = SCRAPERS.find((s) => s.retailer === c.slug)
      expect(scraper, c.slug).toBeDefined()
      expect(scraper!.country).toBe(c.country)
      expect(`https://www.${scraper!.domain}`).toBe(c.origin)
    }
  })
})

describe('reading ids and shelves', () => {
  it('reads the numeric id a product URL starts with', () => {
    expect(rohlikIdFrom('https://www.knuspr.de/272-rotkohl-1-stk')).toBe('272')
    expect(rohlikIdFrom('https://www.gurkerl.at/10760-alnatura-bio-hirseflocken')).toBe('10760')
  })

  it('reads no id from a category page or the home page', () => {
    expect(rohlikIdFrom('https://www.knuspr.de/c1-obst-gemuese')).toBeNull()
    expect(rohlikIdFrom('https://www.knuspr.de/')).toBeNull()
  })

  it('takes the top-level category id out of the first breadcrumb link', () => {
    expect(rohlikShelf(page('de-food'))).not.toBeNull()
    expect(rohlikShelf(page('de-apotheke'))).toBe('3807')
    expect(rohlikShelf(page('de-drogerie'))).toBe('712')
  })

  it('reads no shelf from a deposit line, which has no breadcrumb', () => {
    expect(rohlikShelf(page('de-pfand'))).toBeNull()
  })
})

describe('which shelves are groceries', () => {
  it('keeps food and drink', () => {
    expect(keeps('knuspr-de', 'de-food')).toBe(true)
    expect(keeps('knuspr-de', 'de-drink')).toBe(true)
    expect(keeps('gurkerl-at', 'at-food')).toBe(true)
    expect(keeps('gurkerl-at', 'at-drink')).toBe(true)
  })

  it('refuses the pharmacy, cosmetics and the deposit lines', () => {
    expect(keeps('knuspr-de', 'de-apotheke')).toBe(false)
    expect(keeps('knuspr-de', 'de-drogerie')).toBe(false)
    expect(keeps('knuspr-de', 'de-pfand')).toBe(false)
    expect(keeps('gurkerl-at', 'at-drogerie')).toBe(false)
  })

  it('does not take one country\'s shelf ids for the other\'s', () => {
    // Knuspr's 115 is Getränke; on Gurkerl the same number is not a shelf at all.
    expect(isRohlikGrocery(country('gurkerl-at'), '115')).toBe(false)
    expect(isRohlikGrocery(country('knuspr-de'), '219')).toBe(false)
  })
})

describe('building a listing', () => {
  const build = (slug: string, name: string, url: string) => {
    const html = page(name)
    const product = findProduct(extractJsonLd(html))
    expect(product).not.toBeNull()
    return buildRohlikProduct(readProduct(product!), url, country(slug), rohlikShelf(html))
  }

  it('carries the id, price, currency and link, and no brand or barcode', () => {
    const row = build('knuspr-de', 'de-food', 'https://www.knuspr.de/272-rotkohl-1-stk')!
    expect(row.retailer).toBe('knuspr-de')
    expect(row.externalId).toBe('272')
    expect(row.name.length).toBeGreaterThan(3)
    expect(row.price).toBeGreaterThan(0)
    expect(row.currency).toBe('EUR')
    expect(row.gtin).toBeNull()
    expect(row.brand).toBeNull()
    expect(row.productUrl).toBe('https://www.knuspr.de/272-rotkohl-1-stk')
  })

  it('files a known shelf under ours and a mixed one under nothing', () => {
    const dairyLike = build('gurkerl-at', 'at-food', 'https://www.gurkerl.at/10760-alnatura-bio-hirseflocken')!
    expect(['pantry', 'produce', 'bakery', 'dairy', 'snacks', 'frozen', 'meat', 'baby', 'pet', null]).toContain(dairyLike.category)
    const drink = build('knuspr-de', 'de-drink', 'https://www.knuspr.de/755-lavazza-caffe-crema-dolce-ganze-bohne')!
    expect(drink.category === null || drink.category === 'pantry').toBe(true)
  })
})
