-- NagaGuno Migration 002: RLS Enforcement for a Custom-JWT Backend
-- Database: PostgreSQL 15+ (Supabase)
-- Run: psql -U postgres -d nagaguno_db -f 002_rls_enforcement.sql
--
-- CONTEXT: this app uses its own JWT auth, not Supabase Auth, so
-- auth.uid() is never populated -- RLS policies written around it are
-- silently inert. This migration:
--   1. adds two helper functions that read per-request session context
--      the app sets via SET LOCAL (the custom-JWT equivalent of auth.uid())
--   2. creates a dedicated, non-superuser `app_backend` role that RLS
--      actually applies to (the default `postgres`/service_role connection
--      bypasses RLS unconditionally, regardless of policy correctness)
--   3. writes/rewrites RLS policies for every table this app's backend
--      routes were migrated to query through that role
--
-- REQUIRED MANUAL STEP AFTER RUNNING THIS FILE:
--   ALTER ROLE app_backend WITH PASSWORD '<a real, strong password>';
--   Then set APP_BACKEND_DATABASE_URL in .env -- same format as
--   DATABASE_URL, with app_backend as the user instead of postgres.
--   The placeholder password below MUST be changed before this role is
--   usable in any real environment.

-- ============================================================
-- SESSION-CONTEXT HELPER FUNCTIONS
-- ============================================================

create or replace function app_current_user_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

create or replace function app_current_user_role()
returns text
language sql
stable
as $$
  select nullif(current_setting('app.current_user_role', true), '')
$$;

-- ============================================================
-- RESTRICTED ROLE
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_backend') then
    create role app_backend with login password 'CHANGE_ME_BEFORE_PRODUCTION' noSuperuser noBypassRLS;
  end if;
end
$$;

grant connect on database postgres to app_backend;
grant usage on schema public to app_backend;
grant select, insert, update, delete on all tables in schema public to app_backend;
grant usage, select on all sequences in schema public to app_backend;
alter default privileges in schema public grant select, insert, update, delete on tables to app_backend;
alter default privileges in schema public grant usage, select on sequences to app_backend;

-- ============================================================
-- USERS
-- ============================================================

drop policy if exists "users_select_own_or_admin" on users;
create policy "users_select_own_or_admin" on users for select
  using (id = app_current_user_id() or app_current_user_role() = 'admin');

-- Any active account with a real live listing is visible to marketplace
-- browsers -- deliberately NOT hardcoded to role IN ('farmer','vendor'):
-- an admin-role account with a live listing (e.g. seed/test data) must
-- still be visible, since the real condition is "has a live listing,"
-- not "role tag says farmer/vendor." Caught via live testing, not review.
drop policy if exists "users_select_public_active_sellers" on users;
create policy "users_select_public_active_sellers" on users for select
  using (
    account_status = 'active'
    and exists (select 1 from products p where p.seller_id = users.id and p.status = 'live')
  );

-- A user is visible to their counterparty on any shared order or
-- agreement, regardless of role -- without this, a seller can't see
-- their own buyer's name (or vice versa) unless the buyer happens to
-- also be an active farmer/vendor. Also caught via live testing.
drop policy if exists "users_select_transaction_counterparty" on users;
create policy "users_select_transaction_counterparty" on users for select
  using (
    exists (
      select 1 from orders o
      where (o.buyer_id = users.id and o.seller_id = app_current_user_id())
         or (o.seller_id = users.id and o.buyer_id = app_current_user_id())
    )
    or exists (
      select 1 from agreements a
      where (a.buyer_id = users.id and a.seller_id = app_current_user_id())
         or (a.seller_id = users.id and a.buyer_id = app_current_user_id())
    )
  );

drop policy if exists "users_update_own_or_admin" on users;
create policy "users_update_own_or_admin" on users for update
  using (id = app_current_user_id() or app_current_user_role() = 'admin');

-- Registration happens before any session context exists (no user yet).
-- Real protection here is the rate limiter + Joi validation upstream,
-- not RLS -- this INSERT deliberately has no ownership condition.
drop policy if exists "users_insert_registration" on users;
create policy "users_insert_registration" on users for insert
  with check (true);

