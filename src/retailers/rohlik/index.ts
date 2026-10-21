// Rohlik's platform: Knuspr (Germany) and Gurkerl (Austria). ONE SCRAPER, TWO
// COUNTRIES, and room for Rohlik (Czechia) and Kifli (Hungary), which run the
// same site but need a market the app cannot derive yet.
//
// Online supermarkets with their own warehouse. /sitemap_products.xml lists
// every product (15,576 on Knuspr, 16,622 on Gurkerl, checked 2026-10-21 with
// the crawler's own user agent), a product URL is /<numeric id>-<slug>, and
// the page carries a schema.org Product with a price and a stock state plus a
// BreadcrumbList. robots.txt allows everything but /regal/*.
//
// NO BARCODE AND NO BRAND on the Product block, in all four countries (90 pages
// sampled in each). The brand is inside the name ("Avocado Hass, essreif, 1
// Stk."), so a listing merges with another shop's only when names and sizes fold
// alike, the same accepted cost as Aldi and Carrefour.
//
// ONLY THE GROCERIES, decided by the first breadcrumb link, /c<id>-<slug>. The
// ID is the shop's own key for the top-level shelf; the slug beside it is
// translated copy. An ALLOWLIST, as Aldi's is: about a fifth of what these
// shops list is a pharmacy (Apotheke), and the rest includes cosmetics, office
// supplies and a Marks & Spencer range, none of which belongs on a shopping
// list. Drogerie and Haushalt are left out whole rather than carved, because
// cosmetics are mixed into them. A deposit line ("Pfand 0,25") has no
// breadcrumb at all and is refused for that reason, which is also why a product
// with no shelf is refused here and not imported uncategorised.
//
// A page is ~500 KB and a first run reads every product page, so the workflow
// takes half of each shop a night and these two never sweep, like Delhaize.

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { crawlProductPages } from '../../core/pageCrawl.ts'
import { isAvailable } from '../../core/jsonld.ts'
import { breadcrumbLinks } from '../../core/breadcrumb.ts'
import type { JsonLdProduct } from '../../core/jsonld.ts'
import { parseQuantity, httpsUrl } from '../../core/normalize.ts'

export interface RohlikCountry {
  /** The catalog_retailers slug. */
  readonly slug: string
  readonly country: Market
  readonly origin: string
  readonly currency: string
  /**
   * Top-level category id to the catalog's shelf. Only these are imported. A
   * null shelf is a food aisle that spans several of ours ("Kühlregal",
   * "Getränke" holds beer and water): imported, with no category.
   */
  readonly shelves: Readonly<Record<string, Category | null>>
}

const GERMANY: Record<string, Category | null> = {
  '1': 'produce', // Obst & Gemüse
  '29': 'pantry', // Kochen & Backen
  '115': null, // Getränke
  '480': 'bakery', // Brot & Gebäck
  '510': 'frozen', // Tiefkühlprodukte
  '532': null, // Kühlregal
  '533': 'dairy', // Milch, Molkerei & Butter
  '652': null, // Fleisch & Fisch
  '663': 'meat', // Wurst & Schinken
  '700': 'pet', // Tierbedarf
  '833': 'baby', // Baby & Kinder
  '1080': 'pantry', // Vorratsschrank
  '2416': null, // Plant Based
  '3212': null, // Bewusste Ernährung
  '4668': 'snacks', // Süßes & Salziges
  '5485': null, // Ready to Eat
}

const AUSTRIA: Record<string, Category | null> = {
  '26': 'produce', // Obst & Gemüse
  '219': null, // Getränke
  '256': 'pet', // Tierbedarf
  '269': null, // Fleisch & Fisch
  '270': 'meat', // Wurst & Schinken
  '304': 'pantry', // Vorratsschrank
  '320': 'baby', // Baby & Kinder
  '482': 'bakery', // Brot & Gebäck
  '507': null, // Kühlregal
  '583': 'frozen', // Tiefkühlprodukte
  '135290': null, // Plant Based
  '135629': null, // Gesunder Lebensstil & Spezialernährung
  '137195': 'snacks', // Süßes & Salziges
  '137898': null, // Ready to Eat
}

