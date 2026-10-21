-- ─── nightly import: stop rewriting six indexes per listing ─────────────────
-- Supabase warned again (2026-10-21) that the Disk IO budget was depleted, and
-- searches slowed to seconds. pg_stat_statements put catalog_import_listings
-- first by far: 18.7 M blocks dirtied. catalog_listings had 5.2 M updates and
-- ONE heap-only (HOT) update. Every nightly import sets last_seen_at on every
-- listing it sees, and last_seen_at was in an index, which turns each of those
-- updates into a new row version plus a new entry in every index.
--
-- The index served the sweep (003: retailer_id = X and last_seen_at < start) and
-- the run log (023). Both filter on retailer_id first, which
-- catalog_listings_retailer_external_key (retailer_id, external_id) answers, so
-- they read one shop's listings (at most ~22k) and filter the date in memory.
--
-- The fillfactor leaves room in each page for the new row version. It applies
-- to pages written from now on; old pages gain room as vacuum clears them.
drop index if exists public.catalog_listings_retailer_seen;
alter table public.catalog_listings set (fillfactor = 85);
