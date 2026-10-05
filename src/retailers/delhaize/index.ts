// Delhaize Belgium: the product URLs come from its department pages, and the
// data from the schema.org Product block on each product page. Checked with this
// crawler's own user agent on 2026-09-14, and again on 2026-10-05.
//
// NO SITEMAP since 2026-10-03. Both /sitemapnl/ and /sitemap/ answer 404 while
// robots.txt still names them, and every run since read zero URLs and failed. So
// the crawl pages through each department the homepage tiles link to
// (/c/v2DRI?pageNumber=N, 20 products a page, an empty page after the last), and
// collects the product links. A department lists everything under it, so the
// subcategories need no walk of their own. ~14,000 products, ~700 listing pages,
// and the shop takes 4-5 s to answer each one, so the walk alone is an hour.
// A nightly SLICE (--shard) therefore walks only its own share of the
// departments and reads every product in them, rather than walking all of them
// to read a third: the same products over three nights, a third of the walking.
// The listing pages are plain HTML with no product data in them, which is why the
// product pages are still fetched: their Product block is the stable contract.
// Undated, so every run fetches its whole slice.
// The price sits one level down, in the offer's priceSpecification -- the reader
// already handles that shape for Mega Image, which runs on the same platform. A
// second ld+json block on every page, for the MyDelhaize app, carries a price of
// 0.00; it is not a Product and is never read as one.
//
// ONE LANGUAGE. Every product is published in Dutch and in French under the same
// id. The department pages are read in Dutch (where /c/ redirects to) and only
// /nl/ product links are kept, so a listing is never renamed twice a night.
//
// NO BARCODE. Like Mega Image, a Delhaize listing merges with another shop's only
// when the names and sizes fold identically.
//
// ONLY THE GROCERIES, by the department in the URL, and like Mega Image it is a
// DENYLIST: Delhaize is a supermarket, and of its twenty-odd departments only the
// kitchen-home-and-leisure aisle and the festive party accessories are not
// groceries -- decorations, plants, electrics, seasonal goods. Kitchen utensils,
// paper goods and fire lighters in that same aisle stay.

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { crawlProductPages } from '../../core/pageCrawl.ts'
import { isAvailable } from '../../core/jsonld.ts'
import type { JsonLdProduct } from '../../core/jsonld.ts'
import { parseQuantity, httpsUrl, usableBrand } from '../../core/normalize.ts'

const ORIGIN = 'https://www.delhaize.be'
const PRODUCT_URL = /^\/nl\/shop\/(.+)\/p\/([A-Z0-9]+)\/?$/

// Read from the Dutch sitemap on 2026-09-14; the departments re-read 2026-10-05.
const NOT_GROCERIES: RegExp[] = [
  /^Keuken-wonen-en-vrije-tijd\/(Huisdecoratie|Insecten-en-planten|Elektriciteit|Seizoensgebonden|Divers)\//i,
  /^Eindejaarsproducten\/Feest-accessoires\//i,
  // Makeup, carved out of personal care on 2026-09-27.
  /^Hygiene-en-verzorging\/Make-up\//i,
]

const DEPARTMENTS: Record<string, Category | null> = {
  'Verse-groenten-en-fruit': 'produce',
  'Vlees-vis-en-vegetarische-producten': null,
  'Zuivel-kaas-en-plantaardige-alternatieven': 'dairy',
  'Bakkerij-en-banket': 'bakery',
  'Zoete-kruidenierswaren': null,
  'Zoute-kruidenierswaren': 'pantry',
  Conserven: 'pantry',
  'Snel-en-smakelijk': null,
  'Bewuste-voeding': null,
  'Bio-Eco-en-Fairtrade': null,
  Diepvries: 'frozen',
  'Apero-en-voorgerechten': 'snacks',
  'Koude-en-warme-dranken': 'drinks',
  'Wijn-and-bubbels': 'alcohol',
  'Bieren-Alcohol-and-Alcoholvrij': 'alcohol',
  'Onderhoud-en-huishouden': 'household',
  'Keuken-wonen-en-vrije-tijd': 'household',
  'Hygiene-en-verzorging': 'personal-care',
  'Sport-and-Gezondheid': 'health',
  Baby: 'baby',
  Huisdieren: 'pet',
}

function pathOf(url: string): string {
  return new URL(url).pathname
}

export function delhaizeIdFrom(url: string): string | null {
  return PRODUCT_URL.exec(pathOf(url))?.[2] ?? null
}

