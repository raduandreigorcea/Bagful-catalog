// SuperValu Ireland: read through its department listings, which carry the
// products themselves. Checked with the crawler's own user agent on 2026-10-05.
//
// THE LISTINGS, NOT THE PRODUCT PAGES. The sitemap names 11,807 product pages,
// and each weighs ~1.5 MB: ~18 GB a night, which is no way to treat a shop. A
// department listing weighs ~1.8 MB too, but holds 30 products, in the page's
// `window.__PRELOADED_STATE__` (`search.productCardDictionary`): name, brand,
// price, stock, and every category the product sits under. So the crawl pages
// through the seventeen grocery departments (`?page=N&skip=30*(N-1)`; both are
// needed) -- ~400 requests, ~10 minutes -- and fetches no product page at all.
// A department lists everything beneath it (Baby Nappies: 66, exactly the sum
// of its ten children), and says how many (`totalItems`), which is what makes
// the coverage measurable and a full run allowed to sweep.
//
// The state is not a published contract the way a schema.org block is. A
// redesign that moves it yields nothing, the count collapses, and the run is
// refused like Carrefour's would be.
//
// NO BARCODE: the sku is the shop's own number.
//
// ONLY THE GROCERIES, by the shop's category ids. The newsagent and tobacconist
// department is never read; cosmetics, gift sets, vitamins and supplements,
// medicines, stationery, homeware, shoe care, batteries and small appliances
// are read (they sit inside the departments that are) and excluded.

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { parseQuantity, usableBrand } from '../../core/normalize.ts'
import { readAssignedState } from '../../core/pageState.ts'

const ORIGIN = 'https://shop.supervalu.ie'
const PAGE_SIZE = 30

// The top departments and the shelf each maps to, read 2026-10-05. Leaving out
// O100080, Newsagent & Tobacconist.
export const SUPERVALU_DEPARTMENTS: Readonly<Record<string, Category | null>> = {
  O100001: 'produce', // Fruit & Vegetables
  O100010: 'bakery',
  O100015: 'meat', // Meat & Poultry
  O100017: 'fish',
  O100020: null, // Deli Counter
  O100023: 'dairy', // Cheese
  O100025: 'dairy', // Milk, Yogurt, Butter & Eggs
  O100027: null, // Health & Wellness: free-from, nuts, sports nutrition
  O100030: null, // Chilled Food
  O100035: 'pantry', // Food Cupboard
  O100045: 'frozen',
  O100050: 'drinks',
  O100055: 'personal-care',
  O100060: 'baby',
  O100065: 'household',
  O100070: 'pet',
  O100075: 'alcohol',
}

const NOT_GROCERIES = new Set([
  'O200495', // Cosmetics
  'O200820', // Gift Sets
  'O200690', // Vitamins & Supplements
  'O200465', // Medicines & Healthcare
  'O200744', // Stationery
  'O200757', // Homeware
  'O200742', // Shoe Care
  'O200560', // Batteries
  'O200750', // Small Appliances
])

/** One product card as the listing's state holds it. */
export interface SuperValuCard {
  sku?: string
  name?: string
  brand?: string
  price?: string
  available?: boolean
  sellBy?: string
  categories?: { retailerId?: string }[]
}