-- ============================================================
-- ORDERS / ORDER_ITEMS
-- ============================================================

drop policy if exists "orders_select_participant_or_admin" on orders;
create policy "orders_select_participant_or_admin" on orders for select
  using (buyer_id = app_current_user_id() or seller_id = app_current_user_id() or app_current_user_role() = 'admin');

drop policy if exists "orders_insert_own_as_buyer" on orders;
create policy "orders_insert_own_as_buyer" on orders for insert
  with check (buyer_id = app_current_user_id());

drop policy if exists "orders_update_participant_or_admin" on orders;
create policy "orders_update_participant_or_admin" on orders for update
  using (buyer_id = app_current_user_id() or seller_id = app_current_user_id() or app_current_user_role() = 'admin');

drop policy if exists "order_items_via_order" on order_items;
create policy "order_items_via_order" on order_items for all
  using (exists (
    select 1 from orders o where o.id = order_items.order_id
    and (o.buyer_id = app_current_user_id() or o.seller_id = app_current_user_id() or app_current_user_role() = 'admin')
  ));

-- ============================================================
-- AGREEMENTS
-- ============================================================

drop policy if exists "agreements_select_participant_or_admin" on agreements;
create policy "agreements_select_participant_or_admin" on agreements for select
  using (buyer_id = app_current_user_id() or seller_id = app_current_user_id() or app_current_user_role() = 'admin');

drop policy if exists "agreements_insert_own_as_buyer" on agreements;
create policy "agreements_insert_own_as_buyer" on agreements for insert
  with check (buyer_id = app_current_user_id());

drop policy if exists "agreements_update_participant_or_admin" on agreements;
create policy "agreements_update_participant_or_admin" on agreements for update
  using (buyer_id = app_current_user_id() or seller_id = app_current_user_id() or app_current_user_role() = 'admin');

-- ============================================================
-- PRODUCTS
-- ============================================================

drop policy if exists "products_select_open" on products;
create policy "products_select_open" on products for select
  using (status != 'deleted' or seller_id = app_current_user_id() or app_current_user_role() = 'admin');

drop policy if exists "products_insert_own" on products;
create policy "products_insert_own" on products for insert
  with check (seller_id = app_current_user_id());

drop policy if exists "products_update_own_or_admin" on products;
create policy "products_update_own_or_admin" on products for update
  using (seller_id = app_current_user_id() or app_current_user_role() = 'admin');

drop policy if exists "products_delete_own_or_admin" on products;
create policy "products_delete_own_or_admin" on products for delete
  using (seller_id = app_current_user_id() or app_current_user_role() = 'admin');

-- ============================================================
-- CROP PLANS / NOTIFICATIONS / SAVED FARMERS
-- ============================================================

drop policy if exists "crop_plans_owner_or_admin" on crop_plans;
create policy "crop_plans_owner_or_admin" on crop_plans for all
  using (farmer_id = app_current_user_id() or app_current_user_role() = 'admin');

-- NOTE: notifications remain own-user-only (user_id = own). This does NOT
-- yet support inserting a notification FOR another user (e.g. a seller
-- notifying a buyer on order confirmation) -- that write path is
-- deliberately still on the privileged connection app-side. See
-- INTEGRATION_NOTES.md for why this needs its own dedicated policy
-- design rather than a rushed broadening.
drop policy if exists "notifications_own" on notifications;
create policy "notifications_own" on notifications for all
  using (user_id = app_current_user_id());

drop policy if exists "saved_farmers_own" on saved_farmers;
create policy "saved_farmers_own" on saved_farmers for all
  using (buyer_id = app_current_user_id());

-- ============================================================
-- PROFILE TABLES
-- ============================================================

drop policy if exists "buyer_profiles_own_or_admin" on buyer_profiles;
create policy "buyer_profiles_own_or_admin" on buyer_profiles for all
  using (user_id = app_current_user_id() or app_current_user_role() = 'admin');

drop policy if exists "farmer_profiles_own_or_admin" on farmer_profiles;
create policy "farmer_profiles_own_or_admin" on farmer_profiles for all
  using (user_id = app_current_user_id() or app_current_user_role() = 'admin');

