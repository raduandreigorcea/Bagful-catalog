-- ─── Dedupe: the same product, written by another shop ──────────────────────
-- merge_key (002) decides "the same text": brand, name without its size, size.
-- Shops do not write one product the same way. Carrefour says "Mountain Dew 1L",
-- Auchan "Bautura carbogazoasa Mountain Dew, 1 l", and with no GTIN from
-- Carrefour those were two products. On 2026-10-08 about 2,600 rows were
-- duplicates of that kind.
--
-- So a product gets a SECOND key: the words left once the brand, the size,
-- joining words ("de", "cu") and a leading "Bautura carbogazoasa" are gone, in
-- any order, plus the size and the pack count. Never a flavour, a product kind
-- or the packaging: a can and a bottle are two products, and so are still and
-- sparkling water (a first version that ignored "doza", "sticla" and
-- "carbogazoasa" anywhere merged them, and was caught in review). A looser rule that
-- ignored every word many brands share was tried on the live catalog the same
-- day and would have merged La Molisana spaghetti with its penne, because
-- "spaghetti" and "strawberry" are exactly the words that tell products apart.
--
-- What uses it:
--   * the importer (004, step 3b), only when exactly one product holds the key,
--     the shop has no listing on it yet, and no second barcode is involved;
--   * catalog_match_groups(), the one-off cleanup (`npm run catalog:dedupe`);
--   * the admin's Duplicates page, for the near misses a person decides.
-- Every merge goes through catalog_merge_products() and can be undone.

-- ─── the match key ───────────────────────────────────────────────────────────
-- brand | sorted distinct words | canonical size | pack count
--
-- No brand or no size means NO key, so the product is never matched this way:
-- "Lapte 1L" with no maker says nothing about which milk it is.
--
-- Every word counts whatever its length: "marimea 1" and "marimea 2" are
-- different pads, eggs M and L different eggs. Only the listed joining words go.
--
-- The pack count is separate because the quantity is the TOTAL: six 250 ml cans
-- and a 1.5 l bottle both hold 1500 ml. "5+1 x 0.33 l" is a pack of six.
create or replace function public.catalog_match_key(
  p_brand    text,
  p_name     text,
  p_quantity numeric,
  p_unit     text
)
returns text
language sql
immutable
set search_path = public, extensions
as $fn$
  with b as (
    select public.catalog_key_fold(p_brand) as brand,
           public.catalog_canonical_quantity(p_quantity, p_unit) as qty,
           coalesce((
             select (m[1])::int + coalesce((m[2])::int, 0)
               from regexp_match(lower(coalesce(p_name, '')), '(\d+)\s*(?:\+\s*(\d+)\s*)?x\s*\d') as m
           ), 1) as pack
  ),
  w as (
    select distinct t
      from b, regexp_split_to_table(
             -- The one phrase dropped whole, and only as the START of a name:
             -- the way Auchan and Mega Image open every soft drink. Anywhere
             -- else "carbogazoasa" is what tells sparkling water from still.
             regexp_replace(
               public.catalog_key_fold(public.catalog_strip_quantity(coalesce(p_name, ''))),
               '^bautura (racoritoare )?carbogazoasa( |$)', ''),
             ' ') as t
     where t <> ''
       and t <> all (string_to_array(b.brand, ' '))
       -- Joining words only. NOT packaging ("doza", "sticla", "PET": a can
       -- and a bottle are two products) and NOT by length, which dropped the
       -- M and L of egg sizes and the XL of a condom. Both were found merging
       -- different products in review on 2026-10-08.
       and t <> all (array[
         'de', 'cu', 'si', 'la', 'in', 'din', 'pe', 'pentru', 'buc', 'bucati',
         'the', 'and', 'with', 'of', 'for', 'in'
       ])
  )
  select case
    when b.brand = '' or b.qty = '-' then null
    else b.brand
      || '|' || coalesce((select string_agg(t, ' ' order by t) from w), '')
      || '|' || b.qty
      || '|' || b.pack
  end
  from b
$fn$;

comment on function public.catalog_match_key(text, text, numeric, text) is
  'The second identity: brand | words left after brand, size and filler, sorted | size | pack. null without a brand or a size.';

-- Not a client function, for merge_key's reason: a client that can compute it
-- can craft a name that lands on somebody else's product.
revoke all on function public.catalog_match_key(text, text, numeric, text) from public, anon, authenticated;

alter table public.catalog_products add column if not exists match_key text;

