// Morrisons: read through its category pages, which carry their products in
// the page state. Checked with the crawler's own user agent on 2026-10-05.
//
// THE PRODUCT PAGES REFUSE US. groceries.morrisons.com answers a product page
// with a CloudFront 403 ("Request blocked"), while robots.txt allows it and the
// category pages answer 200. So the crawl reads the 2,322 grocery category
// pages in /sitemaps/sitemap-categories-part1.xml, and each one holds its
// products in `window.__INITIAL_STATE__` (`data.products.productEntities`):
// name, brand, price, stock, pack size, and the department path.
//
// A CATEGORY PAGE SHOWS ITS FIRST ~25 PRODUCTS. The rest load from /api/,
// which robots.txt disallows, and no page parameter shows more (checked
// 2026-10-05: Apple Juices holds 37 and the page shows 25). Reading every
// level of the tree reaches most of the shop, since small aisles fit whole and
// a big one shows its first 25 at each level, but never all of it. So the
// scraper declares `sweeps = false`: every run closes as a deliberate partial,
// and a product not seen tonight keeps its listing, as at Kaufland.
//
// NO BARCODE: the retailer id is the shop's own number.
//
// ONLY THE GROCERIES, by the department path: the same slugs in the category
// URLs and in each product's own path ("Make Up & Nails" is make-up-nails).
// Only grocery category pages are fetched (an allowlist). A product found on
// one is kept unless its OWN path is positively not groceries, because a
// product's own path can be a themed aisle: facial tissues are filed under
// events-inspiration-ways-to-save/.../savers, and refusing them would remove a
// grocery. Not groceries: toys and clothing, home and garden, the tobacco
// kiosk, food to order, health and medicines, and within the grocery
// departments makeup and nails, fragrance gifts, hair styling appliances and
// nursery toys.

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient, CircuitOpenError } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { collectSitemapEntries } from '../../core/pageCrawl.ts'
import { readAssignedState } from '../../core/pageState.ts'
import { parseQuantity, usableBrand } from '../../core/normalize.ts'

const ORIGIN = 'https://groceries.morrisons.com'
const SITEMAP = `${ORIGIN}/sitemaps/sitemap-categories-part1.xml`
const CATEGORY_URL = /^\/categories\/(.+)\/\d+$/

// Department slug to shelf, read 2026-10-05.
const DEPARTMENTS: Record<string, Category | null> = {
  'fruit-veg': 'produce',
  'meat-fish': 'meat',
  'fresh-foods': null,
  'bakery-cakes': 'bakery',
  'food-cupboard': 'pantry',
  'world-foods': 'pantry',
  'treats-snacks': 'snacks',
  'frozen-food': 'frozen',
  drinks: 'drinks',
  'beer-wines-spirits': 'alcohol',
  'dietary-lifestyle-foods': null,
  'toiletries-beauty': 'personal-care',
  'baby-toddler': 'baby',
  household: 'household',
  'pet-shop': 'pet',
}

const NOT_GROCERY_DEPARTMENTS = new Set([
  'toys-clothing-entertainment',
  'home-garden',
  'kiosk',
  'food-to-order',
  'health-wellbeing-medicines',
])

const NOT_GROCERY_AISLES = /^(toiletries-beauty\/(make-up-nails|gifting-fragrances|hair-styling-appliances)|baby-toddler\/nursery-items-toys)(\/|$)/

/** "Make Up & Nails" -> "make-up-nails", the shop's own URL slugs. */
export function morrisonsSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** Whether a CATEGORY PAGE is worth fetching: a grocery department, outside the carve-outs. */
export function isMorrisonsGroceryPath(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(DEPARTMENTS, path.split('/')[0]) && !NOT_GROCERY_AISLES.test(path)
}

/** Whether a product's own path says it is NOT groceries. Unknown or themed is not evidence. */
export function isMorrisonsNonGrocery(path: string): boolean {
  return NOT_GROCERY_DEPARTMENTS.has(path.split('/')[0]) || NOT_GROCERY_AISLES.test(path)
}

