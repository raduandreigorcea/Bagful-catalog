-- The match key, the merge and its undo.
--
-- The match key exists to put two shops' wordings of ONE product under one
-- key, and the claims that matter are the ones that keep TWO products apart: a
-- variant word, a size, a pack, a missing brand. A key that merged too much
-- would be silent corruption; one that merges too little is a duplicate row.
begin;
select plan(54);

select is(public.catalog_match_key('Mountain Dew', 'Mountain Dew 1L', 1, 'l'),
          public.catalog_match_key('Mountain Dew', 'Bautura carbogazoasa Mountain Dew, 1 l', 1, 'l'),
  'filler words and word order do not separate one product');
select isnt(public.catalog_match_key('Mountain Dew', 'Mountain Dew Pitch Black 0.25 l', 0.25, 'l'),
            public.catalog_match_key('Mountain Dew', 'Mountain dew bautura racoritoare doza 250ml', 250, 'ml'),
  'a variant word keeps two products apart');
select isnt(public.catalog_match_key('Always', 'Absorbante Always Ultra marimea 1, 8 bucati', 8, 'buc'),
            public.catalog_match_key('Always', 'Absorbante Always Ultra marimea 2, 8 bucati', 8, 'buc'),
  'a digit in the name is a word');
select isnt(public.catalog_match_key('Mountain Dew', 'Mountain Dew 6x250ml', 1500, 'ml'),
            public.catalog_match_key('Mountain Dew', 'Mountain Dew 1.5L', 1.5, 'l'),
  'six cans are not one bottle of the same volume');
select isnt(public.catalog_match_key('Staropramen', 'Bere blonda Staropramen 5+1 x 0.33 l', 1.98, 'l'),
            public.catalog_match_key('Staropramen', 'Bere blonda Staropramen, 0.33 l', 0.33, 'l'),
  'a 5+1 offer is a pack');
select is(public.catalog_match_key(null, 'Mountain Dew 1L', 1, 'l'), null,
  'no brand, no key');
select is(public.catalog_match_key('Mountain Dew', 'Mountain Dew', null, null), null,
  'no size, no key');
select ok(not has_function_privilege('authenticated', 'public.catalog_match_key(text, text, numeric, text)', 'execute'),
  'a client cannot compute the key');

-- The backfill runs in batches after the migration, so the table is never held.
insert into public.catalog_products (canonical_name, brand, quantity, quantity_unit)
values ('Backfill Cola 1L', 'Backfill', 1, 'l'), ('Backfill Cola Zero 1L', 'Backfill', 1, 'l');
update public.catalog_products set match_key = null where brand = 'Backfill';
select public.catalog_backfill_match_keys(null, 1);
select is((select count(*)::int from public.catalog_products where brand = 'Backfill' and match_key is not null), 1,
  'a batch fills only its own size');
select is(public.catalog_backfill_match_keys((select id from public.catalog_products order by id desc limit 1), 1), null,
  'past the last product there is nothing left to fill');
select ok(not has_function_privilege('authenticated', 'public.catalog_backfill_match_keys(uuid, integer)', 'execute'),
  'the backfill is not a client function');
-- Found by review on 2026-10-08: each of these shared a key in the first version.
select isnt(public.catalog_match_key('Aqua Carpatica', 'Apa minerala necarbogazoasa Aqua Carpatica 1.5L', 1.5, 'l'),
            public.catalog_match_key('Aqua Carpatica', 'Apa minerala carbogazoasa Aqua Carpatica 1.5L', 1.5, 'l'),
  'still and sparkling water are two products');
select isnt(public.catalog_match_key('Ursus', 'Bere Ursus Premium doza 0.5L', 0.5, 'l'),
            public.catalog_match_key('Ursus', 'Bere Ursus Premium sticla 0.5L', 0.5, 'l'),
  'a can and a bottle are two products');
select isnt(public.catalog_match_key('Coca-Cola', 'Coca-Cola PET 0.5L', 0.5, 'l'),
            public.catalog_match_key('Coca-Cola', 'Coca-Cola sticla 0.5L', 0.5, 'l'),
  'plastic and glass are two products');
select isnt(public.catalog_match_key('Ferma', 'Oua marimea M 10 buc', 10, 'buc'),
            public.catalog_match_key('Ferma', 'Oua marimea L 10 buc', 10, 'buc'),
  'a one-letter size is a word');
