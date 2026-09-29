// Penny Romania: the product pages in its sitemap, every one of them a current
// OFFER. Checked 2026-09-29 with the crawler's own user agent.
//
// penny.ro publishes no assortment, only its promotions: ~580 product pages in
// the sitemap, all filed under "Oferte speciale" (this week's leaflet, next
// week's, and the PENNY card deals), each with a schema.org Product block.
//
// SO IT IS READ LIKE KAUFLAND'S LEAFLET (see src/retailers/kaufland): a run never
// sweeps, because a product leaving the promotion is still on the shelf, and no
// price is imported, because the promotion price ends with the week. Every offer
// ever seen stays a Penny listing. The same ceiling: a product Penny stops
// selling keeps its badge.
//
// The Product block is an HTML attribute, not script text (core/jsonld.ts reads
// both). Its `weight` is the GROSS weight of the package -- a 2 x 2 l Coca-Cola
// weighs 4.15 kg -- so the size comes from the name only.
//
// Names arrive in capitals and carry the bottle deposit ("+ GARANTIE SGR
// 0.5LEI"), which is dropped. Skipped: an offer for "diverse sortimente", one
// naming several variants with a slash ("VIN ALB/ROSU/ROSE"), and a produce
// offer that only points at the leaflet ("GOGONELE DIN PLIANTUL ACTUAL").
//
// ONLY THE GROCERIES, by the shop's own category path on the page (the one that
// is not "Oferte speciale"). Its personal care tree holds no makeup or perfume,
// so it is imported whole; food supplements are not groceries and are dropped.

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { crawlProductPages } from '../../core/pageCrawl.ts'
import { extractJsonLd, findProduct } from '../../core/jsonld.ts'
import type { JsonLdProduct } from '../../core/jsonld.ts'
import { parseQuantity, fold, usableBrand } from '../../core/normalize.ts'

const ORIGIN = 'https://www.penny.ro'
const SITEMAP = `${ORIGIN}/sitemap.xml`
const PRODUCT_URL = /\/products\/[^/]+-rr(\d+)\/?$/

// Folded "root > aisle" prefixes, tried in order; null refuses the page.
const SHELVES: Array<[RegExp, Category | null]> = [
  [/^fructe si legume/, 'produce'],
  [/^carne, mezeluri si peste > peste/, 'fish'],
  [/^carne, mezeluri si peste/, 'meat'],
  [/^lactate/, 'dairy'],
  [/^paine si patiserie/, 'bakery'],
  [/^produse congelate/, 'frozen'],
  [/^alimente de baza > suplimente/, null],
  [/^alimente de baza > (cafea|ceai)/, 'drinks'],
  [/^alimente de baza/, 'pantry'],
  [/^conserve si borcane/, 'pantry'],
  [/^dulciuri si snacks/, 'snacks'],
  [/^bauturi > (bere|vin|spirtoase)/, 'alcohol'],
  [/^bauturi/, 'drinks'],
  [/^produse curatenie/, 'household'],
  [/^ingrijire personala/, 'personal-care'],
]

export function pennyIdFrom(url: string): string | null {
  const digits = PRODUCT_URL.exec(new URL(url).pathname)?.[1]
  return digits ? `RR-${digits}` : null
}

/** The shop's own category path, the one that is not a promotion; null if none. */
export function pennyPath(html: string): string | null {
  const categories = findProduct(extractJsonLd(html))?.['category']
  const paths = Array.isArray(categories) ? categories : [categories]
  const path = paths.find((p): p is string => typeof p === 'string' && !/^oferte/i.test(p.trim()))
  return path ? fold(path) : null
}

function shelf(path: string | null): [RegExp, Category | null] | undefined {
  return path === null ? undefined : SHELVES.find(([re]) => re.test(path))
}

export function pennyIsGrocery(path: string | null): boolean {
  const found = shelf(path)
  return found !== undefined && found[1] !== null
}

/** "HANUL BOIERESC CEAFA" -> "Hanul boieresc ceafa"; mixed case is left alone. */
function unshout(text: string): string {
  if (text !== text.toUpperCase()) return text
  const lower = text.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/** A brand in capitals, word by word: "HANUL BOIERESC" -> "Hanul Boieresc". */
function unshoutBrand(brand: string | null): string | null {
  if (brand === null || brand !== brand.toUpperCase()) return brand
  return brand.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase())
}

export function buildPennyProduct(product: JsonLdProduct, url: string, path: string | null): RetailerProduct | null {
  const externalId = pennyIdFrom(url)
  const raw = product.name?.replace(/\s*\+?\s*garantie sgr.*$/i, '').replace(/\s+/g, ' ').trim()
  if (!externalId || !raw) return null
  if (raw.includes('/') || /diverse sortimente|din pliant/i.test(raw)) return null

  const parsed = parseQuantity(raw)
  return {
    retailer: 'penny',
    externalId,
    name: unshout(raw),
    brand: unshoutBrand(usableBrand(product.brand)),
    gtin: null,
    price: null,
    currency: null,
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: shelf(path)?.[1] ?? null,
    productUrl: url,
    available: true,
  }
}

export class PennyScraper implements RetailerScraper {
  readonly retailer = 'penny'
  readonly country: Market = 'RO'
  readonly domain = 'penny.ro'
  readonly implemented = true
  readonly sweeps = false

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    const http = new HttpClient({ minIntervalMs: ctx.minIntervalMs ?? 1000, timeoutMs: 45_000, retries: 2, fetchImpl: ctx.fetchImpl })

    const robots = await fetchRobots((url) => http.get(url), ORIGIN)
    if (!isAllowed(robots, `${ORIGIN}/products/example-rr1`)) {
      throw new Error('penny robots.txt disallows product pages; refusing to crawl')
    }

    yield* crawlProductPages({
      retailer: this.retailer,
      http,
      ctx,
      sitemapUrls: [SITEMAP],
      supportsIncremental: false,
      urlFilter: (url) => PRODUCT_URL.test(new URL(url).pathname),
      keep: (html) => pennyIsGrocery(pennyPath(html)),
      idOf: (url) => pennyIdFrom(url),
      build: (product, url, html) => buildPennyProduct(product, url, pennyPath(html)),
    })
  }
}

export const penny = new PennyScraper()