/** The product as a category page's state holds it. */
export interface MorrisonsEntity {
  retailerProductId?: string
  name?: string
  brand?: string
  available?: boolean
  categoryPath?: string[]
  price?: { current?: { amount?: string; currency?: string } }
  size?: { value?: string }
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null

/** The products a category page holds, or null when the state is missing (a redesign). */
export function readMorrisonsPage(html: string): MorrisonsEntity[] | null {
  const state = readAssignedState(html, '__INITIAL_STATE__')
  const data = isObject(state) && isObject(state.data) ? state.data : null
  const products = data && isObject(data.products) ? data.products : null
  if (!products || !isObject(products.productEntities)) return null
  return Object.values(products.productEntities).filter(isObject) as MorrisonsEntity[]
}

export function morrisonsPathOf(entity: MorrisonsEntity): string {
  return (entity.categoryPath ?? []).map(morrisonsSlug).join('/')
}

/** `department`: the grocery department of the page it was found on, for a product filed under a themed aisle. */
export function buildMorrisonsProduct(entity: MorrisonsEntity, department: string): RetailerProduct | null {
  const name = entity.name?.replace(/\s+/g, ' ').trim()
  const id = entity.retailerProductId?.trim()
  if (!name || !id) return null
  const amount = Number(entity.price?.current?.amount)
  const price = amount > 0 ? amount : null
  const parsed = parseQuantity(entity.size?.value) ?? parseQuantity(name)
  return {
    retailer: 'morrisons',
    externalId: id,
    name,
    brand: usableBrand(entity.brand),
    gtin: null,
    price,
    currency: price === null ? null : (entity.price?.current?.currency ?? 'GBP'),
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: DEPARTMENTS[morrisonsPathOf(entity).split('/')[0]] ?? DEPARTMENTS[department] ?? null,
    // The page a person opens; the slug is the shop's own, made from the name.
    productUrl: `${ORIGIN}/products/${morrisonsSlug(name)}/${id}`,
    available: entity.available === true,
  }
}

export class MorrisonsScraper implements RetailerScraper {
  readonly retailer = 'morrisons'
  readonly country: Market = 'GB'
  readonly domain = 'groceries.morrisons.com'
  readonly implemented = true
  readonly sweeps = false

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    const http = new HttpClient({
      minIntervalMs: ctx.minIntervalMs ?? 1000,
      timeoutMs: 45_000,
      retries: 2,
      fetchImpl: ctx.fetchImpl,
    })

    const robots = await fetchRobots((url) => http.get(url), ORIGIN)
    if (!isAllowed(robots, `${ORIGIN}/categories/food-cupboard/102705`)) {
      throw new Error('morrisons robots.txt disallows the category pages; refusing to crawl')
    }

    const pages = (await collectSitemapEntries(http, ctx, [SITEMAP]))
      .map((e) => ({ url: e.loc, path: CATEGORY_URL.exec(new URL(e.loc).pathname)?.[1] }))
      .filter((p): p is { url: string; path: string } => p.path !== undefined && isMorrisonsGroceryPath(p.path))
    const wanted = ctx.shard ? pages.filter((_, i) => i % ctx.shard!.of === ctx.shard!.index) : pages
    ctx.log.info('morrisons: grocery category pages', { pages: pages.length, reading: wanted.length })
    if (wanted.length === 0) {
      ctx.reportIncomplete?.('the sitemap listed no grocery category pages')
      return
    }

    const seen = new Set<string>()
    let unreadable = 0
    let emitted = 0
    for (const [index, { url, path }] of wanted.entries()) {
      ctx.reportProgress?.(index, wanted.length, 'categories')
      if (ctx.signal?.aborted) return
      let response
      try {
        response = await http.get(url)
      } catch (error) {
        if (error instanceof CircuitOpenError) {
          ctx.reportIncomplete?.(`circuit opened after ${index} of ${wanted.length} category pages`)
          return
        }
        unreadable++
        continue
      }
      const entities = response.ok ? readMorrisonsPage(response.body) : null
      if (!entities) {
        unreadable++
        continue
      }
      for (const entity of entities) {
        const id = entity.retailerProductId
        if (!id || seen.has(id)) continue
        seen.add(id)
        if (isMorrisonsNonGrocery(morrisonsPathOf(entity))) {
          await ctx.reportExcluded?.(id)
          continue
        }
        const product = buildMorrisonsProduct(entity, path.split('/')[0])
        if (!product) continue
        yield product
        emitted++
        if (ctx.limit && emitted >= ctx.limit) return
      }
      if ((index + 1) % 200 === 0) ctx.log.info('morrisons: crawling', { pages: index + 1, of: wanted.length, products: seen.size, unreadable })
    }
    ctx.reportProgress?.(wanted.length, wanted.length, 'categories')
    ctx.log.info('morrisons: crawl finished', { pages: wanted.length, products: seen.size, unreadable })
    // Mostly unreadable is a redesign, not a quiet night: say so rather than
    // closing as if the shop had shrunk.
    if (unreadable > wanted.length / 2) ctx.reportIncomplete?.(`${unreadable} of ${wanted.length} category pages could not be read`)
  }
}

export const morrisons = new MorrisonsScraper()
