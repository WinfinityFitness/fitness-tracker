-- Follow-up to supabase_showcase_autoshow_and_philippines_migration.sql --
-- that migration correctly set location='Philippines' only for demo users
-- whose Digital ID doesn't contain "DEMO", but ~25 of the WF-DEMO### users
-- already happened to be randomly assigned Philippines from the original
-- seed (out of a 20-country pool). This reassigns just those to a
-- different random country, so Philippines ends up exclusive to the
-- non-DEMO-labeled group as intended -- doesn't touch anyone else.

update showcase_demo_users
set location = (array['United States','Japan','Brazil','Germany','India','Australia','Canada',
  'South Korea','United Kingdom','Mexico','Nigeria','Sweden','Italy','South Africa',
  'Indonesia','France','Vietnam','Spain','Kenya'])[1 + floor(random() * 19)::int]
where public_id like 'WF-DEMO%'
  and location = 'Philippines';