comment on column public.catalog_products.match_key is
  'catalog_match_key(brand, canonical_name, quantity, quantity_unit). NOT unique: two products may share it until somebody merges them.';

create index if not exists catalog_products_match_key_idx
  on public.catalog_products (match_key) where match_key is not null;

-- Its own trigger rather than a line in 002's catalog_products_derive: editing
-- 002 would mean re-pushing it, and this column does not exist when 002 runs on
-- a fresh build.
create or replace function public.catalog_products_match_key()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  new.match_key := public.catalog_match_key(new.brand, new.canonical_name, new.quantity, new.quantity_unit);
  return new;
end;
$fn$;

drop trigger if exists catalog_products_match_key on public.catalog_products;
create trigger catalog_products_match_key
  before insert or update of canonical_name, brand, quantity, quantity_unit on public.catalog_products
  for each row execute function public.catalog_products_match_key();

-- ─── the backfill, in batches, AFTER the migration ───────────────────────────
-- Not an UPDATE here. `add column` holds catalog_products exclusively until the
-- migration commits, and filling 184k keys took 77 s on a copy of the live
-- data: every search, barcode lookup and shop badge in both apps would have
-- waited that long. So the migration only adds the column (instant), and
-- `npm run catalog:dedupe` fills it through this, a few thousand rows a call,
-- each call its own short transaction holding only row locks.
--
-- Returns the last id it reached, to pass back as p_after; null when there is
-- nothing past p_after. New and renamed products need none of this: the
-- trigger above keys them as they are written. Stamps updated_at through
-- catalog_products_derive, which nothing reads.
create or replace function public.catalog_backfill_match_keys(p_after uuid, p_limit int default 5000)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_last uuid;
begin
  select b.id into v_last
    from (select id from public.catalog_products
           where p_after is null or id > p_after
           order by id
           limit greatest(1, least(coalesce(p_limit, 5000), 20000))) b
   order by b.id desc
   limit 1;
  if v_last is null then
    return null;
  end if;

  update public.catalog_products p
     set match_key = k.key
    from (select id, public.catalog_match_key(brand, canonical_name, quantity, quantity_unit) as key
            from public.catalog_products
           where (p_after is null or id > p_after) and id <= v_last) k
   where p.id = k.id
     and p.match_key is distinct from k.key;

  return v_last;
end;
$fn$;

comment on function public.catalog_backfill_match_keys(uuid, int) is
  'Fill match_key for up to p_limit products after p_after, in id order. Returns the last id reached, null when done.';

revoke all on function public.catalog_backfill_match_keys(uuid, int) from public, anon, authenticated;
grant execute on function public.catalog_backfill_match_keys(uuid, int) to service_role;

-- ─── the merge, and the record that makes it undoable ───────────────────────
-- A merge moves every listing and barcode of one product onto another and
-- deletes the empty one. The listings keep their own wording, price and stock:
-- they are still what each shop says. The search blob and listing_count follow
-- the listings by 002's trigger, so the kept product is found by the other
-- shop's words, and catalog_shops_for still answers a list row named the old way.
--
-- It sticks without help: the next import of a moved listing meets step 2 of
-- the importer (this listing is already recorded) before any key is computed.
--
-- The record keeps the deleted product WHOLE, and which listings and barcodes
-- moved, so undo restores exactly that and nothing that arrived afterwards.
create table if not exists public.catalog_product_merges (
  id             uuid primary key default gen_random_uuid(),
  keep_id        uuid not null,
  drop_id        uuid not null,
  drop_row       jsonb not null,
  listing_ids    uuid[] not null default '{}',
  identifier_ids uuid[] not null default '{}',
  source         text not null,
  merged_by      text,
  merged_at      timestamptz not null default now(),
  undone_at      timestamptz
);

-- No foreign keys on purpose: the dropped product no longer exists, and an admin
-- deleting the kept one later must not erase the record of what happened.
comment on table public.catalog_product_merges is
  'Every merge: the product deleted, whole, and which listings and barcodes moved. catalog_unmerge reads it.';

alter table public.catalog_product_merges drop constraint if exists catalog_product_merges_source_check;
alter table public.catalog_product_merges add constraint catalog_product_merges_source_check
  check (source in ('cleanup', 'admin'));

create index if not exists catalog_product_merges_merged_at on public.catalog_product_merges (merged_at desc);

alter table public.catalog_product_merges enable row level security;
revoke all on public.catalog_product_merges from anon, authenticated;

