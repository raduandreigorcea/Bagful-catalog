// Picard, the French frozen-food chain: read through its sitemap and the
// schema.org MICRODATA on each product page. Checked with the crawler's own
// user agent on 2026-10-05.
//
// 1,585 product pages (/produits/<slug>-<id>.html) beside recipes, articles and
// themed aisles in the same sitemap. There is no Product ld+json block; the
// product is marked up in attributes instead (`itemprop="price"`, `gtin13`,
// `availability`), which carries the same Google contract. The name comes from
// the breadcrumb's last item, which is plain UTF-8 where the page heading uses
// named entities (`&eacute;`), and the size from the page's analytics
// attribute (`item_format`: "le sachet de 250 g").
//
// A BARCODE ON NEARLY EVERY PRODUCT, so Picard merges with other French shops
// by GTIN. A few pages list two (`gtin13="3270160182749 3274810022416"`); the
// first valid one is taken.
//
// ONLY THE GROCERIES, by the department the breadcrumb names
// (/rayons/<department>/...). Everything Picard sells is food but for one
// aisle: insulated bags and cool boxes under the grocery department
// (epicerie/accessoires). A page with no breadcrumb is a retired product
// (no price, no barcode) and counts as a page with no product.

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { crawlProductPages } from '../../core/pageCrawl.ts'
import { isAvailable } from '../../core/jsonld.ts'
import { parseQuantity, validGtin, httpsUrl } from '../../core/normalize.ts'

const ORIGIN = 'https://www.picard.fr'
const SITEMAP = `${ORIGIN}/sitemap_0.xml`
const PRODUCT_URL = /^\/produits\/[^/]+-(\d+)\.html$/

// The departments a product's breadcrumb names, sampled on 2026-10-05. The
// themed aisles in the sitemap (halloween, promotions, nouveautes) are never
// the one a breadcrumb names. A null shelf is food we have no shelf for.
const DEPARTMENTS: Record<string, Category | null> = {
  'legumes-et-fruits': 'frozen',
  'viandes-et-poissons': 'frozen',
  'aperitifs-et-entrees': 'frozen',
  'plats-cuisines': 'frozen',
  'pizzas-et-tartes': 'frozen',
  'cuisine-du-monde': 'frozen',
  'le-snack': 'frozen',
  traiteur: 'frozen',
  desserts: 'frozen',
  'glaces-et-sorbets': 'frozen',
  'pains-et-viennoiseries': 'frozen',
  epicerie: 'pantry',
}

const NOT_GROCERIES = /^epicerie\/accessoires(\/|$)/

export function picardIdFrom(url: string): string | null {
  return PRODUCT_URL.exec(new URL(url).pathname)?.[1] ?? null
}

/** What a product page says. */
export interface PicardPage {
  name: string | null
  /** The breadcrumb's department path below /rayons/, e.g. "epicerie/vins-champagnes/vins". */
  shelf: string | null
  price: number | null
  available: boolean
  gtin: string | null
  brand: string | null
  format: string | null
}

const attribute = (html: string, prop: string): string | null =>
  new RegExp(`itemprop="${prop}" content="([^"]*)"`).exec(html)?.[1] ?? null

export function readPicardPage(html: string): PicardPage {
  const crumbs = [...html.matchAll(/"item":"https:\/\/www\.picard\.fr\/([^"]+)","name":"([^"]*)"/g)]
  const shelves = crumbs.map((c) => /^rayons\/(.+)$/.exec(c[1])?.[1]).filter((s): s is string => s !== undefined)
  const last = crumbs.at(-1)
  const name = last && last[1].startsWith('produits/') ? last[2].trim() : null

  // data-gtm="{&quot;item_format&quot;:&quot;le sachet de 250&amp;#160;g&quot;...}"
  const gtm = /data-gtm="([^"]*item_format[^"]*)"/.exec(html)?.[1]
  const format = gtm
    ? /"item_format":"([^"]*)"/.exec(gtm.replace(/&quot;/g, '"').replace(/&amp;/g, '&'))?.[1]
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/ /g, ' ') ?? null
    : null

  const price = Number(attribute(html, 'price'))
  return {
    name,
    shelf: shelves.at(-1) ?? null,
    price: price > 0 ? price : null,
    available: isAvailable(attribute(html, 'availability')),
    gtin: (attribute(html, 'gtin13') ?? '').split(/\s+/).map((g) => validGtin(g)).find((g) => g !== null) ?? null,
    brand: attribute(html, 'brand'),
    format,
  }
}

export function isPicardGrocery(page: PicardPage): boolean {
  if (!page.shelf) return true // retired page: let it through to count as no product
  const department = page.shelf.split('/')[0]
  return Object.prototype.hasOwnProperty.call(DEPARTMENTS, department) && !NOT_GROCERIES.test(page.shelf)
}

function shelfOf(path: string): Category | null {
  if (/^epicerie\/vins-champagnes/.test(path)) return 'alcohol'
  if (/boissons/.test(path)) return 'drinks'
  return DEPARTMENTS[path.split('/')[0]] ?? null
}

export function buildPicardProduct(page: PicardPage, url: string): RetailerProduct | null {
  const externalId = picardIdFrom(url)
  if (!page.name || !page.shelf || !externalId) return null
  const parsed = parseQuantity(page.format) ?? parseQuantity(page.name)
  return {
    retailer: 'picard',
    externalId,
    name: page.name,
    brand: page.brand,
    gtin: page.gtin,
    price: page.price,
    currency: page.price === null ? null : 'EUR',
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: shelfOf(page.shelf),
    productUrl: httpsUrl(url) ?? url,
    available: page.available,
  }
}

export class PicardScraper implements RetailerScraper {
  readonly retailer = 'picard'
  readonly country: Market = 'FR'
  readonly domain = 'picard.fr'
  readonly implemented = true

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    const http = new HttpClient({
      minIntervalMs: ctx.minIntervalMs ?? 1000,
      timeoutMs: 45_000,
      retries: 2,
      fetchImpl: ctx.fetchImpl,
    })

    const robots = await fetchRobots((url) => http.get(url), ORIGIN)
    if (!isAllowed(robots, `${ORIGIN}/produits/exemple-000000000000000001.html`)) {
      throw new Error('picard robots.txt disallows product pages; refusing to crawl')
    }

    yield* crawlProductPages({
      retailer: this.retailer,
      http,
      ctx,
      sitemapUrls: [SITEMAP],
      supportsIncremental: false,
      urlFilter: (url) => PRODUCT_URL.test(new URL(url).pathname),
      keep: (html) => isPicardGrocery(readPicardPage(html)),
      idOf: (url) => picardIdFrom(url),
      buildPage: (html, url) => buildPicardProduct(readPicardPage(html), url),
    })
  }
}

export const picard = new PicardScraper()
