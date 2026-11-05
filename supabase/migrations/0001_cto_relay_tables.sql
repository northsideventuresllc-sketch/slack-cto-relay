-- 0001_cto_relay_tables.sql
-- Slack CTO Loop relay — the two brain tables missing from NI Brain
-- (Supabase project uaztknnipdxxptrmlxlb, public schema).
--
-- Source of truth:
--   RUNBOOK.md, Phase 1 verification: cto_relay_lease and cto_heartbeat do NOT
--     exist in the public schema; Phase 2 creates both before the relay code.
--   PLAN-v7.md D4 (manual state machine): cto_heartbeat (agent, heartbeat_at).
--   PLAN-v7.md D6 + Contracts + Glossary: cto_relay_lease is a timed hold on a
--     name, with an epoch (fencing token) that goes up by one on every
--     acquisition/failover; lease 90 s, heartbeat 30 s.
--
-- agent_comms already exists and is NOT touched by this migration.
--
-- Run by JB in the Supabase SQL editor. Idempotent: safe to run twice.

begin;

-- ---------------------------------------------------------------------------
-- cto_heartbeat — Muse CTO's liveness row.
-- Written every 15 minutes by the VM cron `cto-heartbeat` (agent = 'MUSE').
-- Muse CTO is offline when its row is older than 30 minutes (detection);
-- the mini poller alerts at 45 minutes.
-- Columns exactly as PLAN-v7.md D4 / Appendix D: (agent, heartbeat_at).
-- ---------------------------------------------------------------------------
create table if not exists public.cto_heartbeat (
  agent        text        not null,
  heartbeat_at timestamptz not null default now(),
  constraint cto_heartbeat_pkey primary key (agent),
  constraint cto_heartbeat_agent_not_blank check (length(btrim(agent)) > 0)
);

comment on table  public.cto_heartbeat is
  'Slack CTO Loop: one liveness row per agent. Written by the cto-heartbeat cron every 15 min. Offline = older than 30 min.';
comment on column public.cto_heartbeat.agent is
  'Agent name, same casing as agent_comms.to_agent (e.g. MUSE).';
comment on column public.cto_heartbeat.heartbeat_at is
  'Time of the last heartbeat write.';

-- ---------------------------------------------------------------------------
-- cto_relay_lease — one lease row per relay program (per CTO).
-- A program acquires the lease with epoch+1 before starting; every fire and
-- every post first checks its epoch against this row (a stale epoch is
-- refused). Lease lasts 90 s; the holder heartbeats every 30 s by pushing
-- expires_at forward with a conditional update on (name, epoch).
--
-- NOTE: PLAN-v7.md names the table, the epoch/fencing token, the holder and
-- the 90 s / 30 s timings, but does not list columns. The columns below are
-- the minimum those rules need: name (the held name), epoch, holder,
-- acquired_at, heartbeat_at, expires_at. Flagged for COUNCIL GATE review.
-- ---------------------------------------------------------------------------
create table if not exists public.cto_relay_lease (
  name         text        not null,
  epoch        bigint      not null,
  holder       text        not null,
  acquired_at  timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  constraint cto_relay_lease_pkey primary key (name),
  constraint cto_relay_lease_name_known
    check (name in ('muse', 'claude', 'gemini', 'axon-hermes')),
  constraint cto_relay_lease_epoch_positive check (epoch >= 1),
  constraint cto_relay_lease_holder_not_blank check (length(btrim(holder)) > 0),
  constraint cto_relay_lease_expiry_after_heartbeat check (expires_at >= heartbeat_at)
);

comment on table  public.cto_relay_lease is
  'Slack CTO Loop: one lease per relay program. 90 s lease, 30 s heartbeat. epoch is the fencing token, +1 on every acquisition.';
comment on column public.cto_relay_lease.name is
  'The held name: the CTO this relay program serves (muse, claude, gemini, axon-hermes).';
comment on column public.cto_relay_lease.epoch is
  'Fencing token. Goes up by one on every acquisition/failover. A fire or post carrying an older epoch is refused.';
comment on column public.cto_relay_lease.holder is
  'Who holds the lease now: host + program identity (e.g. vm:cto-relay-muse, mini:cto-relay-muse).';
comment on column public.cto_relay_lease.acquired_at is
  'When the current epoch was acquired.';
comment on column public.cto_relay_lease.heartbeat_at is
  'Last successful lease heartbeat (every 30 s).';
comment on column public.cto_relay_lease.expires_at is
  'Lease expiry (heartbeat_at + 90 s). Past this, another holder may acquire with epoch+1.';

-- ---------------------------------------------------------------------------
-- Access: RLS on, no policies. The publishable/anon key and signed-in users
-- get nothing. The relay uses the project secret key (stored in the Secure
-- Vault under cto-relay-muse), which bypasses RLS by design (RUNBOOK Phase 1
-- deviation: the key is project-wide; the relay code touches only
-- agent_comms, cto_relay_lease and cto_heartbeat).
-- ---------------------------------------------------------------------------
alter table public.cto_heartbeat   enable row level security;
alter table public.cto_relay_lease enable row level security;

revoke all on table public.cto_heartbeat   from anon, authenticated;
revoke all on table public.cto_relay_lease from anon, authenticated;

grant select, insert, update on table public.cto_heartbeat   to service_role;
grant select, insert, update on table public.cto_relay_lease to service_role;

commit;

-- ---------------------------------------------------------------------------
-- Verify (run after the migration; read-only):
--   select table_name, column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name in ('cto_heartbeat', 'cto_relay_lease')
--    order by table_name, ordinal_position;
--   select relname, relrowsecurity
--     from pg_class
--    where relname in ('cto_heartbeat', 'cto_relay_lease');
-- ---------------------------------------------------------------------------
