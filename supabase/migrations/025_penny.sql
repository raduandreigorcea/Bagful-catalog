-- ─── Penny Romania ──────────────────────────────────────────────────────────
-- A row in catalog_retailers is a CLAIM THAT DATA CAN ARRIVE. It can: Penny's
-- sitemap lists its current offers as product pages, read by src/retailers/penny
-- (checked with the crawler's own user agent on 2026-09-29). Like Kaufland's,
-- its runs never sweep, so a product that leaves the promotion keeps its listing.
insert into public.catalog_retailers (slug, name, country, domain) values
  ('penny', 'Penny', 'RO', 'penny.ro')
on conflict (slug) do update
  set name = excluded.name, country = excluded.country, domain = excluded.domain;
