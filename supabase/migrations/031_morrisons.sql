-- ─── Morrisons ──────────────────────────────────────────────────────────────
-- A row in catalog_retailers is a CLAIM THAT DATA CAN ARRIVE. It can, in part:
-- the category pages on groceries.morrisons.com carry their products in the
-- page state, read by src/retailers/morrisons (checked with the crawler's own
-- user agent on 2026-10-05). Its product pages refuse us and each category page
-- shows its first ~25 products, so the scraper never sweeps. The first British
-- chain in the catalog beside Lidl and Aldi; Tesco, Sainsbury's and Asda refuse.
insert into public.catalog_retailers (slug, name, country, domain) values
  ('morrisons', 'Morrisons', 'GB', 'groceries.morrisons.com')
on conflict (slug) do update
  set name = excluded.name, country = excluded.country, domain = excluded.domain;