export function delhaizeIsGrocery(url: string): boolean {
  const match = PRODUCT_URL.exec(pathOf(url))
  if (!match) return false
  return !NOT_GROCERIES.some((pattern) => pattern.test(`${match[1]}/`))
}

/** The department codes the homepage tiles link to (`href="/c/v2DRI"`). */
export function delhaizeDepartments(html: string): string[] {
  return [...new Set([...html.matchAll(/href="\/c\/(v2[A-Za-z]+)"/g)].map((m) => m[1]))]
}

/** The Dutch product URLs on one department page. */
export function delhaizeProductLinks(html: string): string[] {
  return [...new Set(
    [...html.matchAll(/href="(\/nl\/shop\/[^"?#]+\/p\/[A-Z0-9]+)"/g)].map((m) => `${ORIGIN}${m[1]}`),
  )]
}

// A department's pages run out into an empty one; this is only a guard against a
// page that never empties (drinks, 1,247 products, is ~63 pages).
const MAX_PAGES = 400

async function listDelhaizeProducts(http: HttpClient, ctx: ScrapeContext): Promise<string[]> {
  const home = await http.get(`${ORIGIN}/nl`)
  if (!home.ok) throw new Error(`delhaize homepage answered ${home.status}`)
  const departments = delhaizeDepartments(home.body)
  if (departments.length === 0) throw new Error('delhaize homepage links no departments; the tiles moved')

  const urls = new Set<string>()
  const mine = ctx.shard ? departments.filter((_, i) => i % ctx.shard!.of === ctx.shard!.index) : departments
  for (const department of mine) {
    for (let page = 0; page < MAX_PAGES; page++) {
      if (ctx.signal?.aborted) return [...urls]
      const response = await http.get(`${ORIGIN}/c/${department}?pageNumber=${page}`)
      if (!response.ok) {
        ctx.log.error('delhaize department page failed', { department, page, status: response.status })
        break
      }
      const links = delhaizeProductLinks(response.body)
      if (links.length === 0) break
      for (const link of links) urls.add(link)
    }
    ctx.log.info('delhaize: department read', { department, products: urls.size })
  }
  return [...urls]
}

export function buildDelhaizeProduct(product: JsonLdProduct, url: string): RetailerProduct | null {
  const name = product.name?.trim()
  if (!name) return null
  const match = PRODUCT_URL.exec(pathOf(url))
  if (!match) return null

  const parsed = parseQuantity(name)
  const price = product.price !== null && product.price > 0 ? product.price : null
  const department = match[1].split('/')[0]

  return {
    retailer: 'delhaize',
    externalId: match[2],
    name,
    brand: usableBrand(product.brand),
    gtin: null,
    price,
    currency: price === null ? null : (product.currency ?? 'EUR'),
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: DEPARTMENTS[department] ?? null,
    productUrl: httpsUrl(url) ?? url,
    available: isAvailable(product.availability),
  }
}

export class DelhaizeScraper implements RetailerScraper {
  readonly retailer = 'delhaize'
  readonly country: Market = 'BE'
  readonly domain = 'delhaize.be'
  readonly implemented = true

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    const http = new HttpClient({
      minIntervalMs: ctx.minIntervalMs ?? 1000,
      timeoutMs: 45_000,
      retries: 2,
      fetchImpl: ctx.fetchImpl,
    })

    const robots = await fetchRobots((url) => http.get(url), ORIGIN)
    if (!isAllowed(robots, `${ORIGIN}/nl/shop/Verse-groenten-en-fruit/Voorbeeld/p/F1`)) {
      throw new Error('delhaize robots.txt disallows product pages; refusing to crawl')
    }

    yield* crawlProductPages({
      retailer: this.retailer,
      http,
      // The slice was taken by department in listDelhaizeProducts; slicing the
      // URLs again would read a third of a third. The run still closes as a
      // deliberate partial: the CLI decides that from --shard, not from here.
      ctx: { ...ctx, shard: undefined },
      sitemapUrls: [],
      listUrls: () => listDelhaizeProducts(http, ctx),
      supportsIncremental: false,
      urlFilter: (url) => PRODUCT_URL.test(pathOf(url)),
      // The URL names the department, so a non-grocery page is never fetched.
      skip: (url) => !delhaizeIsGrocery(url),
      idOf: (url) => delhaizeIdFrom(url),
      build: (product, url) => buildDelhaizeProduct(product, url),
    })
  }
}

export const delhaize = new DelhaizeScraper()
