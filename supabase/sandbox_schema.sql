-- ============================================================
-- Innovation Sandbox: per-group decision tracking
-- Run once in the sandbox Supabase project (Dashboard → SQL Editor).
-- Separate from schema.sql, which is the production upskilling database.
--
-- The demo page is public, so the browser never touches these tables
-- directly. It can only call three functions:
--   sandbox_record     groups save their latest decisions (needs a live session code)
--   sandbox_results    facilitator reads a session (needs code + PIN)
--   sandbox_save_deck  facilitator saves edits to the results slides (needs code + PIN)
-- Sessions are created here in the SQL editor with sandbox_create_session.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- 1. SESSIONS: one per workshop
create table if not exists public.sandbox_sessions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                 -- what groups get in their link, e.g. NW-1104
  name text,                                 -- shown on the results slides
  pin_hash text not null,                    -- bcrypt hash of the facilitator PIN
  active boolean not null default true,      -- false stops new writes
  deck jsonb not null default '{}'::jsonb,   -- facilitator edits to the results slides
  created_at timestamptz not null default now()
);

-- 2. GROUPS: one per table/device within a session
create table if not exists public.sandbox_groups (
  id uuid primary key,                       -- generated in the browser, stable per device and session
  session_id uuid not null references public.sandbox_sessions(id) on delete cascade,
  table_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sandbox_groups_session_idx on public.sandbox_groups(session_id);

-- 3. DECISIONS: each group's latest answer per decision
create table if not exists public.sandbox_decisions (
  group_id uuid not null references public.sandbox_groups(id) on delete cascade,
  key text not null,                         -- e.g. stance, picks:p2, forward, build:u6, pilot:u6, pitch
  stage text not null,                       -- brief, stance, use-cases, prioritise, build, deploy, pitch
  choice jsonb,                              -- what they picked
  rationale text,                            -- why, in their words
  updated_at timestamptz not null default now(),
  primary key (group_id, key)
);

-- 4. DECISION LOG: every change, in order, for "how did their thinking move"
create table if not exists public.sandbox_decision_log (
  id bigserial primary key,
  group_id uuid not null references public.sandbox_groups(id) on delete cascade,
  key text not null,
  choice jsonb,
  rationale text,
  created_at timestamptz not null default now()
);
create index if not exists sandbox_log_group_idx on public.sandbox_decision_log(group_id, created_at);

-- No direct table access from the browser: RLS on, no policies, no grants.
alter table public.sandbox_sessions     enable row level security;
alter table public.sandbox_groups       enable row level security;
alter table public.sandbox_decisions    enable row level security;
alter table public.sandbox_decision_log enable row level security;
revoke all on public.sandbox_sessions, public.sandbox_groups, public.sandbox_decisions, public.sandbox_decision_log from anon, authenticated;

-- ------------------------------------------------------------
-- Groups save their decisions (called by the demo every few seconds while it changes)
-- ------------------------------------------------------------
create or replace function public.sandbox_record(p_code text, p_group uuid, p_table text, p_decisions jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session uuid;
  d jsonb;
begin
  if p_group is null or p_decisions is null or jsonb_typeof(p_decisions) <> 'array'
     or jsonb_array_length(p_decisions) > 40 or length(p_decisions::text) > 60000 then
    raise exception 'invalid payload';
  end if;

  select id into v_session from sandbox_sessions where code = upper(trim(p_code)) and active;
  if v_session is null then
    raise exception 'unknown or closed session';
  end if;

  insert into sandbox_groups (id, session_id, table_name)
  values (p_group, v_session, left(coalesce(p_table, ''), 60))
  on conflict (id) do update set table_name = excluded.table_name, updated_at = now()
  where sandbox_groups.session_id = v_session;
  if not found then
    raise exception 'group belongs to another session';
  end if;

  for d in select value from jsonb_array_elements(p_decisions) loop
    insert into sandbox_decisions (group_id, key, stage, choice, rationale)
    values (p_group, left(d->>'key', 60), left(coalesce(d->>'stage', ''), 30), d->'choice', left(d->>'rationale', 2000))
    on conflict (group_id, key) do update
      set stage = excluded.stage, choice = excluded.choice, rationale = excluded.rationale, updated_at = now()
      where (sandbox_decisions.choice, sandbox_decisions.rationale) is distinct from (excluded.choice, excluded.rationale);
    if found then
      insert into sandbox_decision_log (group_id, key, choice, rationale)
      values (p_group, left(d->>'key', 60), d->'choice', left(d->>'rationale', 2000));
    end if;
  end loop;
end;
$$;

-- ------------------------------------------------------------
-- Facilitator reads a whole session
-- ------------------------------------------------------------
create or replace function public.sandbox_check_pin(p_code text, p_pin text)
returns public.sandbox_sessions
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s sandbox_sessions;
begin
  select * into s from sandbox_sessions where code = upper(trim(p_code));
  if s.id is null or s.pin_hash <> crypt(coalesce(p_pin, ''), s.pin_hash) then
    perform pg_sleep(1);  -- slows down PIN guessing
    raise exception 'wrong session code or PIN';
  end if;
  return s;
end;
$$;

create or replace function public.sandbox_results(p_code text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s sandbox_sessions := sandbox_check_pin(p_code, p_pin);
begin
  return jsonb_build_object(
    'session', jsonb_build_object('code', s.code, 'name', s.name, 'deck', s.deck),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', g.id,
        'table', g.table_name,
        'updated_at', g.updated_at,
        'decisions', coalesce((
          select jsonb_object_agg(d.key, jsonb_build_object(
            'stage', d.stage, 'choice', d.choice, 'rationale', d.rationale, 'updated_at', d.updated_at))
          from sandbox_decisions d where d.group_id = g.id), '{}'::jsonb)
      ) order by g.created_at)
      from sandbox_groups g where g.session_id = s.id), '[]'::jsonb)
  );
end;
$$;

-- ------------------------------------------------------------
-- Facilitator saves edits to the results slides
-- ------------------------------------------------------------
create or replace function public.sandbox_save_deck(p_code text, p_pin text, p_deck jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s sandbox_sessions := sandbox_check_pin(p_code, p_pin);
begin
  if p_deck is null or jsonb_typeof(p_deck) <> 'object' or length(p_deck::text) > 100000 then
    raise exception 'invalid deck';
  end if;
  update sandbox_sessions set deck = p_deck where id = s.id;
end;
$$;

-- ------------------------------------------------------------
-- Create a session (run here in the SQL editor, never from the page)
--   select sandbox_create_session('NW-1104', 'NordWeave · 4 November', '482913');
-- Close one to stop new writes:
--   update sandbox_sessions set active = false where code = 'NW-1104';
-- ------------------------------------------------------------
create or replace function public.sandbox_create_session(p_code text, p_name text, p_pin text)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  insert into sandbox_sessions (code, name, pin_hash)
  values (upper(trim(p_code)), p_name, crypt(p_pin, gen_salt('bf')));
$$;

-- Who may call what
revoke all on function public.sandbox_record(text, uuid, text, jsonb)  from public;
revoke all on function public.sandbox_check_pin(text, text)            from public, anon, authenticated;
revoke all on function public.sandbox_results(text, text)              from public;
revoke all on function public.sandbox_save_deck(text, text, jsonb)     from public;
revoke all on function public.sandbox_create_session(text, text, text) from public, anon, authenticated;
grant execute on function public.sandbox_record(text, uuid, text, jsonb) to anon, authenticated;
grant execute on function public.sandbox_results(text, text)             to anon, authenticated;
grant execute on function public.sandbox_save_deck(text, text, jsonb)    to anon, authenticated;
