-- ─── Aldi Nord Germany ──────────────────────────────────────────────────────
-- A row in catalog_retailers is a CLAIM THAT DATA CAN ARRIVE. It can: aldi-nord.de
-- runs the platform src/retailers/aldi-nord already reads for France and Spain
-- (checked with the crawler's own user agent on 2026-10-05). `aldi-nord-de`,
-- because `aldi-de` is Aldi Süd, a different company with a different site.
insert into public.catalog_retailers (slug, name, country, domain) values
  ('aldi-nord-de', 'Aldi Nord', 'DE', 'aldi-nord.de')
on conflict (slug) do update
  set name = excluded.name, country = excluded.country, domain = excluded.domain;
