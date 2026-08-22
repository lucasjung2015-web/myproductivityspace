-- Schema for myProductivitySpace cloud sync.
-- No migration tooling in this project; kept in the repo as the record of
-- what was run. Apply in the Supabase SQL editor, in this order.

-- ---------------------------------------------------------------------------
-- 1. The mirror table
-- ---------------------------------------------------------------------------
-- One row per (user, storage key). Every value the app persists is already a
-- JSON string by the time it reaches storageSet, and both documents funnel
-- through that one seam, so this mirrors the entire dashboard without a
-- schema that has to know what a "widget" or a "task" is. A new widget type
-- inventing a new key needs no migration here.

create table if not exists public.kv (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  key        text        not null,
  value      text        not null,
  updated_at timestamptz not null default now(),
  writer     text,          -- which browser wrote it last; lets a client skip
                            -- re-pulling its own writes on a warm refresh
  primary key (user_id, key)
);

create index if not exists kv_user_updated_idx on public.kv (user_id, updated_at desc);

-- Server clock is authoritative. Never trust a client timestamp for this:
-- two people on two laptops have two different wall clocks.
create or replace function public.kv_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists kv_touch_trg on public.kv;
create trigger kv_touch_trg
  before insert or update on public.kv
  for each row execute function public.kv_touch();

-- ---------------------------------------------------------------------------
-- 2. Row Level Security
-- ---------------------------------------------------------------------------
-- `to authenticated` is load-bearing: the anon role — which the published
-- anon key uses before sign-in — then has no policy at all, and therefore no
-- access. That is *why* shipping the anon key in the HTML is safe.
--
-- Insert and update are separate policies rather than one `for all`. The
-- client writes via upsert, which needs WITH CHECK on the insert half and
-- both USING and WITH CHECK on the update half; a `for all` policy carrying
-- only USING silently rejects the insert.

alter table public.kv enable row level security;

drop policy if exists kv_select on public.kv;
create policy kv_select on public.kv for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists kv_insert on public.kv;
create policy kv_insert on public.kv for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists kv_update on public.kv;
create policy kv_update on public.kv for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists kv_delete on public.kv;
create policy kv_delete on public.kv for delete to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. Invite-only
-- ---------------------------------------------------------------------------
-- Third of three layers. The other two are console settings: the Google
-- consent screen in Testing mode with each invitee as a Test user (which also
-- keeps the sensitive calendar/tasks scopes usable without Google app
-- verification), and Email auth disabled so no password path exists.
--
-- This one is the durable layer, because it survives someone changing a
-- console setting.

create table if not exists public.allowed_emails (
  email      text primary key,
  note       text,
  created_at timestamptz not null default now()
);

-- RLS on with ZERO policies: no anon or authenticated access whatsoever.
-- Only service_role and SECURITY DEFINER functions can read it.
alter table public.allowed_emails enable row level security;

insert into public.allowed_emails (email, note)
values ('lucasjung2015@gmail.com', 'owner')
on conflict (email) do nothing;

create or replace function public.enforce_invite_allowlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.allowed_emails a
    where lower(a.email) = lower(new.email)
  ) then
    raise exception 'not_invited'
      using errcode = 'P0001',
            hint = 'This email has not been invited to myProductivitySpace.';
  end if;
  return new;
end $$;

-- BEFORE INSERT only, so existing invitees keep signing in normally; only
-- account *creation* is gated.
--
-- Adding someone:  insert into public.allowed_emails values ('them@gmail.com', 'note');
-- Revoking:        delete from auth.users where email = 'them@gmail.com';
--                  delete from public.allowed_emails where email = 'them@gmail.com';
-- The on delete cascade on kv.user_id takes their board with them.

drop trigger if exists enforce_invite_allowlist_trg on auth.users;
create trigger enforce_invite_allowlist_trg
  before insert on auth.users
  for each row execute function public.enforce_invite_allowlist();

