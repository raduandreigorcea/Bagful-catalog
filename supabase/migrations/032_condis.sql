-- ─── Condis ─────────────────────────────────────────────────────────────────
-- A row in catalog_retailers is a CLAIM THAT DATA CAN ARRIVE. It can: Condis's
-- online shop lists its products in a sitemap and streams each one's record in
-- the page's Next.js flight data, read by src/retailers/condis (checked with the
-- crawler's own user agent on 2026-10-05). The first Spanish chain in the
-- catalog beside Lidl and Aldi.
insert into public.catalog_retailers (slug, name, country, domain) values
  ('condis', 'Condis', 'ES', 'compraonline.condis.es')
on conflict (slug) do update
  set name = excluded.name, country = excluded.country, domain = excluded.domain;
