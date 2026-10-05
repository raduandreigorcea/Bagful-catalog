// Condis, the Catalan supermarket chain: its online shop, read through the
// sitemap and the product record in each page's Next.js flight data. Checked
// with the crawler's own user agent on 2026-10-05.
//
// 7,545 products, each published twice, in Spanish (/es_ES) and in Catalan
// (/ca_ES), under the same id. Only the Spanish pages are read, so a listing is
// never renamed twice a night.
//
// NO SCHEMA.ORG BLOCK. The page is a Next.js app router page: its data arrives
// as string chunks pushed onto `self.__next_f`, which joined together hold a
// `productInformation` object (id, brand, name in capitals, `list_price` in
// cents, `net_amount` "1.0 kilogramos", the aisle's id `parent_category_id`).
// The page's category tree names that aisle with its whole path,
// `c08__cat00160008__cat001600080013`: department c08, second level
// cat00160008. No barcode, and no stock flag: a page that lists a price is a
// product on sale.
//
// ONLY THE GROCERIES, by that path. The eleven departments (c01 to c11, read
// from the sitemap's category pages on 2026-10-05) are an allowlist, so one
// Condis adds later is left out until somebody looks at it. Carved out: perfume
// and cosmetics, the pharmacy aisle, garden and barbecue, pet accessories, and,
// by the aisle's name, nail care. The nicotine vapes sit in a household aisle
// called "Resto de artículos" beside ordinary household goods, so they are the
// one thing decided by the product's NAME ("Vaper-nicot prime ..."), and only
// by a word nothing edible carries. A page whose aisle cannot be placed is counted as a
// page with no product, never excluded: excluding removes a listing.

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { crawlProductPages } from '../../core/pageCrawl.ts'
import { parseQuantity, httpsUrl, usableBrand, unshout } from '../../core/normalize.ts'

const ORIGIN = 'https://compraonline.condis.es'
const SITEMAP = `${ORIGIN}/sitemap.xml`
const PRODUCT_URL = /^\/[^/]+\/p\/(\d+)\/es_ES$/

export const CONDIS_DEPARTMENTS: Readonly<Record<string, Category | null>> = {
  c01: 'pantry', // Alimentación
  c02: null, // Mundo placer: sweets, biscuits, coffee, breakfast
  c03: null, // Frescos: meat, fish, fruit, vegetables, cheese
  c04: null, // Refrigerados: yogurt, butter, fresh pasta, ready meals
  c05: 'frozen', // Congelados
  c06: 'alcohol', // Bodega
  c07: 'drinks', // Bebidas
  c08: 'personal-care', // Perfumeria e higiene
  c09: 'household', // Limpieza y hogar
  c10: 'baby', // Mundo bebe
  c11: 'pet', // Mundo mascota
}

const NOT_GROCERY_SECTIONS = new Set([
  'c08__cat00160001', // Colonias y perfumes
  'c08__cat00160003', // Cosméticos
  'c08__cat00010012', // Parafarmacia
  'c09__cat00010003', // Jardinería y barbacoa
  'c11__cat00040001', // Accesorios para animales
])

const NOT_GROCERY_AISLES = /manicura|u[ñn]as|esmalte|tabaco/i
const NICOTINE = /vaper|nicot/i

export function condisIdFrom(url: string): string | null {
  return PRODUCT_URL.exec(new URL(url).pathname)?.[1] ?? null
}

/** What a product page says. */
export interface CondisPage {
  id: string | null
  name: string | null
  brand: string | null
  /** Euro, from the cents the page carries; the sale price when there is one. */
  price: number | null
  netAmount: string | null
  /** The aisle's id with its whole path, "c08__cat00160008__cat001600080013". */
  path: string | null
  /** The aisle's name, "Peinado, manicura y pedicura". */
  aisle: string | null
}

/** The flight data a Next.js app router page streams, joined into one string. */
export function flightText(html: string): string {
  const chunks: string[] = []
  for (const match of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      chunks.push(JSON.parse(match[1]) as string)
    } catch {
      // A chunk that is not a JSON string literal is not data we read.
    }
  }
  return chunks.join('')
}