select isnt(public.catalog_match_key('Durex', 'Prezervative Durex 12 buc', 12, 'buc'),
            public.catalog_match_key('Durex', 'Prezervative Durex XL 12 buc', 12, 'buc'),
  'XL is a word');
select isnt(public.catalog_match_key('John West', 'John West Tuna Chunks In Brine 3 Pack (80 g)', 80, 'g'),
            public.catalog_match_key('John West', 'John West Tuna Chunks In Brine (80 g)', 80, 'g'),
  '"3 Pack" is a pack');

-- ─── the merge ───────────────────────────────────────────────────────────────
-- Products and listings are written directly rather than imported: the
-- importer's own step 3b would already have merged these two.
delete from public.catalog_scrape_runs;
delete from public.catalog_listings;
delete from public.catalog_identifiers;
delete from public.catalog_products;

create temp table t_ids as
select (select id from public.catalog_retailers where slug = 'carrefour')  as carrefour,
       (select id from public.catalog_retailers where slug = 'auchan')     as auchan,
       (select id from public.catalog_retailers where slug = 'mega-image') as mega,
       gen_random_uuid() as keep, gen_random_uuid() as dropped,
       null::uuid as merge_id;

insert into public.catalog_products (id, canonical_name, brand, quantity, quantity_unit, add_count)
select keep, 'Mountain Dew 1L', 'Mountain Dew', 1, 'l', 3 from t_ids
union all
select dropped, 'Bautura carbogazoasa Mountain Dew, 1 l', 'Mountain Dew', 1, 'l', 2 from t_ids;

insert into public.catalog_listings (product_id, retailer_id, external_id, retailer_name, product_url)
select keep, carrefour, 'C1', 'Mountain Dew 1L', 'https://carrefour.ro/produse/c1' from t_ids
union all
select dropped, auchan, 'A1', 'Bautura carbogazoasa Mountain Dew, 1 l', 'https://www.auchan.ro/p/a1' from t_ids;

insert into public.catalog_identifiers (product_id, identifier_value, source)
select dropped, '5941234567890', 'auchan' from t_ids;

update t_ids set merge_id = public.catalog_merge_products(keep, dropped, 'cleanup');

select is((select count(*)::int from public.catalog_products), 1,
  'the merged product is gone');
select is((select listing_count from public.catalog_products p, t_ids where p.id = t_ids.keep), 2,
  'the kept product carries both shops');
select ok((select search_blob like '%bautura carbogazoasa%' from public.catalog_products p, t_ids where p.id = t_ids.keep),
  'the other shop''s wording still finds it');
select is((select product_id from public.catalog_identifiers), (select keep from t_ids),
  'the barcode moved with it');
select is((select add_count from public.catalog_products p, t_ids where p.id = t_ids.keep), 5,
  'popularity earned by either is kept');
select is((select cardinality(retailers) from public.catalog_shops_for(array['Bautura carbogazoasa Mountain Dew, 1 l'])), 2,
  'a list row named the old way finds both shops');

-- A third shop arrives on the kept product AFTER the merge. Undo must leave it.
insert into public.catalog_listings (product_id, retailer_id, external_id, retailer_name, product_url)
select keep, mega, 'M1', 'Bautura carbogazoasa cu gust de citrice 1L', 'https://www.mega-image.ro/p/m1' from t_ids;

select lives_ok($$select public.catalog_unmerge((select merge_id from t_ids))$$,
  'a merge can be undone');
select is((select count(*)::int from public.catalog_listings l, t_ids where l.product_id = t_ids.dropped), 1,
  'undo gives the product back its own listing');
select is((select count(*)::int from public.catalog_listings l, t_ids where l.product_id = t_ids.keep), 2,
  'and leaves what arrived later where it is');
select is((select product_id from public.catalog_identifiers), (select dropped from t_ids),
  'and its barcode');
select is((select add_count from public.catalog_products p, t_ids where p.id = t_ids.keep), 3,
  'and takes back the popularity it brought');
select throws_ok($$select public.catalog_unmerge((select merge_id from t_ids))$$, 'P0001', null,
  'a merge is undone once');

-- Two products the same shop lists separately are two products to that shop.
insert into public.catalog_listings (product_id, retailer_id, external_id, retailer_name, product_url)
select dropped, mega, 'M2', 'Mountain Dew 1L', 'https://www.mega-image.ro/p/m2' from t_ids;
select throws_ok($$select public.catalog_merge_products((select keep from t_ids), (select dropped from t_ids), 'cleanup')$$,
  'P0001', null, 'a shop listing both is a refusal');
