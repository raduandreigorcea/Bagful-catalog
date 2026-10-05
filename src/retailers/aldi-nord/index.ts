// Aldi Nord: France, Spain and Germany, read from the product data in each
// page's Next.js state. ONE SCRAPER, THREE COUNTRIES.
//
// A different company from Aldi Süd (src/retailers/aldi) with a different site.
// aldi.fr and aldi.es list every product in /.aldi-nord-sitemap-products.xml,
// and each product page carries no schema.org block at all: the product sits in
// __NEXT_DATA__, as a JSON STRING inside it (`props.pageProps.apiData`), with
// its name, brand, sales unit, price and the shelf it is filed on. Checked with
// the crawler's own user agent on 2026-10-03; Germany (aldi-nord.de, /produkt/,
// `aldi-nord-de` because `aldi-de` is Aldi Süd) on 2026-10-05. Belgium runs the
// same platform and is not read yet.
//
// NO BARCODE, ANYWHERE, the same accepted cost as Aldi Süd and Carrefour.
//
// ONLY THE GROCERIES, decided by the shelf: the `parentCategory` the page names
// (`epiceriesalee`, `bebidas-alcoholicas`), and the product's own
// `mainCategoryID` when there is no parent, which is how France files fresh
// fruit and vegetables. An ALLOWLIST, as for Aldi Süd, because the weekly
// non-food specials are what a missing entry must not let in.
//
// HALF OF FRANCE'S SITEMAP IS RETIRED PRODUCTS. They stay online for search
// engines, filed under `maintien-seo` with no price and no stock, and the
// allowlist refuses them like any other unknown shelf. Spain's retired pages
// carry no product at all and count as pages without one.
//
// A QUARTER OF GERMANY IS WEEKLY OFFERS, filed under `Angebote` with no finer
// shelf: cheesecake beside gloves, fleece shirts and potted plants. Nothing on
// the page tells them apart, so the allowlist leaves the whole shelf out, and
// the seasonal ones (wintersortiment, ostern) and the highlights (which hold an
// air fryer) with it. ~1,700 of its 2,234 pages are groceries.

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { crawlProductPages } from '../../core/pageCrawl.ts'
import { parseQuantity, httpsUrl, usableBrand, unshout } from '../../core/normalize.ts'

export interface AldiNordCountry {
  readonly slug: string
  readonly country: Market
  readonly origin: string
  /** Where a product URL starts: /fiches-produits/<slug>-<id>.html. */
  readonly productPrefix: string
  readonly currency: string
  /** Shelf key to the catalog's shelf. Only these are imported. */
  readonly shelves: Readonly<Record<string, Category | null>>
}

// A null shelf is a grocery aisle that is not one of ours, imported with no
// category rather than guessed.
const FRANCE: Record<string, Category | null> = {
  // No parent category: France files fresh produce and nuts on their own.
  '42-fruits-et-legumes-frais': 'produce',
  '44-fruits-secs-et-graines': 'snacks',
  viandesetpoissons: 'meat',
  charcuterieettraiteur: 'meat',
  laitieroeufs: 'dairy',
  painsetviennoiseries: 'bakery',
  epiceriesalee: 'pantry',
  epiceriesucree: 'pantry',
  produitssurgeles: 'frozen',
  nosboissons: 'drinks',
  bierevinalcool: 'alcohol',
  entretienetnettoyage: 'household',
  hygienebeautebebe: 'personal-care',
  Animalerie: 'pet',
}

