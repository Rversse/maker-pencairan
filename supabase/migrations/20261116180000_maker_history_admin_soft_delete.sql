-- Maker Pencairan: admin-only HISTORY deletion marker.
-- Soft deletion hides the transaction while retaining its event trail for recovery/audit.

alter table public.maker_drafts
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.maker_profiles(user_id) on delete set null;

create index if not exists maker_drafts_active_history_idx
  on public.maker_drafts (kitchen_id, transaction_date, created_at desc)
  where deleted_at is null;

comment on column public.maker_drafts.deleted_at is
  'Maker HISTORY soft-delete timestamp; deleted transactions are hidden from normal HISTORY queries.';
comment on column public.maker_drafts.deleted_by is
  'Maker admin user who deleted the HISTORY transaction.';
