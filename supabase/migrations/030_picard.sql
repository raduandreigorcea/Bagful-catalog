-- ─── Picard ─────────────────────────────────────────────────────────────────
-- A row in catalog_retailers is a CLAIM THAT DATA CAN ARRIVE. It can: picard.fr
-- lists its products in a sitemap and marks each one up in schema.org microdata,
-- barcode included, read by src/retailers/picard (checked with the crawler's own
-- user agent on 2026-10-05). The first French chain in the catalog beside Lidl
-- and Aldi.
insert into public.catalog_retailers (slug, name, country, domain) values
  ('picard', 'Picard', 'FR', 'picard.fr')
on conflict (slug) do update
  set name = excluded.name, country = excluded.country, domain = excluded.domain;