select throws_ok($$select public.catalog_merge_products((select keep from t_ids), (select keep from t_ids), 'cleanup')$$,
  'P0001', null, 'a product is not merged into itself');

select ok(not has_function_privilege('authenticated', 'public.catalog_merge_products(uuid, uuid, text)', 'execute'),
  'a signed-in user cannot merge directly');
select ok(not has_function_privilege('authenticated', 'public.catalog_unmerge(uuid)', 'execute'),
  'nor undo one');

-- ─── the cleanup's groups ────────────────────────────────────────────────────
delete from public.catalog_listings;
delete from public.catalog_identifiers;
delete from public.catalog_products;

create temp table t_g (slug text, external_id text, product text, name text, brand text, qty numeric, unit text);
insert into t_g values
  -- one product in two wordings; the one two shops list is kept
  ('carrefour',  'G1', 'p1', 'Mountain Dew 1L',                         'Mountain Dew', 1,   'l'),
  ('auchan',     'G2', 'p2', 'Bautura carbogazoasa Mountain Dew, 1 l',  'Mountain Dew', 1,   'l'),
  ('penny',      'G3', 'p2', 'Bautura carbogazoasa Mountain Dew, 1 l',  'Mountain Dew', 1,   'l'),
  -- one shop listing both: ambiguous, never a group
  ('carrefour',  'G4', 'q1', 'Fanta Lamaie 0.5L',                       'Fanta',        0.5, 'l'),
  ('carrefour',  'G5', 'q2', 'Bautura carbogazoasa Fanta Lamaie, 0.5 l','Fanta',        0.5, 'l'),
  -- alone
  ('auchan',     'G6', 'r1', 'Pepsi 2L',                                'Pepsi',        2,   'l'),
  -- the name that says the brand is kept, even against more shops: it is the
  -- name both apps show
  ('mega-image', 'G7', 's1', 'Cascaval 240g',                           'Napolact',     240, 'g'),
  ('kaufland',   'G8', 's1', 'Cascaval 240g',                           'Napolact',     240, 'g'),
  ('auchan',     'G9', 's2', 'Cascaval Napolact, 240 g',                'Napolact',     240, 'g');

create temp table t_p as select product, gen_random_uuid() as id from (select distinct product from t_g) s;
insert into public.catalog_products (id, canonical_name, brand, quantity, quantity_unit)
select distinct on (p.id) p.id, g.name, g.brand, g.qty, g.unit from t_g g join t_p p using (product) order by p.id;
insert into public.catalog_listings (product_id, retailer_id, external_id, retailer_name, product_url)
select p.id, r.id, g.external_id, g.name, 'https://example.ro/' || g.external_id
  from t_g g join t_p p using (product) join public.catalog_retailers r on r.slug = g.slug;

select is((select count(*)::int from public.catalog_match_groups()), 2,
  'only a group no shop lists twice is offered');
select is((select product_ids from public.catalog_match_groups() where match_key like 'mountain dew%'),
          array[(select id from t_p where product = 'p2'), (select id from t_p where product = 'p1')],
  'the product more shops list is the one kept');
select is((select product_ids[1] from public.catalog_match_groups() where match_key like 'napolact%'),
          (select id from t_p where product = 's2'),
  'a name that says its brand beats one that does not');
select ok(not has_function_privilege('authenticated', 'public.catalog_match_groups()', 'execute'),
  'the cleanup is not a client function');

-- ─── the admin's Duplicates page ─────────────────────────────────────────────
-- Near misses: one brand, one size, one pack, more than one set of words, from
-- shops that do not list each other's. A person decides those.
delete from public.catalog_listings;
delete from public.catalog_products;
delete from public.catalog_admins;
delete from public.catalog_merge_rejections;

create temp table t_n (slug text, external_id text, product text, name text, brand text);
insert into t_n values
  ('carrefour',  'N1', 'a', 'Mountain Dew 1L',                             'Mountain Dew'),
  ('auchan',     'N2', 'b', 'Bautura carbogazoasa Mountain Dew, 1 l',      'Mountain Dew'),
  ('mega-image', 'N3', 'c', 'Bautura carbogazoasa cu gust de citrice 1L',  'Mountain Dew'),
  ('auchan',     'N4', 'd', 'Pepsi 1L',                                    'Pepsi');
