-- ─── Freshful ───────────────────────────────────────────────────────────────
-- A row in catalog_retailers is a CLAIM THAT DATA CAN ARRIVE. It can: freshful.ro
-- lists its products in a sitemap and puts each one, with its price, stock and
-- department path, in the page's Next.js state, read by src/retailers/freshful
-- (checked with the crawler's own user agent on 2026-10-05).
--
-- THE SCRAPER WAS NOT KEPT. The same day the catalog was steered toward the
-- thinner countries abroad (Romania held ~47% of the listings), so Freshful was
-- left unbuilt. This row was already applied to the live catalog, and this file
-- stays so the migration history matches it. The row holds no listings; delete
-- it from catalog_retailers (and revert 027) to drop Freshful for good.
insert into public.catalog_retailers (slug, name, country, domain) values
  ('freshful', 'Freshful', 'RO', 'freshful.ro')
on conflict (slug) do update
  set name = excluded.name, country = excluded.country, domain = excluded.domain;