drop policy if exists "farmer_profiles_select_public_active" on farmer_profiles;
create policy "farmer_profiles_select_public_active" on farmer_profiles for select
  using (exists (
    select 1 from users u where u.id = farmer_profiles.user_id
    and u.role = 'farmer' and u.account_status = 'active'
  ));

drop policy if exists "vendor_profiles_own_or_admin" on vendor_profiles;
create policy "vendor_profiles_own_or_admin" on vendor_profiles for all
  using (user_id = app_current_user_id() or app_current_user_role() = 'admin');

drop policy if exists "vendor_profiles_select_public_active" on vendor_profiles;
create policy "vendor_profiles_select_public_active" on vendor_profiles for select
  using (exists (
    select 1 from users u where u.id = vendor_profiles.user_id
    and u.role = 'vendor' and u.account_status = 'active'
  ));

-- ============================================================
-- KYC SUBMISSIONS (rewritten from dead auth.uid()-based policies)
-- ============================================================

drop policy if exists "Users can insert their own KYC submission" on kyc_submissions;
drop policy if exists "Users can view their own KYC submission" on kyc_submissions;
drop policy if exists "Admins can view all KYC submissions" on kyc_submissions;
drop policy if exists "Users can update their own pending/rejected KYC submission" on kyc_submissions;
drop policy if exists "Admins can update any KYC submission" on kyc_submissions;
drop policy if exists "kyc_insert_own" on kyc_submissions;
drop policy if exists "kyc_select_own_or_admin" on kyc_submissions;
drop policy if exists "kyc_update_own_pending_or_admin" on kyc_submissions;

create policy "kyc_insert_own" on kyc_submissions for insert
  with check (user_id = app_current_user_id());

create policy "kyc_select_own_or_admin" on kyc_submissions for select
  using (user_id = app_current_user_id() or app_current_user_role() = 'admin');

create policy "kyc_update_own_pending_or_admin" on kyc_submissions for update
  using (
    (user_id = app_current_user_id() and status in ('pending', 'rejected'))
    or app_current_user_role() = 'admin'
  );

-- ============================================================
-- SPOILAGE TABLES (rewritten from dead auth.uid()-based policies)
-- ============================================================

drop policy if exists "Admins view all spoilage recommendations" on spoilage_price_recommendations;
drop policy if exists "Sellers respond to recommendations for their own products" on spoilage_price_recommendations;
drop policy if exists "Sellers view recommendations for their own products" on spoilage_price_recommendations;
drop policy if exists "spoilage_rec_seller_or_admin" on spoilage_price_recommendations;
drop policy if exists "spoilage_rec_public_when_accepted" on spoilage_price_recommendations;

create policy "spoilage_rec_seller_or_admin" on spoilage_price_recommendations for all
  using (
    exists (select 1 from products p where p.id = spoilage_price_recommendations.product_id and p.seller_id = app_current_user_id())
    or app_current_user_role() = 'admin'
  );

-- Accepted (live) flash-sale recommendations are visible to ANY buyer
-- browsing the marketplace, not just the seller -- that's the whole
-- point of showing a discounted price publicly. Non-accepted
-- (suggested/dismissed) recommendations stay seller-or-admin-only via
-- the policy above.
create policy "spoilage_rec_public_when_accepted" on spoilage_price_recommendations for select
  using (status = 'accepted');

drop policy if exists "Admins manage category shelf-life defaults" on spoilage_category_defaults;
drop policy if exists "spoilage_defaults_admin_manage" on spoilage_category_defaults;
create policy "spoilage_defaults_admin_manage" on spoilage_category_defaults for all
  using (app_current_user_role() = 'admin');

-- Pre-existing policy (not created by this migration, but documented
-- here for completeness/reproducibility -- it predates this session's
-- work and was found already live when this migration was written).
drop policy if exists "Anyone can read category shelf-life defaults" on spoilage_category_defaults;
create policy "Anyone can read category shelf-life defaults" on spoilage_category_defaults for select
  using (true);

-- NOTE: product_spoilage_status is a VIEW (not a table), owned by
-- postgres, so it bypasses RLS regardless of which role queries it.
-- This is acceptable as-is: spoilage stage is meant to be public
-- marketplace info. No policy needed/possible on a view like this.
