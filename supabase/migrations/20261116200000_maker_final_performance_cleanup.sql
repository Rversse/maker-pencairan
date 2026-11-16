-- Maker-only final performance cleanup.
-- Add covering indexes for Maker foreign keys reported by Supabase Advisor.
-- Remove one exactly duplicate Maker HISTORY index; retain the *_at index.

create index if not exists maker_assignments_assigned_by_idx
  on public.maker_assignments (assigned_by);

create index if not exists maker_drafts_deleted_by_idx
  on public.maker_drafts (deleted_by);

create index if not exists maker_kitchen_login_locks_unlocked_by_idx
  on public.maker_kitchen_login_locks (unlocked_by);

create index if not exists maker_settings_updated_by_idx
  on public.maker_settings (updated_by);

drop index if exists public.maker_history_kitchen_created_idx;
