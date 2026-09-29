// Kaufland Romania, read from its WEEKLY LEAFLET: the only product data the site
// publishes. Checked 2026-09-29 with the crawler's own user agent.
//
// kaufland.ro has no online assortment (its sitemap is recipes, an ingredient
// encyclopedia and brand pages), but the leaflet page carries every offer as JSON
// in a window.SSR blob: this week's and next week's, ~680 of them, each with
// Kaufland's own article number, the brand, the product, the pack size and the
// leaflet's own category. One request a night.
//
// A LEAFLET IS NOT AN ASSORTMENT, and the difference is handled by never letting
// a run sweep (`sweeps = false`). A product leaves the leaflet on Tuesday and
// stays on the shelf, so "not seen tonight" says nothing here. Every offer ever
// seen stays a Kaufland listing, and the catalog grows by what each week's
// leaflet adds. The ceiling: a product Kaufland stops selling keeps its badge,
// since nothing here can ever say it is gone.
//
// NO PRICE, for the same reason. The leaflet price is a discount that ends on
// Tuesday, and a listing that never sweeps would carry it forever as if it were
// the shelf price.
//
// SKIPPED: an offer for "diverse sortimente" (one line for many flavours, so no
// one product), an offer under several brands ("Snickers / Mars / Twix"), and a
// Kaufland Card promotion, whose text names the discount rather than the product.
//
// ONLY THE GROCERIES, by the leaflet's own numbered categories, which hold every
// offer. Cosmetics are left out whole: the catalog imports no makeup or perfume,
// and the leaflet has no finer shelf to tell a shampoo from a perfume. The themed
// categories (a weekly "Crizanteme", "Plante de toamnă") only serve to drop the
// plants from "Legume, fructe, flori".

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { parseQuantity, keyFold, usableBrand } from '../../core/normalize.ts'

const ORIGIN = 'https://www.kaufland.ro'
const LEAFLET = `${ORIGIN}/oferte/oferte-saptamanale/saptamana-curenta.html`

export interface KauflandOffer {
  klNr?: string
  title?: string
  subtitle?: string
  unit?: string | null
  detailTitle?: string
  detailDescription?: string
}

interface LeafletCategory {
  name?: string
  displayName?: string
  offers?: KauflandOffer[]
}

// Folded leaflet category names, in the order they are tried. null is a
// grocery category with no single shelf: deli and frozen share one.
const SHELVES: Array<[RegExp, Category | null]> = [
  [/^legume/, 'produce'],
  [/^carne/, 'meat'],
  [/^peste/, 'fish'],
  [/^lactate/, 'dairy'],
  [/^delicatese/, null],
  [/^alimente de baza/, 'pantry'],
  [/^brutarie/, 'bakery'],
  [/^cafea si ceai/, 'drinks'],
  [/^dulciuri/, 'snacks'],
  [/^bauturi/, 'drinks'],
  [/^curatenie/, 'household'],
  [/^animale/, 'pet'],
]

const PLANTS = /crizanteme|plante/

/** The leaflet's categories, brace-matched out of the page's window.SSR blob. */
export function parseLeaflet(html: string): LeafletCategory[] | null {
  const marker = html.indexOf('"offerData":')
  if (marker < 0) return null
  const start = html.indexOf('{', marker)
  // String-aware, unlike Carrefour's: an offer's text may hold a brace.
  let depth = 0
  let inString = false
  for (let i = start; i >= 0 && i < html.length; i++) {
    const c = html[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try {
        const data = JSON.parse(html.slice(start, i + 1)) as { cycles?: Array<{ categories?: LeafletCategory[] }> }
        return (data.cycles ?? []).flatMap((cycle) => cycle.categories ?? [])
      } catch {
        return null
      }
    }
  }
  return null
}

function lines(text: string | undefined): string[] {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
}

export function buildKauflandProduct(offer: KauflandOffer, category: Category | null): RetailerProduct | null {
  const externalId = offer.klNr?.trim()
  const title = offer.title?.trim() ?? ''
  if (!externalId || !title || title.includes('/')) return null
  const detail = lines(offer.detailDescription)
  const subtitle = lines(offer.subtitle)
  if (/diverse sortimente/i.test(`${offer.subtitle}\n${offer.detailDescription}`)) return null
  if (/^reducere cu/i.test(offer.detailTitle ?? '')) return null

  // The title is the brand when the description repeats it ("Cris-Tim" over
  // "Salam uscat"), and the product itself when it is unbranded ("Ardei gras").
  const branded = detail.length > 0 && keyFold(detail[0]) === keyFold(title)
  const name = branded ? subtitle[0] : lines(offer.detailTitle).join(' ')
  if (!name) return null

  const parsed = parseQuantity(offer.unit) ?? parseQuantity(offer.subtitle)
  return {
    retailer: 'kaufland',
    externalId,
    name,
    brand: branded ? usableBrand(title) : null,
    gtin: null,
    price: null,
    currency: null,
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category,
    productUrl: LEAFLET,
    available: true,
  }
}

/** Every grocery offer on the page, once, with the shelf its category names. */
export function kauflandProducts(categories: LeafletCategory[]): RetailerProduct[] {
  const plants = new Set<string>()
  for (const c of categories) {
    if (PLANTS.test(keyFold(c.displayName))) for (const o of c.offers ?? []) if (o.klNr) plants.add(o.klNr)
  }
  const products = new Map<string, RetailerProduct>()
  for (const c of categories) {
    const shelf = SHELVES.find(([re]) => re.test(keyFold(c.displayName)))
    if (!shelf) continue
    for (const offer of c.offers ?? []) {
      if (!offer.klNr || plants.has(offer.klNr) || products.has(offer.klNr)) continue
      const product = buildKauflandProduct(offer, shelf[1])
      if (product) products.set(offer.klNr, product)
    }
  }
  return [...products.values()]
}

export class KauflandScraper implements RetailerScraper {
  readonly retailer = 'kaufland'
  readonly country: Market = 'RO'
  readonly domain = 'kaufland.ro'
  readonly implemented = true
  readonly sweeps = false

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    const http = new HttpClient({ minIntervalMs: ctx.minIntervalMs ?? 1000, timeoutMs: 45_000, retries: 2, fetchImpl: ctx.fetchImpl })

    const robots = await fetchRobots((url) => http.get(url), ORIGIN)
    if (!isAllowed(robots, LEAFLET)) throw new Error('kaufland robots.txt disallows the leaflet; refusing to read it')

    const page = await http.get(LEAFLET)
    const categories = page.ok ? parseLeaflet(page.body) : null
    // Loud rather than empty: a redesign that moves the blob must not read as a
    // week with no offers.
    if (!categories?.length) throw new Error(`kaufland: no offer data on the leaflet page (HTTP ${page.status})`)

    const products = kauflandProducts(categories)
    ctx.reportProgress?.(1, 1, 'pages')
    let yielded = 0
    for (const product of products) {
      if (ctx.limit !== undefined && yielded >= ctx.limit) return
      yield product
      yielded++
    }
  }
}

export const kaufland = new KauflandScraper()
