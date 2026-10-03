-- ─── Aldi France and Aldi Spain ─────────────────────────────────────────────
-- A row in catalog_retailers is a CLAIM THAT DATA CAN ARRIVE. It can: both sites
-- list their products in a sitemap and put each one, with its price and shelf,
-- in the page's Next.js state, read by src/retailers/aldi-nord (checked with the
-- crawler's own user agent on 2026-10-03). They were the first readable shops
-- found in either country beyond Lidl.
insert into public.catalog_retailers (slug, name, country, domain) values
  ('aldi-fr', 'Aldi', 'FR', 'aldi.fr'),
  ('aldi-es', 'Aldi', 'ES', 'aldi.es')
on conflict (slug) do update
  set name = excluded.name, country = excluded.country, domain = excluded.domain;