-- ---------------------------------------------------------------------------
-- 4. Google refresh tokens (server-side only)
-- ---------------------------------------------------------------------------
-- Supabase hands over Google's provider_token only on the OAuth callback and
-- never persists it, so Calendar/Tasks access died with the browser tab while
-- the board's own session lived on. GIS's silent re-mint was meant to cover
-- that gap and does not reliably: Chrome's third-party-cookie restrictions
-- make it succeed sometimes and fail others regardless of how long it is
-- given. The durable answer is Google's refresh token -- but redeeming one
-- needs the OAuth client SECRET, which must never reach the browser.
--
-- So the token lives here and is redeemed by the google-token Edge Function.
-- RLS is enabled with ZERO policies, which means neither `anon` nor
-- `authenticated` can read, write, or even detect a row: the only key that
-- reaches this table is service_role, which exists solely inside the
-- function. The browser hands its refresh token over once at sign-in and can
-- never read it back -- it only ever asks for a short-lived access token.

create table if not exists public.google_tokens (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  refresh_token text        not null,
  updated_at    timestamptz not null default now()
);

alter table public.google_tokens enable row level security;
-- Deliberately no policies. Do not add any.

drop trigger if exists google_tokens_touch_trg on public.google_tokens;
create trigger google_tokens_touch_trg
  before insert or update on public.google_tokens
  for each row execute function public.kv_touch();

-- ---------------------------------------------------------------------------
-- 5. Notion connections (server-side only)
-- ---------------------------------------------------------------------------
-- Same shape and same reasoning as google_tokens. A Notion access token is
-- full read/write over every page the user granted, and Notion's API cannot
-- be called from a browser anyway, so the token is handed to the `notion`
-- Edge Function once at connect time and never comes back out. RLS on with
-- ZERO policies: service_role only.
--
-- workspace_name / workspace_icon are shown in the Connections row so the
-- user can see WHICH workspace is linked without the client ever holding a
-- credential. bot_id identifies the integration install, which is what
-- Notion's token-revoked errors key off.

create table if not exists public.notion_tokens (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  access_token   text        not null,
  bot_id         text,
  workspace_id   text,
  workspace_name text,
  workspace_icon text,
  updated_at     timestamptz not null default now()
);

alter table public.notion_tokens enable row level security;
-- Deliberately no policies. Do not add any.

drop trigger if exists notion_tokens_touch_trg on public.notion_tokens;
create trigger notion_tokens_touch_trg
  before insert or update on public.notion_tokens
  for each row execute function public.kv_touch();

-- Which local Page widget maps to which Notion page, and what we last saw
-- from each side. This one IS readable by its owner: it holds no credential,
-- and the client needs it on every sync tick to decide direction.
create table if not exists public.notion_pages (
  user_id            uuid        not null references auth.users(id) on delete cascade,
  local_key          text        not null,   -- e.g. "note-content:page1786..."
  notion_page_id     text        not null,
  -- Notion's own last_edited_time as of our last pull. A newer value means
  -- Notion has changes we have not seen.
  notion_last_edited timestamptz,
  -- Hash of the HTML we last pushed, so an unchanged local page does not
  -- burn a write against the 3 req/sec budget on every tick.
  pushed_hash        text,
  updated_at         timestamptz not null default now(),
  primary key (user_id, local_key)
);

create index if not exists notion_pages_user_idx on public.notion_pages (user_id);

alter table public.notion_pages enable row level security;

drop policy if exists notion_pages_select on public.notion_pages;
create policy notion_pages_select on public.notion_pages for select to authenticated
  using (auth.uid() = user_id);
drop policy if exists notion_pages_insert on public.notion_pages;
create policy notion_pages_insert on public.notion_pages for insert to authenticated
  with check (auth.uid() = user_id);
drop policy if exists notion_pages_update on public.notion_pages;
create policy notion_pages_update on public.notion_pages for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists notion_pages_delete on public.notion_pages;
create policy notion_pages_delete on public.notion_pages for delete to authenticated
  using (auth.uid() = user_id);

drop trigger if exists notion_pages_touch_trg on public.notion_pages;
create trigger notion_pages_touch_trg
  before insert or update on public.notion_pages
  for each row execute function public.kv_touch();
