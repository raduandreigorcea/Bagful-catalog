-- ─── Ahorramas (Spain) ───────────────────────────────────────────────────────
-- A row in catalog_retailers is a CLAIM THAT DATA CAN ARRIVE. It can: the shop
-- lists 4,514 products in /sitemap_0-product.xml and puts each one, with its
-- price, brand and stock state, on the page (src/retailers/ahorramas, checked
-- with the crawler's own user agent on 2026-10-21). Spain held 9.7k listings.
insert into public.catalog_retailers (slug, name, country, domain) values
  ('ahorramas', 'Ahorramas', 'ES', 'ahorramas.com')
on conflict (slug) do update
  set name = excluded.name, country = excluded.country, domain = excluded.domain;
