// Ahorramas (Spain): a Madrid supermarket chain, read through its product
// sitemap and the schema.org blocks on each page.
//
// /sitemap_0-product.xml lists 4,514 products, every entry dated, and each page
// carries a Product block with a price, a brand and a stock state, plus a
// BreadcrumbList whose first link is the section (/alimentacion/, /frescos/).
// robots.txt allows it. Checked on 2026-10-21 with the crawler's own user agent,
// 14 of 14 pages sampled had all four fields.
//
// NO BARCODE: the block holds the shop's own sku and mpn (the number the URL
// ends in) and no GTIN anywhere on the page, so a listing merges with another
// shop's only when names and sizes fold alike. The size is in the name ("Sardinas
// Albo 85g en aceite de oliva"), which helps.
//
// ONLY THE GROCERIES, by the first breadcrumb link, an ALLOWLIST. The home page
// names eleven sections; /cuidado-personal/ (26% of a sample of 70) mixes
// cosmetics and perfume into hygiene, and /hogar/ is homeware, so both stay out
// whole, as Knuspr's drugstore does. /ofertas/ is a promotions page, not a shelf.

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { crawlProductPages } from '../../core/pageCrawl.ts'
import { isAvailable } from '../../core/jsonld.ts'
import { breadcrumbLinks } from '../../core/breadcrumb.ts'
import type { JsonLdProduct } from '../../core/jsonld.ts'
import { parseQuantity, httpsUrl, usableBrand } from '../../core/normalize.ts'

const ORIGIN = 'https://www.ahorramas.com'

// A null shelf spans several of ours: "Frescos" is meat, fish, fruit and bakery,
// "Bebidas" holds wine next to water. Imported, with no category.
export const SHELVES: Readonly<Record<string, Category | null>> = {
  alimentacion: 'pantry',
  frescos: null,
  congelados: 'frozen',
  bebidas: null,
  lacteos: 'dairy',
  limpieza: 'household',
  bebe: 'baby',
  mascotas: 'pet',
}

/** The number a product URL ends in (/name-9423.html), or null for any other page. */
export function ahorramasIdFrom(url: string): string | null {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return null
  }
  return /^\/[^/]+-(\d+)\.html$/.exec(path)?.[1] ?? null
}

/** The section slug of the product's first breadcrumb link, or null. */
export function ahorramasShelf(html: string): string | null {
  const first = breadcrumbLinks(html)[0]
  return first ? (/^https?:\/\/[^/]+\/([a-z-]+)\/?$/.exec(first)?.[1] ?? null) : null
}

export function isAhorramasGrocery(shelf: string | null): boolean {
  return shelf !== null && Object.prototype.hasOwnProperty.call(SHELVES, shelf)
}

export function buildAhorramasProduct(
  product: JsonLdProduct,
  url: string,
  shelf: string | null,
): RetailerProduct | null {
  const name = product.name?.trim()
  if (!name) return null
  const externalId = ahorramasIdFrom(url)
  if (!externalId) return null

  const parsed = parseQuantity(name)
  const price = product.price !== null && product.price > 0 ? product.price : null

  return {
    retailer: 'ahorramas',
    externalId,
    name,
    brand: usableBrand(product.brand),
    // Stated rather than left to default: the page has no barcode.
    gtin: null,
    price,
    currency: price === null ? null : (product.currency ?? 'EUR'),
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: shelf !== null ? (SHELVES[shelf] ?? null) : null,
    productUrl: httpsUrl(url) ?? url,
    available: isAvailable(product.availability),
  }
}

class AhorramasScraper implements RetailerScraper {
  readonly retailer = 'ahorramas'
  readonly country: Market = 'ES'
  readonly domain = 'ahorramas.com'
  readonly implemented = true

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    const http = new HttpClient({
      minIntervalMs: ctx.minIntervalMs ?? 1000,
      timeoutMs: 45_000,
      retries: 2,
      fetchImpl: ctx.fetchImpl,
    })

    const robots = await fetchRobots((url) => http.get(url), ORIGIN)
    if (!isAllowed(robots, `${ORIGIN}/example-1.html`)) {
      throw new Error('ahorramas robots.txt disallows product pages; refusing to crawl')
    }

    yield* crawlProductPages({
      retailer: this.retailer,
      http,
      ctx,
      sitemapUrls: [`${ORIGIN}/sitemap_0-product.xml`],
      // Every entry is dated, so a run with --since fetches what moved.
      supportsIncremental: true,
      urlFilter: (url) => ahorramasIdFrom(url) !== null,
      keep: (html) => isAhorramasGrocery(ahorramasShelf(html)),
      idOf: (url) => ahorramasIdFrom(url),
      build: (product, url, html) => buildAhorramasProduct(product, url, ahorramasShelf(html)),
    })
  }
}

export const ahorramas: RetailerScraper = new AhorramasScraper()