-- "These are different", said by a person on the admin's Duplicates page. Read
-- by the Duplicates page and by the cleanup, so neither offers the pair again.
create table if not exists public.catalog_merge_rejections (
  product_a   uuid not null,
  product_b   uuid not null,
  rejected_by text,
  rejected_at timestamptz not null default now(),
  primary key (product_a, product_b)
);

-- Stored in one order so (a, b) and (b, a) are one row. No foreign keys: a
-- rejection naming a product that later goes is harmless, and cheaper than a
-- cascade.
alter table public.catalog_merge_rejections drop constraint if exists catalog_merge_rejections_order_check;
alter table public.catalog_merge_rejections add constraint catalog_merge_rejections_order_check
  check (product_a < product_b);

comment on table public.catalog_merge_rejections is
  'Pairs an admin said are different products. Neither the Duplicates page nor the cleanup offers them again.';

alter table public.catalog_merge_rejections enable row level security;
revoke all on public.catalog_merge_rejections from anon, authenticated;

create or replace function public.catalog_merge_products(p_keep uuid, p_drop uuid, p_source text)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_drop     public.catalog_products;
  v_listings uuid[];
  v_idents   uuid[];
  v_id       uuid;
begin
  if p_keep is null or p_drop is null or p_keep = p_drop then
    raise exception 'merge needs two different products';
  end if;

  -- Both rows locked in one order, so two merges of the same pair cannot
  -- interleave.
  perform 1 from public.catalog_products where id in (p_keep, p_drop) order by id for update;
  select * into v_drop from public.catalog_products where id = p_drop;
  if v_drop.id is null or not exists (select 1 from public.catalog_products where id = p_keep) then
    raise exception 'product not found';
  end if;

  -- One shop listing both means that shop sells them as two products.
  if exists (
    select 1
      from public.catalog_listings a
      join public.catalog_listings b on b.retailer_id = a.retailer_id
     where a.product_id = p_keep and b.product_id = p_drop
  ) then
    raise exception 'both products are listed by the same shop';
  end if;

  -- Two different barcodes are two articles. The barcode is the one identity
  -- this catalog fully trusts, and a merge would leave the second one pointing
  -- at the first product: scanning sparkling water would answer still water.
  if exists (select 1 from public.catalog_identifiers where product_id = p_keep and identifier_type = 'gtin')
     and exists (select 1 from public.catalog_identifiers where product_id = p_drop and identifier_type = 'gtin') then
    raise exception 'both products carry a barcode, so they are different articles';
  end if;

  select coalesce(array_agg(id), '{}') into v_listings from public.catalog_listings where product_id = p_drop;
  select coalesce(array_agg(id), '{}') into v_idents from public.catalog_identifiers where product_id = p_drop;

  insert into public.catalog_product_merges (keep_id, drop_id, drop_row, listing_ids, identifier_ids, source, merged_by)
  values (p_keep, p_drop, to_jsonb(v_drop), v_listings, v_idents, p_source, public.requesting_user_id())
  returning id into v_id;

  update public.catalog_listings set product_id = p_keep where product_id = p_drop;
  update public.catalog_identifiers set product_id = p_keep where product_id = p_drop;
  update public.catalog_products set add_count = add_count + v_drop.add_count where id = p_keep;
  delete from public.catalog_products where id = p_drop;

  return v_id;
end;
$fn$;

comment on function public.catalog_merge_products(uuid, uuid, text) is
  'Move one product''s listings and barcodes onto another, record it, delete the empty one. Refuses when one shop lists both.';

