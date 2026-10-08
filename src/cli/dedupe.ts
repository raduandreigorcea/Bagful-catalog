// dedupe [--apply]
//
// The one-off cleanup behind the importer's step 3b (033_dedupe.sql): products
// already in the catalog that share a match key, in groups no shop lists twice.
// Without --apply it only prints them, one group per block, the kept product
// first; redirect it to a file and read it before merging anything.
//
// With --apply each group is merged into its first product through
// catalog_merge_products(), one pair at a time, so a group a nightly import
// changed in the meantime is refused on its own and reported, not half-merged.
// Every merge is recorded and can be undone from the admin's Duplicates page.
// Run --apply outside the nightly scrape (scrape.yml): a merge and an import
// touching the same product can deadlock, and Postgres then drops one of them.

import process from 'node:process'
import { connect } from '../importer/run.ts'
import { loadEnvFiles } from './env.ts'

interface Group {
  match_key: string
  product_ids: string[]
  names: string[]
  retailers: string[]
}

// PostgREST caps a response at 1000 rows, an RPC's included.
const PAGE = 1000
// Keys filled per call. Each call must finish inside the API's 8 s statement
// timeout; 5000 did locally and did not on the live project mid-import.
const KEY_BATCH = 1000

async function main(): Promise<void> {
  loadEnvFiles()
  const apply = process.argv.includes('--apply')
  const db = connect()

  // First, the keys 033 left empty: the migration adds the column and the
  // trigger keys new rows, but filling 184k existing ones in the migration would
  // have held the table for over a minute. Derived data, so the dry run fills
  // it too; it decides nothing. After the first run every batch is a no-op.
  let filled = 0
  for (let after: string | null = null; ; ) {
    const { data, error } = await db.rpc('catalog_backfill_match_keys', { p_after: after, p_limit: KEY_BATCH })
    if (error) throw new Error(`catalog_backfill_match_keys: ${error.message}`)
    if (data === null) break
    after = data as string
    filled += KEY_BATCH
    if (filled % 50000 === 0) console.error(`keyed ${filled} products...`)
  }

  const groups: Group[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.rpc('catalog_match_groups').range(from, from + PAGE - 1)
    if (error) throw new Error(`catalog_match_groups: ${error.message}`)
    groups.push(...(data as Group[]))
    if ((data as Group[]).length < PAGE) break
  }

  const drops = groups.reduce((n, g) => n + g.product_ids.length - 1, 0)

  if (!apply) {
    for (const g of groups) {
      console.log(`${g.match_key}  [${g.retailers.join(', ')}]`)
      g.names.forEach((name, i) => console.log(`  ${i === 0 ? 'keep' : 'drop'}  ${name}`))
    }
    console.log(`\n${groups.length} groups, ${drops} products would be merged. Nothing changed; --apply merges them.`)
    return
  }

  let merged = 0
  let refused = 0
  for (const g of groups) {
    const [keep, ...rest] = g.product_ids
    for (const drop of rest) {
      const { error } = await db.rpc('catalog_merge_products', { p_keep: keep, p_drop: drop, p_source: 'cleanup' })
      if (error) {
        refused++
        console.error(`refused ${g.match_key} ${drop}: ${error.message}`)
      } else {
        merged++
      }
    }
  }
  console.log(`${merged} merged, ${refused} refused, of ${drops}.`)
  if (refused > 0) process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