export const ROHLIK_COUNTRIES: readonly RohlikCountry[] = [
  { slug: 'knuspr-de', country: 'DE', origin: 'https://www.knuspr.de', currency: 'EUR', shelves: GERMANY },
  { slug: 'gurkerl-at', country: 'AT', origin: 'https://www.gurkerl.at', currency: 'EUR', shelves: AUSTRIA },
]

/** The numeric id a product URL starts with, or null for any other page. */
export function rohlikIdFrom(url: string): string | null {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return null
  }
  return /^\/(\d+)-[^/]+\/?$/.exec(path)?.[1] ?? null
}

/** The id of the product's top-level category, read from its breadcrumb, or null. */
export function rohlikShelf(html: string): string | null {
  const first = breadcrumbLinks(html)[0]
  return first ? (/\/c(\d+)-/.exec(first)?.[1] ?? null) : null
}

export function isRohlikGrocery(country: RohlikCountry, shelf: string | null): boolean {
  return shelf !== null && Object.prototype.hasOwnProperty.call(country.shelves, shelf)
}

export function buildRohlikProduct(
  product: JsonLdProduct,
  url: string,
  country: RohlikCountry,
  shelf: string | null,
): RetailerProduct | null {
  const name = product.name?.trim()
  if (!name) return null
  const externalId = rohlikIdFrom(url)
  if (!externalId) return null

  const parsed = parseQuantity(name)
  const price = product.price !== null && product.price > 0 ? product.price : null

  return {
    retailer: country.slug,
    externalId,
    name,
    // Stated rather than left to default: neither field is on any page.
    brand: null,
    gtin: null,
    price,
    currency: price === null ? null : (product.currency ?? country.currency),
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: shelf !== null ? (country.shelves[shelf] ?? null) : null,
    productUrl: httpsUrl(url) ?? url,
    available: isAvailable(product.availability),
  }
}

export class RohlikScraper implements RetailerScraper {
  readonly retailer: string
  readonly country: Market
  readonly domain: string
  readonly implemented = true
  private readonly config: RohlikCountry

  // Written out rather than as parameter properties: erasableSyntaxOnly, see the
  // note on UnimplementedScraper in core/registry.ts.
  constructor(config: RohlikCountry) {
    this.config = config
    this.retailer = config.slug
    this.country = config.country
    this.domain = config.origin.replace(/^https:\/\/www\./, '')
  }

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    const config = this.config
    const http = new HttpClient({
      minIntervalMs: ctx.minIntervalMs ?? 1000,
      timeoutMs: 45_000,
      retries: 2,
      fetchImpl: ctx.fetchImpl,
    })

    const robots = await fetchRobots((url) => http.get(url), config.origin)
    if (!isAllowed(robots, `${config.origin}/1-example`)) {
      throw new Error(`${config.slug} robots.txt disallows product pages; refusing to crawl`)
    }

    yield* crawlProductPages({
      retailer: this.retailer,
      http,
      ctx,
      sitemapUrls: [`${config.origin}/sitemap_products.xml`],
      // Every entry is dated, so a run with --since fetches what moved.
      supportsIncremental: true,
      urlFilter: (url) => rohlikIdFrom(url) !== null,
      keep: (html) => isRohlikGrocery(config, rohlikShelf(html)),
      idOf: (url) => rohlikIdFrom(url),
      build: (product, url, html) => buildRohlikProduct(product, url, config, rohlikShelf(html)),
    })
  }
}

export const ROHLIK_SCRAPERS: readonly RohlikScraper[] = ROHLIK_COUNTRIES.map((c) => new RohlikScraper(c))
