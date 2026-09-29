-- ─── Kaufland Romania ───────────────────────────────────────────────────────
-- A row in catalog_retailers is a CLAIM THAT DATA CAN ARRIVE, and until now
-- Kaufland deliberately had none: it publishes no assortment. Data can arrive
-- now, from its weekly leaflet (src/retailers/kaufland, checked with the
-- crawler's own user agent on 2026-09-29). Its runs never sweep, so a product
-- that leaves the leaflet keeps its Kaufland listing.
insert into public.catalog_retailers (slug, name, country, domain) values
  ('kaufland', 'Kaufland', 'RO', 'kaufland.ro')
on conflict (slug) do update
  set name = excluded.name, country = excluded.country, domain = excluded.domain;