create or replace function public.catalog_unmerge(p_merge_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_m public.catalog_product_merges;
  v_r public.catalog_products;
  v_elsewhere uuid;
begin
  select * into v_m from public.catalog_product_merges where id = p_merge_id for update;
  if v_m.id is null then
    raise exception 'merge not found';
  end if;
  if v_m.undone_at is not null then
    raise exception 'merge already undone';
  end if;

  v_r := jsonb_populate_record(null::public.catalog_products, v_m.drop_row);

  -- Refused rather than half-done. If the listings that moved are no longer on
  -- the kept product, it was merged on into another one (or deleted, taking
  -- them with it), and restoring this product would bring back an empty row
  -- while its listings stayed merged elsewhere.
  if cardinality(v_m.listing_ids) > 0 and not exists (
    select 1 from public.catalog_listings where id = any (v_m.listing_ids) and product_id = v_m.keep_id
  ) then
    v_elsewhere := (select l.product_id from public.catalog_listings l where l.id = any (v_m.listing_ids) limit 1);
    if v_elsewhere is not null then
      raise exception 'its listings were merged again since, into product %; undo that merge first', v_elsewhere;
    end if;
    raise exception 'its listings are gone since (deleted or purged); there is nothing to give back';
  end if;
  if not exists (select 1 from public.catalog_products where id = v_m.keep_id) then
    raise exception 'the kept product was deleted since; there is nothing to give back';
  end if;
  -- A product with the same name, brand and size arrived since, and merge_key
  -- is unique. Postgres would refuse anyway; this says why.
  if exists (
    select 1 from public.catalog_products
     where merge_key = public.catalog_merge_key(v_r.brand, v_r.canonical_name, v_r.quantity, v_r.quantity_unit)
  ) then
    raise exception 'a product with the same name, brand and size exists since; merge or delete it first';
  end if;

  -- Named columns, not the whole row: popularity is generated, and listing_count
  -- and search_blob are the triggers' to fill.
  insert into public.catalog_products (id, canonical_name, brand, quantity, quantity_unit, category, add_count, first_seen_at)
  values (v_r.id, v_r.canonical_name, v_r.brand, v_r.quantity, v_r.quantity_unit, v_r.category, v_r.add_count, v_r.first_seen_at);

  -- Only what moved, and only if it is still where the merge put it.
  update public.catalog_listings set product_id = v_r.id
   where id = any (v_m.listing_ids) and product_id = v_m.keep_id;
  update public.catalog_identifiers set product_id = v_r.id
   where id = any (v_m.identifier_ids) and product_id = v_m.keep_id;
  update public.catalog_products set add_count = greatest(0, add_count - v_r.add_count)
   where id = v_m.keep_id;

  update public.catalog_product_merges set undone_at = now() where id = p_merge_id;
end;
$fn$;

comment on function public.catalog_unmerge(uuid) is
  'Undo a merge: the deleted product returns with the listings and barcodes that moved, and nothing that arrived since.';

revoke all on function public.catalog_merge_products(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.catalog_unmerge(uuid) from public, anon, authenticated;
grant execute on function public.catalog_merge_products(uuid, uuid, text) to service_role;
grant execute on function public.catalog_unmerge(uuid) to service_role;

-- ─── the cleanup's groups ────────────────────────────────────────────────────
-- What the importer's step 3b would have merged had it existed when these rows
-- arrived: products sharing a match key, as long as no shop lists two of them
-- (a shop listing both is a shop selling two products). `npm run catalog:dedupe`
-- prints them, and with --apply merges each into the first id.
--
-- The first id is the one whose name says its brand (the name both apps show:
-- Mega Image writes "Cascaval 240g" where Auchan writes "Cascaval Napolact,
-- 240 g"), then the one most shops list, then one with a barcode, then the
-- oldest.
create or replace function public.catalog_match_groups()
returns table (match_key text, product_ids uuid[], names text[], retailers text[])
language sql
stable
security definer
set search_path = public
-- 14 s on the live catalog. PostgREST applies a function's statement_timeout
-- in place of the role's 8 s; the cleanup calls this once per 1000 groups.
set statement_timeout = '120s'
as $fn$
  with candidates as (
    select p.match_key
      from public.catalog_products p
     where p.match_key is not null
     group by p.match_key
    having count(*) > 1
  ),
  -- Skipped whole, rather than merged around: a group where a shop lists two
  -- of the products, where two carry a barcode (the merge would refuse), or
  -- where a person already decided something (rejected a pair, or undid a
  -- merge, which a second run would otherwise quietly redo).
  clean as (
    select c.match_key
      from candidates c
     where not exists (
       select 1
         from public.catalog_products p
         join public.catalog_listings l on l.product_id = p.id
        where p.match_key = c.match_key
        group by l.retailer_id
       having count(distinct p.id) > 1
     )
       and (select count(distinct i.product_id)
              from public.catalog_identifiers i
              join public.catalog_products p on p.id = i.product_id
             where p.match_key = c.match_key and i.identifier_type = 'gtin') <= 1
       and not exists (
         select 1
           from public.catalog_products p
          where p.match_key = c.match_key
            and (exists (select 1 from public.catalog_merge_rejections r where p.id in (r.product_a, r.product_b))
              or exists (select 1 from public.catalog_product_merges m
                          where m.undone_at is not null and p.id in (m.keep_id, m.drop_id)))
       )
  )
  select c.match_key,
         array_agg(p.id order by
                   -- the name both apps show: one that says its brand first
                   (public.catalog_key_fold(p.canonical_name) like '%' || public.catalog_key_fold(p.brand) || '%') desc,
                   p.listing_count desc,
                   exists (select 1 from public.catalog_identifiers i where i.product_id = p.id) desc,
                   p.first_seen_at, p.id),
         array_agg(p.canonical_name order by
                   -- the name both apps show: one that says its brand first
                   (public.catalog_key_fold(p.canonical_name) like '%' || public.catalog_key_fold(p.brand) || '%') desc,
                   p.listing_count desc,
                   exists (select 1 from public.catalog_identifiers i where i.product_id = p.id) desc,
                   p.first_seen_at, p.id),
         (select array_agg(distinct r.slug order by r.slug)
            from public.catalog_listings l
            join public.catalog_retailers r on r.id = l.retailer_id
            join public.catalog_products q on q.id = l.product_id
           where q.match_key = c.match_key)
    from clean c
    join public.catalog_products p on p.match_key = c.match_key
   group by c.match_key
   order by c.match_key
$fn$;

comment on function public.catalog_match_groups() is
  'Products sharing a match key that no shop lists twice, the one to keep first. Read by npm run catalog:dedupe.';

revoke all on function public.catalog_match_groups() from public, anon, authenticated;
grant execute on function public.catalog_match_groups() to service_role;

-- ─── the admin's Duplicates page ─────────────────────────────────────────────
-- The near misses the match key leaves: one brand, one size, one pack, but more
-- than one set of words. Mega Image's "Bautura carbogazoasa cu gust de citrice
-- 1L" is Mountain Dew 1L to a person and not to the key, because "citrice" is a
-- word. A person says "same product" (a merge, recorded as theirs) or "different"
-- (the pair is remembered and not asked again).
--
-- A pair counts only when its two products have different match keys (equal keys
-- are the cleanup's job) and no shop lists both (a shop listing both sells two
-- products). Each such pair not rejected is one candidate; rejections are
-- kept in catalog_merge_rejections, above. Two products that
-- both carry a barcode can still appear, and the merge refuses them by name.

-- brand | size | pack: the match key without its words.
create or replace function public.catalog_match_family(p_match_key text)
returns text
language sql
immutable
as $fn$
  select split_part(p_match_key, '|', 1) || '|' || split_part(p_match_key, '|', 3) || '|' || split_part(p_match_key, '|', 4)
$fn$;

revoke all on function public.catalog_match_family(text) from public, anon, authenticated;

create index if not exists catalog_products_match_family_idx
  on public.catalog_products (public.catalog_match_family(match_key)) where match_key is not null;

create or replace function public.catalog_admin_near_duplicates(p_limit int default 25, p_offset int default 0)
returns table (family text, products jsonb, total bigint)
language plpgsql
stable
security definer
set search_path = public
-- ~9 s on the live catalog, past the 8 s budget a request gets (020).
set statement_timeout = '30s'
as $fn$
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  -- Set-based, not a correlated check per pair: the live catalog has ~18,500
  -- families with more than one set of words, the largest 257 products, so about
  -- a million pairs. Each product's shops are gathered ONCE and a pair compares
  -- two arrays; asked per pair through the listings, the first version ran for
  -- over ten minutes on a copy of the live data.
  --
  -- A pair is offered only when its products share a country and a word (the
  -- key's words, brand already out). Without those, 6,251 groups on the live
  -- catalog, mostly a Spanish name against a French one or two flavours with
  -- nothing in common. The exception is a name that is only brand and size
  -- ("Mountain Dew 1L"): it has no words to share, and it is exactly what Mega
  -- Image's "cu gust de citrice" is. Those come last.
  return query
  with fams as (
    select public.catalog_match_family(p.match_key) as fam
      from public.catalog_products p
     where p.match_key is not null
     group by 1
    having count(distinct p.match_key) > 1
  ),
  members as (
    select p.id, p.match_key, f.fam,
           string_to_array(split_part(p.match_key, '|', 2), ' ') as words,
           coalesce((select array_agg(l.retailer_id) from public.catalog_listings l where l.product_id = p.id), '{}') as shops,
           coalesce((select array_agg(distinct r.country)
                       from public.catalog_listings l
                       join public.catalog_retailers r on r.id = l.retailer_id
                      where l.product_id = p.id), '{}') as countries
      from fams f
      join public.catalog_products p
        on p.match_key is not null
       and public.catalog_match_family(p.match_key) = f.fam
  ),
  pairs as (
    select x.fam, x.id as a, y.id as b,
           -- Shared words over all words: 1 is the same words in another order.
           (select count(*) from unnest(x.words) w where w = any(y.words))::numeric
             / greatest(1, (select count(distinct w) from unnest(x.words || y.words) w)) as score
      from members x
      join members y
        on y.fam = x.fam
       and x.id < y.id
       and x.match_key <> y.match_key
       and not (x.shops && y.shops)
       and x.countries && y.countries
       and (x.words && y.words or cardinality(x.words) = 0 or cardinality(y.words) = 0)
     where not exists (
       select 1 from public.catalog_merge_rejections r
        where r.product_a = x.id and r.product_b = y.id
     )
  ),
  -- PAIRS, not families: words like "balsam" and "par" chain every Pantene 160 ml
  -- into one family of 22, which nobody can decide on. Most alike first, so a
  -- person's time goes to the likeliest merges and the doubtful ones sink.
  -- `family` keeps the family in front, then the pair, so it is unique per row.
  page as (
    select p.fam || '|' || p.a || '|' || p.b as key, p.a, p.b, p.score, count(*) over () as total
      from pairs p
     order by p.score desc, p.fam, p.a, p.b
     limit greatest(1, least(coalesce(p_limit, 25), 100)) offset greatest(0, coalesce(p_offset, 0))
  )
  select pg.key,
         (select jsonb_agg(jsonb_build_object(
                   'id', p.id,
                   'name', p.canonical_name,
                   'brand', p.brand,
                   'match_key', p.match_key,
                   'retailers', (select coalesce(jsonb_agg(distinct r.slug), '[]'::jsonb)
                                   from public.catalog_listings l
                                   join public.catalog_retailers r on r.id = l.retailer_id
                                  where l.product_id = p.id))
                 order by p.listing_count desc, p.canonical_name)
            from public.catalog_products p
           where p.id in (pg.a, pg.b)),
         pg.total
    from page pg
   order by pg.score desc, pg.key;
end;
$fn$;

comment on function public.catalog_admin_near_duplicates(int, int) is
  'Groups of one brand, size and pack with more than one set of words, and a pair no shop lists twice and nobody rejected.';

create or replace function public.catalog_admin_merge(p_keep uuid, p_drop uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  return public.catalog_merge_products(p_keep, p_drop, 'admin');
end;
$fn$;

-- "Different" for a whole group: every pair in one statement. Pair by pair from
-- the browser was one round trip per pair, ~33,000 for the largest family, and
-- a failure halfway left half of them written.
create or replace function public.catalog_admin_reject_group(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  insert into public.catalog_merge_rejections (product_a, product_b, rejected_by)
  select a, b, public.requesting_user_id()
    from unnest(p_ids) as a, unnest(p_ids) as b
   where a < b
  on conflict do nothing;
end;
$fn$;

create or replace function public.catalog_admin_merges(p_limit int default 25, p_offset int default 0)
returns table (
  id uuid, keep_id uuid, keep_name text, drop_name text, source text,
  merged_by text, merged_at timestamptz, undone_at timestamptz, total bigint
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  return query
  select m.id, m.keep_id, k.canonical_name, m.drop_row ->> 'canonical_name', m.source,
         m.merged_by, m.merged_at, m.undone_at, count(*) over ()
    from public.catalog_product_merges m
    left join public.catalog_products k on k.id = m.keep_id
   order by m.merged_at desc, m.id
   limit greatest(1, least(coalesce(p_limit, 25), 100)) offset greatest(0, coalesce(p_offset, 0));
end;
$fn$;

create or replace function public.catalog_admin_unmerge(p_merge_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  perform public.catalog_unmerge(p_merge_id);
end;
$fn$;

revoke all on function public.catalog_admin_near_duplicates(int, int) from public, anon;
revoke all on function public.catalog_admin_merge(uuid, uuid) from public, anon;
revoke all on function public.catalog_admin_reject_group(uuid[]) from public, anon;
revoke all on function public.catalog_admin_merges(int, int) from public, anon;
revoke all on function public.catalog_admin_unmerge(uuid) from public, anon;
grant execute on function public.catalog_admin_near_duplicates(int, int) to authenticated;
grant execute on function public.catalog_admin_merge(uuid, uuid) to authenticated;
grant execute on function public.catalog_admin_reject_group(uuid[]) to authenticated;
grant execute on function public.catalog_admin_merges(int, int) to authenticated;
grant execute on function public.catalog_admin_unmerge(uuid) to authenticated;