create temp table t_np as select product, gen_random_uuid() as id from (select distinct product from t_n) s;
insert into public.catalog_products (id, canonical_name, brand, quantity, quantity_unit)
select p.id, n.name, n.brand, 1, 'l' from t_n n join t_np p using (product);
insert into public.catalog_listings (product_id, retailer_id, external_id, retailer_name, product_url)
select p.id, r.id, n.external_id, n.name, 'https://example.ro/' || n.external_id
  from t_n n join t_np p using (product) join public.catalog_retailers r on r.slug = n.slug;

-- Nobody: every door is locked.
select throws_ok($$select * from public.catalog_admin_near_duplicates()$$, '42501', null,
  'the candidates refuse a non-admin');
select throws_ok($$select public.catalog_admin_merge(gen_random_uuid(), gen_random_uuid())$$, '42501', null,
  'merge refuses a non-admin');
select throws_ok($$select public.catalog_admin_reject_group(array[gen_random_uuid(), gen_random_uuid()])$$, '42501', null,
  'reject refuses a non-admin');
select throws_ok($$select * from public.catalog_admin_merges()$$, '42501', null,
  'the merge history refuses a non-admin');
select throws_ok($$select public.catalog_admin_unmerge(gen_random_uuid())$$, '42501', null,
  'undo refuses a non-admin');

insert into public.catalog_admins (user_id) values ('admin-1');
set local request.jwt.claims = '{"sub":"admin-1"}';

select is((select count(*)::int from public.catalog_admin_near_duplicates()), 1,
  'the three Mountain Dew wordings are one candidate group, Pepsi none');
select is((select jsonb_array_length(products) from public.catalog_admin_near_duplicates()), 3,
  'with every product in it');

select public.catalog_admin_reject_group(array(select id from t_np where product in ('a', 'b', 'c')));
select is((select count(*)::int from public.catalog_admin_near_duplicates()), 0,
  'a group whose different pairs were all rejected is not asked again');

create temp table t_m as
select public.catalog_admin_merge((select id from t_np where product = 'a'), (select id from t_np where product = 'b')) as id;
select is((select source || ' ' || merged_by from public.catalog_admin_merges() m where m.id = (select id from t_m)),
  'admin admin-1', 'an admin merge is recorded as theirs');
select lives_ok($$select public.catalog_admin_unmerge((select id from t_m))$$,
  'and an admin can undo it');

-- What a person is shown, measured on the live catalog the day it opened
-- (2026-10-08): pairs with no word in common and pairs from two countries were
-- most of the 6,251 groups, and alphabetical order buried the real ones.
create temp table t_o (slug text, external_id text, product text, name text, brand text, qty numeric);
insert into t_o values
  ('kaufland', 'O1', 'e', 'Ciocolata cu alune Milka 100g',             'Milka', 100),
  ('lidl',     'O2', 'f', 'Ciocolata cu alune intregi Milka 100g',     'Milka', 100),
  -- no word in common with e or f
  ('penny',    'O3', 'g', 'Biscuiti Milka 100g',                       'Milka', 100),
  -- France: never offered against a Romanian shop
  ('aldi-fr',  'O4', 'h', 'Ciocolata alune noisettes Milka 100g',      'Milka', 100),
  ('kaufland', 'O5', 'i', 'Biscuiti Oreo cu crema de vanilie 154g',    'Oreo',  154),
  ('lidl',     'O6', 'j', 'Biscuiti Oreo original 154g',              'Oreo',  154);
create temp table t_op as select product, gen_random_uuid() as id from t_o;
insert into public.catalog_products (id, canonical_name, brand, quantity, quantity_unit)
select p.id, o.name, o.brand, o.qty, 'g' from t_o o join t_op p using (product);
insert into public.catalog_listings (product_id, retailer_id, external_id, retailer_name, product_url)
select p.id, r.id, o.external_id, o.name, 'https://example.ro/' || o.external_id
  from t_o o join t_op p using (product) join public.catalog_retailers r on r.slug = o.slug;

select is((select count(*)::int from public.catalog_admin_near_duplicates()), 2,
  'Oreo and Milka are candidates, the rejected Mountain Dew is not');
select is((select array(select x->>'id' from jsonb_array_elements(d.products) x order by 1)
             from public.catalog_admin_near_duplicates() d where d.family like 'milka%'),
          array(select id::text from t_op where product in ('e', 'f') order by 1),
  'a group shows only products paired in one country with a word in common');
