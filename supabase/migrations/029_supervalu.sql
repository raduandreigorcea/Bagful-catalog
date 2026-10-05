-- ─── SuperValu Ireland ──────────────────────────────────────────────────────
-- A row in catalog_retailers is a CLAIM THAT DATA CAN ARRIVE. It can: the
-- department listings on shop.supervalu.ie carry each product, with its price,
-- stock and categories, in the page state read by src/retailers/supervalu
-- (checked with the crawler's own user agent on 2026-10-05). The first Irish
-- chain in the catalog, beside Lidl and Aldi.
insert into public.catalog_retailers (slug, name, country, domain) values
  ('supervalu', 'SuperValu', 'IE', 'shop.supervalu.ie')
on conflict (slug) do update
  set name = excluded.name, country = excluded.country, domain = excluded.domain;