const SPAIN: Record<string, Category | null> = {
  // No parent category: Spain files fresh fish on its own.
  'pescado-fresco': 'fish',
  'pescados-y-mariscos': 'fish',
  'fruta-y-verdura': 'produce',
  carne: 'meat',
  charcuteria: 'meat',
  'lacteos-y-huevos': 'dairy',
  quesos: 'dairy',
  'panaderia-y-bolleria': 'bakery',
  despensa: 'pantry',
  desayuno: 'pantry',
  'cafe-cacao-e-infusiones': 'pantry',
  aperitivos: 'snacks',
  'chocolates-y-dulces': 'snacks',
  'platos-preparados-y-pizzas': null,
  congelados: 'frozen',
  bebidas: 'drinks',
  'bebidas-alcoholicas': 'alcohol',
  'limpieza-y-hogar': 'household',
  'cuidado-personal': 'personal-care',
  'bebe-e-infantil': 'baby',
  mascotas: 'pet',
}

// The shelf keys the PAGES name, sampled from 190 pages on 2026-10-05. They
// differ from the URLs: /sortiment/vorraete/ is `vorraete-back-kochzutaten`.
const GERMANY: Record<string, Category | null> = {
  'obst-gemuese': 'produce',
  'fleisch-wurst': 'meat',
  'fisch-meeresfruechte': 'fish',
  milchprodukte: 'dairy',
  'backwaren-aufstriche-cerealien': 'bakery',
  'vorraete-back-kochzutaten': 'pantry',
  fertiggerichte: null,
  grillen: null,
  'vegane-produkte': null,
  'eis-kuchen-desserts': null,
  'snacks-suessigkeiten': 'snacks',
  'getraenke-heissgetraenke': 'drinks',
  'alkoholische-getraenke': 'alcohol',
  haushalt: 'household',
  'kosmetik-pflege': 'personal-care',
  babybedarf: 'baby',
  'tierbedarf-tierfutter': 'pet',
}

export const ALDI_NORD_COUNTRIES: readonly AldiNordCountry[] = [
  { slug: 'aldi-fr', country: 'FR', origin: 'https://www.aldi.fr', productPrefix: '/fiches-produits/', currency: 'EUR', shelves: FRANCE },
  { slug: 'aldi-es', country: 'ES', origin: 'https://www.aldi.es', productPrefix: '/producto/', currency: 'EUR', shelves: SPAIN },
  { slug: 'aldi-nord-de', country: 'DE', origin: 'https://www.aldi-nord.de', productPrefix: '/produkt/', currency: 'EUR', shelves: GERMANY },
]

/** The id every product URL ends in, "potimarron-0811.html" -> "0811". */
export function aldiNordIdFrom(url: string): string | null {
  return /-(\d+)\.html$/.exec(url)?.[1] ?? null
}

/** What a product page says, read out of its Next.js state. */
export interface AldiNordPage {
  id: string | null
  name: string | null
  brand: string | null
  salesUnit: string | null
  price: number | null
  available: boolean
  /** The parent category's key, or the product's own when it has no parent. */
  shelf: string | null
  /** The category below the shelf, where the carve-outs are decided. */
  aisle: string | null
}

const NEXT_DATA = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null