select ok((select family from public.catalog_admin_near_duplicates() limit 1) like 'milka%',
  'the most alike pair comes first, not the smallest group');

-- ─── the guards review asked for (2026-10-08) ────────────────────────────────
reset request.jwt.claims;
delete from public.catalog_listings;
delete from public.catalog_identifiers;
delete from public.catalog_products;
delete from public.catalog_merge_rejections;
delete from public.catalog_product_merges;

create temp table t_q (slug text, external_id text, product text, name text, brand text, gtin text);
insert into t_q values
  ('auchan',    'Q1', 'g1', 'Apa Izvorul Alb 2L',      'Izvorul Alb', '5940000000011'),
  ('lidl',      'Q2', 'g2', 'Izvorul Alb Apa 2L',      'Izvorul Alb', '5940000000028'),
  ('carrefour', 'Q3', 'u1', 'Fanta Lamaie 2L',         'Fanta',       null),
  ('auchan',    'Q4', 'u2', 'Lamaie Fanta 2L',         'Fanta',       null),
  ('carrefour', 'Q5', 'r1', 'Sprite Lamaie 2L',        'Sprite',      null),
  ('auchan',    'Q6', 'r2', 'Lamaie Sprite 2L',        'Sprite',      null),
  ('carrefour', 'Q7', 'k1', 'Pepsi Max 2L',            'Pepsi',       null),
  ('auchan',    'Q8', 'k2', 'Max Pepsi 2L',            'Pepsi',       null),
  ('penny',     'Q9', 'k3', 'Bautura carbogazoasa Pepsi Max 2 l', 'Pepsi', null);
create temp table t_qp as select product, gen_random_uuid() as id from (select distinct product from t_q) s;
insert into public.catalog_products (id, canonical_name, brand, quantity, quantity_unit)
select p.id, q.name, q.brand, 2, 'l' from t_q q join t_qp p using (product);
insert into public.catalog_listings (product_id, retailer_id, external_id, retailer_name, product_url)
select p.id, r.id, q.external_id, q.name, 'https://example.ro/' || q.external_id
  from t_q q join t_qp p using (product) join public.catalog_retailers r on r.slug = q.slug;
insert into public.catalog_identifiers (product_id, identifier_value, source)
select p.id, q.gtin, q.slug from t_q q join t_qp p using (product) where q.gtin is not null;

create or replace function pg_temp.qid(p text) returns uuid language sql as $$ select id from t_qp where product = p $$;

select throws_ok($$select public.catalog_merge_products(pg_temp.qid('g1'), pg_temp.qid('g2'), 'admin')$$,
  'P0001', null, 'two products with different barcodes are never merged');

-- u1/u2: merged and undone by a person. r1/r2: rejected by a person.
create temp table t_qm as select public.catalog_merge_products(pg_temp.qid('u1'), pg_temp.qid('u2'), 'admin') as id;
select public.catalog_unmerge((select id from t_qm));
insert into public.catalog_merge_rejections (product_a, product_b)
values (least(pg_temp.qid('r1'), pg_temp.qid('r2')), greatest(pg_temp.qid('r1'), pg_temp.qid('r2')));

select is((select count(*)::int from public.catalog_match_groups() g
            where g.product_ids && array[pg_temp.qid('g1'), pg_temp.qid('u1'), pg_temp.qid('r1')]), 0,
  'the cleanup skips two barcodes, an undone merge and a rejected pair');

-- A chain: k2 into k1, then k1 into k3. Undoing the first would bring k2 back
-- with nothing, since its listing now sits on k3.
create temp table t_qc as
select public.catalog_merge_products(pg_temp.qid('k1'), pg_temp.qid('k2'), 'admin') as first;
select public.catalog_merge_products(pg_temp.qid('k3'), pg_temp.qid('k1'), 'admin');
select throws_like($$select public.catalog_unmerge((select first from t_qc))$$,
  '%merged again%', 'an undo whose listings moved on is refused, by name');

-- A product took the dropped one's exact name since: undo would collide.
create temp table t_qx as select public.catalog_merge_products(pg_temp.qid('u1'), pg_temp.qid('u2'), 'admin') as id;
insert into public.catalog_products (canonical_name, brand, quantity, quantity_unit) values ('Lamaie Fanta 2L', 'Fanta', 2, 'l');
select throws_like($$select public.catalog_unmerge((select id from t_qx))$$,
  '%same name%', 'an undo that would duplicate a product says so');

select * from finish();
rollback;
