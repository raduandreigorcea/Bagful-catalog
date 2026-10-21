-- ─── fewer scheduled recounts, for the Disk IO budget ───────────────────────
-- Supabase warned (2026-10-06) that the free instance was depleting its Disk IO
-- budget. pg_stat_statements showed two recounts that rewrite a whole table on
-- a clock: the stats cache every 15 minutes (11 s a run) and the near-duplicate
-- pairs every hour (43 s a run, about 11k blocks dirtied each). The nightly
-- import is the biggest writer by far, but it is one burst; these two ran
-- around it all day.
--
-- Pairs only change when products arrive, and products arrive in the nightly
-- import (scrape.yml: 01:20 UTC, up to 6 h crawl + 5 h load). 13:07 UTC is after
-- the longest that can take. The stats page is only read by a person, so an
-- hour is as fresh as it needs to be.
--
-- cron.schedule replaces a job of the same name, so re-running this file does
-- not stack a second one.

select cron.schedule('catalog-near-duplicates-refresh', '7 13 * * *', $$select public.catalog_near_duplicates_refresh()$$);
select cron.schedule('catalog-stats-refresh', '2 * * * *', $$select public.catalog_stats_refresh()$$);

comment on function public.catalog_near_duplicates_refresh() is
  'Recount catalog_near_duplicate_pairs. Daily at 13:07 UTC by pg_cron, after the nightly import.';