/** The JSON value that follows `"key":` in `text`, or null. */
function valueAfter(text: string, key: string): unknown {
  const at = text.indexOf(`"${key}":`)
  if (at < 0) return null
  const rest = text.slice(at + key.length + 3)
  // One JSON value, by brace matching outside strings.
  if (rest[0] !== '{') return null
  let depth = 0
  let inString = false
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(rest.slice(0, i + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

type Json = Record<string, unknown>
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

function pathOf(flight: string, aisleId: string | null): string | null {
  if (!aisleId || !/^cat\d+$/.test(aisleId)) return null
  return new RegExp(`"id":"(c\\d\\d(?:__cat\\d+)*__${aisleId})"`).exec(flight)?.[1] ?? null
}

/** The product a page holds, or null for a page with none (or a redesign). */
export function readCondisPage(html: string): CondisPage | null {
  const flight = flightText(html)
  const info = valueAfter(flight, 'productInformation') as Json | null
  if (!info || typeof info !== 'object') return null
  const cents = [info.sale_price, info.list_price].find((p) => typeof p === 'number' && p > 0) as number | undefined
  return {
    id: text(info.ID),
    name: text(info.description),
    brand: text(info.brand),
    price: cents === undefined ? null : Math.round(cents) / 100,
    netAmount: text(info.net_amount),
    path: pathOf(flight, text(info.parent_category_id)),
    aisle: text(info.parent_category_description),
  }
}

/** Only for a page whose path is known; see the header on why. */
export function isCondisGrocery(page: CondisPage): boolean {
  if (!page.path) return false
  const [department, section] = page.path.split('__')
  return Object.prototype.hasOwnProperty.call(CONDIS_DEPARTMENTS, department)
    && !NOT_GROCERY_SECTIONS.has(`${department}__${section}`)
    && !NOT_GROCERY_AISLES.test(page.aisle ?? '')
    && !NICOTINE.test(page.name ?? '')
}

// "1.0 kilogramos", "0.75 litros", "6.0 unidades": the words parseQuantity reads.
function netAmount(value: string | null): string | null {
  if (!value) return null
  return value
    .replace(/kilogramos?/i, 'kg')
    .replace(/gramos?/i, 'g')
    .replace(/mililitros?/i, 'ml')
    .replace(/centilitros?/i, 'cl')
    .replace(/litros?/i, 'l')
}

export function buildCondisProduct(page: CondisPage, url: string): RetailerProduct | null {
  const externalId = page.id ?? condisIdFrom(url)
  if (!page.name || !page.path || !externalId) return null
  const name = unshout(page.name.replace(/\s+/g, ' '))
  const parsed = parseQuantity(netAmount(page.netAmount)) ?? parseQuantity(name)
  return {
    retailer: 'condis',
    externalId,
    name,
    brand: usableBrand(page.brand),
    gtin: null,
    price: page.price,
    currency: page.price === null ? null : 'EUR',
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: CONDIS_DEPARTMENTS[page.path.split('__')[0]] ?? null,
    productUrl: httpsUrl(url) ?? url,
    available: page.price !== null,
  }
}

export class CondisScraper implements RetailerScraper {
  readonly retailer = 'condis'
  readonly country: Market = 'ES'
  readonly domain = 'compraonline.condis.es'
  readonly implemented = true

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    const http = new HttpClient({
      minIntervalMs: ctx.minIntervalMs ?? 1000,
      timeoutMs: 45_000,
      retries: 2,
      fetchImpl: ctx.fetchImpl,
    })

    const robots = await fetchRobots((url) => http.get(url), ORIGIN)
    if (!isAllowed(robots, `${ORIGIN}/ejemplo/p/1/es_ES`)) {
      throw new Error('condis robots.txt disallows product pages; refusing to crawl')
    }

    yield* crawlProductPages({
      retailer: this.retailer,
      http,
      ctx,
      sitemapUrls: [SITEMAP],
      supportsIncremental: false,
      urlFilter: (url) => PRODUCT_URL.test(new URL(url).pathname),
      keep: (html) => {
        const page = readCondisPage(html)
        return page === null || page.path === null || isCondisGrocery(page)
      },
      idOf: (url) => condisIdFrom(url),
      buildPage: (html, url) => {
        const page = readCondisPage(html)
        return page && buildCondisProduct(page, url)
      },
    })
  }
}

export const condis = new CondisScraper()
