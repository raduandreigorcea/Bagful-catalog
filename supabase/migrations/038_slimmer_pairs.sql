-- ─── a smaller catalog, without losing a product ─────────────────────────────
-- The database stood at 413 MB of the free plan's 500 (2026-10-22). Two things in
-- it were bigger than they earned:
--
--   * catalog_products_name_folded. The text_pattern_ops index beside it answers
--     = as well as like 'x%' (checked with EXPLAIN: the planner uses it for both),
--     so the plain one only costs 19 MB and a write on every import.
--   * catalog_near_duplicate_pairs, 37 MB for 72,889 pairs of which 63,578 scored
--     under 0.5. Those are mostly different products, and the Duplicates page
--     lists best first, so nobody reached them.
--
-- The function moves here from 033, for the reason the migrations test gives.

drop index if exists public.catalog_products_name_folded;

create or replace function public.catalog_near_duplicates_refresh()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  delete from public.catalog_near_duplicate_pairs;

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
  insert into public.catalog_near_duplicate_pairs (a, b, fam, score)
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
           (cardinality(x.words) = 0 or cardinality(y.words) = 0) as bare,
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
  )
  select p.a, p.b, p.fam, p.score from pairs p
   -- Weak pairs are not kept: of 72,889 on 2026-10-22, 63,578 scored under 0.5 and
   -- were mostly different products (two flavours, two lines of one brand).
   -- A name that is only brand and size has no words to score, so it stays.
   where p.score >= 0.5 or p.bare;
end;
$fn$;


comment on function public.catalog_near_duplicates_refresh() is
  'Recount catalog_near_duplicate_pairs. Daily at 13:07 UTC by pg_cron, after the nightly import.';

revoke all on function public.catalog_near_duplicates_refresh() from public, anon, authenticated;
grant execute on function public.catalog_near_duplicates_refresh() to service_role;

-- TRUNCATE rather than the delete the function does: a delete leaves the file as
-- big as it was, and the plan counts the file. Counted now, so the table is
-- filled again before anyone opens the page.
truncate public.catalog_near_duplicate_pairs;
select public.catalog_near_duplicates_refresh();
