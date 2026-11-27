alter table public.maker_ops_real
  add column if not exists note text;

-- Existing rows remain intact; the requirement is enforced for new and updated rows.
alter table public.maker_ops_real
  add constraint maker_ops_real_note_required
  check (note is not null and length(btrim(note)) > 0)
  not valid;
