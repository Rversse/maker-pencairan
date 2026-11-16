-- Atomic write operations for Maker HISTORY.
-- All functions are private to Maker and callable only by service_role from the
-- maker-history Edge Function after its custom session/role/assignment checks.

create or replace function public.maker_history_create_atomic(
  p_kitchen_id uuid,
  p_actor_user_id uuid,
  p_title text,
  p_transaction_date date,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft public.maker_drafts%rowtype;
begin
  insert into public.maker_drafts (
    kitchen_id, created_by, title, status, payload, transaction_date,
    version, last_event_at
  ) values (
    p_kitchen_id, p_actor_user_id, nullif(left(coalesce(p_title, ''), 160), ''),
    'ready', p_payload, p_transaction_date, 1, now()
  )
  returning * into v_draft;

  insert into public.maker_history (
    kitchen_id, actor_user_id, draft_id, event_type, summary, snapshot
  ) values (
    p_kitchen_id, p_actor_user_id, v_draft.id, 'NORMAL', 'Pencairan awal',
    jsonb_build_object('version', 1, 'payload', p_payload)
  );

  return jsonb_build_object('ok', true, 'history', to_jsonb(v_draft));
end;
$$;

create or replace function public.maker_history_change_atomic(
  p_draft_id uuid,
  p_actor_user_id uuid,
  p_expected_version integer,
  p_event_type text,
  p_summary text,
  p_delta jsonb,
  p_next_snapshot jsonb,
  p_is_admin boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft public.maker_drafts%rowtype;
  v_next_version integer;
begin
  if p_event_type not in ('REVISI', 'KEKURANGAN', 'TAMBAHAN') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_event_type');
  end if;

  select * into v_draft
  from public.maker_drafts
  where id = p_draft_id and deleted_at is null
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_draft.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'reason', 'version_conflict', 'current_version', v_draft.version);
  end if;

  if not coalesce(p_is_admin, false)
     and now() >= v_draft.created_at + interval '24 hours' then
    return jsonb_build_object('ok', false, 'reason', 'locked');
  end if;

  v_next_version := v_draft.version + 1;

  insert into public.maker_history (
    kitchen_id, actor_user_id, draft_id, event_type, summary, snapshot
  ) values (
    v_draft.kitchen_id, p_actor_user_id, v_draft.id, p_event_type,
    nullif(left(coalesce(p_summary, ''), 240), ''),
    jsonb_build_object('version', v_next_version, 'delta', p_delta, 'payload', p_next_snapshot)
  );

  update public.maker_drafts
  set payload = p_next_snapshot,
      version = v_next_version,
      last_event_at = now(),
      updated_at = now()
  where id = v_draft.id
  returning * into v_draft;

  return jsonb_build_object('ok', true, 'history', to_jsonb(v_draft));
end;
$$;

revoke all on function public.maker_history_create_atomic(uuid, uuid, text, date, jsonb) from public, anon, authenticated;
revoke all on function public.maker_history_change_atomic(uuid, uuid, integer, text, text, jsonb, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.maker_history_create_atomic(uuid, uuid, text, date, jsonb) to service_role;
grant execute on function public.maker_history_change_atomic(uuid, uuid, integer, text, text, jsonb, jsonb, boolean) to service_role;