export interface SuperValuPage {
  total: number
  /** In the order the listing shows them. */
  cards: SuperValuCard[]
  /** sku -> the product page the listing links to. */
  links: Map<string, string>
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null

/** The listing a department page holds, or null when the state is missing (a redesign). */
export function readSuperValuPage(html: string): SuperValuPage | null {
  const state = readAssignedState(html, '__PRELOADED_STATE__')
  const search = isObject(state) ? state.search : null
  if (!isObject(search) || !isObject(search.productCardDictionary)) return null
  const dictionary = search.productCardDictionary as Record<string, SuperValuCard>
  const products = isObject(search.products) ? search.products : null
  const order = products && Array.isArray(products.category) ? (products.category as string[]) : Object.keys(dictionary)
  const totals = isObject(search.pagination) ? search.pagination : null
  const category = totals && isObject(totals.category) ? totals.category : null
  const total = category && typeof category.totalItems === 'number' ? category.totalItems : null
  if (total === null) return null

  const links = new Map<string, string>()
  for (const match of html.matchAll(/href="https:\/\/shop\.supervalu\.ie\/sm\/delivery\/rsid\/\d+(\/product\/[a-z0-9-]+-id-(\d+))"/g)) {
    links.set(match[2], `${ORIGIN}${match[1]}`)
  }
  return { total, cards: order.map((sku) => dictionary[sku]).filter((c): c is SuperValuCard => isObject(c)), links }
}

export function isSuperValuGrocery(card: SuperValuCard): boolean {
  return !(card.categories ?? []).some((c) => c.retailerId !== undefined && NOT_GROCERIES.has(c.retailerId))
}

export function buildSuperValuProduct(card: SuperValuCard, department: string, link: string | undefined): RetailerProduct | null {
  const name = card.name?.replace(/\s+/g, ' ').trim()
  const sku = card.sku?.trim()
  if (!name || !sku) return null

  // "€1,234.50". A product sold by weight shows a price per piece that is an
  // estimate, so it is left out rather than stored as if it were exact.
  const amount = Number((card.price ?? '').replace(/[€,\s]/g, ''))
  const price = card.sellBy === 'each' && amount > 0 ? amount : null
  // The size is in the name, in brackets: "Ginger Nut Biscuits (300 g)".
  const parsed = parseQuantity(name)
  return {
    retailer: 'supervalu',
    externalId: sku,
    name,
    brand: usableBrand(card.brand),
    gtin: null,
    price,
    currency: price === null ? null : 'EUR',
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: SUPERVALU_DEPARTMENTS[department] ?? null,
    productUrl: link ?? `${ORIGIN}/product/id-${sku}`,
    available: card.available === true,
  }
}

// A department's pages run out into an empty one. Food Cupboard, the largest,
// is 3,387 products, 113 pages; this only guards against one that never ends.
const MAX_PAGES = 300

export class SuperValuScraper implements RetailerScraper {
  readonly retailer = 'supervalu'
  readonly country: Market = 'IE'
  readonly domain = 'shop.supervalu.ie'
  readonly implemented = true

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    const http = new HttpClient({
      minIntervalMs: ctx.minIntervalMs ?? 1000,
      timeoutMs: 45_000,
      retries: 2,
      fetchImpl: ctx.fetchImpl,
    })

    const robots = await fetchRobots((url) => http.get(url), ORIGIN)
    if (!isAllowed(robots, `${ORIGIN}/categories/grocery/food-cupboard-id-O100035`)) {
      throw new Error('supervalu robots.txt disallows the department listings; refusing to crawl')
    }

    const departments = Object.keys(SUPERVALU_DEPARTMENTS)
    const seen = new Set<string>()
    let advertised = 0
    let read = 0
    let emitted = 0

    for (const [index, department] of departments.entries()) {
      ctx.reportProgress?.(index, departments.length, 'departments')
      let total = 0
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (ctx.signal?.aborted) return
        // The slug before the id is ignored by the shop, but a segment must be there.
        const url = `${ORIGIN}/categories/grocery/department-id-${department}?page=${page}&skip=${(page - 1) * PAGE_SIZE}`
        const response = await http.get(url)
        const listing = response.ok ? readSuperValuPage(response.body) : null
        if (!listing) {
          ctx.log.error('supervalu: a department page could not be read', { department, page, status: response.status })
          ctx.reportIncomplete?.(`department ${department} page ${page} could not be read`)
          return
        }
        total = listing.total
        if (listing.cards.length === 0) break
        read += listing.cards.length

        for (const card of listing.cards) {
          const sku = card.sku
          if (!sku || seen.has(sku)) continue
          seen.add(sku)
          if (!isSuperValuGrocery(card)) {
            await ctx.reportExcluded?.(sku)
            continue
          }
          const product = buildSuperValuProduct(card, department, listing.links.get(sku))
          if (!product) continue
          yield product
          emitted++
          if (ctx.limit && emitted >= ctx.limit) return
        }
        if (page * PAGE_SIZE >= total) break
      }
      advertised += total
      ctx.log.info('supervalu: department read', { department, total, products: seen.size })
    }

    ctx.reportProgress?.(departments.length, departments.length, 'departments')
    // Cards read against what the departments said they hold; a product listed in
    // two departments counts in both on each side.
    if (!ctx.shard) ctx.reportCoverage?.(read, advertised)
  }
}

export const supervalu = new SuperValuScraper()
