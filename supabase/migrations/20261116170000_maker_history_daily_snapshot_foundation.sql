-- Maker Pencairan HISTORY foundation.
-- This migration belongs exclusively to the Maker Pencairan repository.
-- It uses Maker-private tables in the shared Supabase project; it does not alter SIM-SPPG tables.

alter table public.maker_drafts
  add column if not exists transaction_date date,
  add column if not exists version integer not null default 1,
  add column if not exists last_event_at timestamptz;

create unique index if not exists maker_drafts_kitchen_transaction_date_uidx
  on public.maker_drafts (kitchen_id, transaction_date)
  where transaction_date is not null;

create index if not exists maker_drafts_kitchen_created_at_idx
  on public.maker_drafts (kitchen_id, created_at desc);

create index if not exists maker_history_draft_created_at_idx
  on public.maker_history (draft_id, created_at asc);

create index if not exists maker_history_kitchen_created_at_idx
  on public.maker_history (kitchen_id, created_at desc);

-- The 24-hour lock deadline is derived from immutable initial created_at:
-- created_at + interval '24 hours'. Revisions and copies must not reset it.
comment on column public.maker_drafts.created_at is
  'Maker HISTORY lock start; lock deadline is created_at + 24 hours and is never reset.';
comment on column public.maker_drafts.payload is
  'Latest canonical Maker daily snapshot. Incremental changes are separately recorded in maker_history.';
comment on column public.maker_drafts.version is
  'Monotonically increasing Maker HISTORY snapshot version.';
comment on column public.maker_drafts.transaction_date is
  'Local transaction date for this Maker kitchen HISTORY; unique per kitchen/date.';
