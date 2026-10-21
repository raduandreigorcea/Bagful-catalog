-- ─── Knuspr (Germany) and Gurkerl (Austria) ─────────────────────────────────
-- A row in catalog_retailers is a CLAIM THAT DATA CAN ARRIVE. It can: both sites
-- list ~16k products in /sitemap_products.xml and put each one, with its price
-- and shelf, on the page (src/retailers/rohlik, checked with the crawler's own
-- user agent on 2026-10-21). Germany held 6.5k listings and Austria 13k, the
-- thinnest of the markets the app already derives.
insert into public.catalog_retailers (slug, name, country, domain) values
  ('knuspr-de', 'Knuspr', 'DE', 'knuspr.de'),
  ('gurkerl-at', 'Gurkerl', 'AT', 'gurkerl.at')
on conflict (slug) do update
  set name = excluded.name, country = excluded.country, domain = excluded.domain;