/** The first object, depth first, for which `test` holds. */
function find(value: unknown, test: (o: Json) => boolean, depth = 0): Json | null {
  if (!isObject(value) || depth > 8) return null
  if (test(value)) return value
  for (const child of Object.values(value)) {
    const hit = find(child, test, depth + 1)
    if (hit) return hit
  }
  return null
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** The product a page holds, or null for a page with none (or a redesign). */
export function readAldiNordPage(html: string): AldiNordPage | null {
  const raw = NEXT_DATA.exec(html)?.[1]
  if (!raw) return null
  let api: unknown
  try {
    // A string of JSON inside the JSON: parsed twice.
    const apiData = (JSON.parse(raw) as { props?: { pageProps?: { apiData?: unknown } } }).props?.pageProps?.apiData
    api = typeof apiData === 'string' ? JSON.parse(apiData) : apiData
  } catch {
    return null
  }

  const product = find(api, (o) => 'mainCategoryID' in o && 'name' in o)
  if (!product) return null
  const categories = find(api, (o) => isObject(o.parentCategory))?.parentCategory as Json | undefined
  const data = isObject(categories?.data) ? categories.data : {}
  const parent = isObject(data.parent) ? text(data.parent.categoryKey) : null
  const current = isObject(data.current) ? text(data.current.categoryKey) : null
  const price = isObject(product.currentPrice) ? product.currentPrice.priceValue : null

  return {
    id: text(product.objectID),
    name: text(product.name),
    brand: text(product.brandName),
    salesUnit: text(product.salesUnit),
    price: typeof price === 'number' && price > 0 ? price : null,
    available: product.isAvailable === true,
    shelf: parent ?? text(product.mainCategoryID),
    aisle: current,
  }
}

// Makeup, perfume and nails, carved out of personal care on 2026-09-27 for
// every shop: an aisle below an allowed shelf. Spain's `cosmetica` is its
// perfume aisle. Germany's household shelf also holds batteries and lighters.
const CARVED_OUT = /maquill|parfum|perfum|cosmetica|ongle|vernis|unas|manicur|batterien/

// France publishes promotion placeholders as products ("Assortment in Promotion
// II - Next week offer"): a slot in the leaflet, not something on a shelf.
const PLACEHOLDER = /^assortment\b/i

export function isAldiNordGrocery(country: AldiNordCountry, page: AldiNordPage | null): boolean {
  if (PLACEHOLDER.test(page?.name ?? '')) return false
  if (!page?.shelf || !Object.prototype.hasOwnProperty.call(country.shelves, page.shelf)) return false
  return !CARVED_OUT.test(page.aisle ?? '')
}

export function buildAldiNordProduct(page: AldiNordPage, url: string, country: AldiNordCountry): RetailerProduct | null {
  const name = page.name?.replace(/\s+/g, ' ')
  const externalId = page.id ?? aldiNordIdFrom(url)
  if (!name || !externalId) return null

  // The size is in the sales unit ("360G", "0,75 l unidad"), not the name.
  const parsed = parseQuantity(page.salesUnit) ?? parseQuantity(name)
  return {
    retailer: country.slug,
    externalId,
    name: unshout(name),
    brand: usableBrand(page.brand?.replace(/[®™]/g, '')),
    gtin: null,
    price: page.price,
    currency: page.price === null ? null : country.currency,
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: page.shelf !== null ? (country.shelves[page.shelf] ?? null) : null,
    productUrl: httpsUrl(url) ?? url,
    available: page.available,
  }
}

export class AldiNordScraper implements RetailerScraper {
  readonly retailer: string
  readonly country: Market
  readonly domain: string
  readonly implemented = true
  private readonly config: AldiNordCountry

  // Written out rather than as parameter properties: erasableSyntaxOnly, see the
  // note on UnimplementedScraper in core/registry.ts.
  constructor(config: AldiNordCountry) {
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
    if (!isAllowed(robots, `${config.origin}${config.productPrefix}example-1.html`)) {
      throw new Error(`${config.slug} robots.txt disallows product pages; refusing to crawl`)
    }

    yield* crawlProductPages({
      retailer: this.retailer,
      http,
      ctx,
      sitemapUrls: [`${config.origin}/sitemaps/.aldi-nord-sitemap-products.xml`],
      // Every entry carries the same lastmod, so nothing is gained by reading it.
      supportsIncremental: false,
      urlFilter: (url) => new URL(url).pathname.startsWith(config.productPrefix),
      // A page with no product is not a grocery decision; let it through to be
      // counted as one with no product rather than as excluded.
      keep: (html) => {
        const page = readAldiNordPage(html)
        return page === null || isAldiNordGrocery(config, page)
      },
      idOf: (url) => aldiNordIdFrom(url),
      buildPage: (html, url) => {
        const page = readAldiNordPage(html)
        return page && buildAldiNordProduct(page, url, config)
      },
    })
  }
}

export const ALDI_NORD_SCRAPERS: readonly AldiNordScraper[] = ALDI_NORD_COUNTRIES.map((c) => new AldiNordScraper(c))
