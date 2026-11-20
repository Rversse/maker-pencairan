-- Admin-only atomic import/replace for Maker daily snapshots.
-- Old snapshots are soft-deleted; their maker_history events remain as audit evidence.
create or replace function public.maker_history_import_atomic(
  p_actor_user_id uuid,
  p_mode text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_item jsonb;
  v_kitchen_id uuid;
  v_transaction_date date;
  v_title text;
  v_payload jsonb;
  v_draft public.maker_drafts%rowtype;
  v_deleted_at timestamptz := now();
  v_replaced_count integer := 0;
  v_created_count integer := 0;
  v_items_count integer := 0;
  v_unique_count integer := 0;
  v_created jsonb := '[]'::jsonb;
  v_conflicts jsonb := '[]'::jsonb;
begin
  if p_mode is null or p_mode not in ('insert', 'replace') then
    raise exception 'Mode import tidak valid';
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'Daftar import harus berupa array';
  end if;

  v_items_count := jsonb_array_length(p_items);
  if v_items_count < 1 or v_items_count > 100 then
    raise exception 'Import harus berisi 1 sampai 100 kelompok dapur/tanggal';
  end if;

  select role into v_actor_role
  from public.maker_profiles
  where user_id = p_actor_user_id and is_active = true;
  if v_actor_role is distinct from 'admin' then
    raise exception 'Hanya admin aktif yang dapat melakukan import Maker';
  end if;

  select count(*) into v_unique_count
  from (
    select (item->>'kitchen_id')::uuid as kitchen_id,
           (item->>'transaction_date')::date as transaction_date
    from jsonb_array_elements(p_items) as item
    group by 1, 2
  ) grouped_items;
  if v_unique_count <> v_items_count then
    raise exception 'Paste berisi kelompok dapur dan tanggal yang duplikat';
  end if;

  -- Validate the entire batch before taking any destructive action.
  for v_item in
    select value from jsonb_array_elements(p_items) as entries(value)
    order by value->>'kitchen_id', value->>'transaction_date'
  loop
    v_kitchen_id := (v_item->>'kitchen_id')::uuid;
    v_transaction_date := (v_item->>'transaction_date')::date;
    v_payload := v_item->'payload';
    v_title := left(coalesce(v_item->>'title', ''), 160);

    if jsonb_typeof(v_payload) <> 'object'
       or jsonb_typeof(v_payload->'transaction') <> 'object'
       or jsonb_typeof(v_payload->'transaction'->'rab') <> 'array'
       or jsonb_typeof(v_payload->'transaction'->'gas') <> 'array'
       or jsonb_typeof(v_payload->'transaction'->'operasional') <> 'array'
       or jsonb_typeof(v_payload->'transaction'->'pencairan_harian') <> 'array'
       or jsonb_typeof(v_payload->'transaction'->'lain_lain') <> 'array'
       or jsonb_typeof(v_payload->'transaction'->'arutala_lain_lain') <> 'array' then
      raise exception 'Snapshot transaksi tidak lengkap atau strukturnya tidak valid';
    end if;

    if v_payload->>'kitchenId' is distinct from v_kitchen_id::text
       or v_payload->>'transactionDate' is distinct from v_transaction_date::text
       or v_payload->'transaction'->>'date' is distinct from v_transaction_date::text then
      raise exception 'Identitas dapur atau tanggal snapshot tidak cocok';
    end if;
    if coalesce(btrim(v_payload->>'output'), '') = '' then
      raise exception 'Output snapshot tidak boleh kosong';
    end if;
    if not exists (
      select 1 from public.kitchens
      where id = v_kitchen_id and is_active = true
    ) then
      raise exception 'Dapur tidak ditemukan atau sudah nonaktif';
    end if;
  end loop;

  -- Serialize concurrent imports for the same kitchen/date in a stable order.
  for v_item in
    select value from jsonb_array_elements(p_items) as entries(value)
    order by value->>'kitchen_id', value->>'transaction_date'
  loop
    perform pg_advisory_xact_lock(
      hashtextextended((v_item->>'kitchen_id') || ':' || (v_item->>'transaction_date'), 0)
    );
  end loop;

  if p_mode = 'insert' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'kitchen_id', d.kitchen_id,
      'transaction_date', d.transaction_date
    )), '[]'::jsonb)
    into v_conflicts
    from public.maker_drafts d
    join (
      select (value->>'kitchen_id')::uuid as kitchen_id,
             (value->>'transaction_date')::date as transaction_date
      from jsonb_array_elements(p_items) as entries(value)
    ) incoming
      on incoming.kitchen_id = d.kitchen_id
     and incoming.transaction_date = d.transaction_date
    where d.deleted_at is null;
    if jsonb_array_length(v_conflicts) > 0 then
      return jsonb_build_object('ok', false, 'reason', 'already_exists', 'conflicts', v_conflicts);
    end if;
  else
    update public.maker_drafts d
    set deleted_at = v_deleted_at,
        deleted_by = p_actor_user_id,
        updated_at = v_deleted_at
    where d.deleted_at is null
      and exists (
        select 1 from jsonb_array_elements(p_items) as entries(value)
        where (entries.value->>'kitchen_id')::uuid = d.kitchen_id
          and (entries.value->>'transaction_date')::date = d.transaction_date
      );
    get diagnostics v_replaced_count = row_count;
  end if;

  -- Insert one clean snapshot and one NORMAL event per imported group.
  for v_item in
    select value from jsonb_array_elements(p_items) as entries(value)
    order by value->>'kitchen_id', value->>'transaction_date'
  loop
    v_kitchen_id := (v_item->>'kitchen_id')::uuid;
    v_transaction_date := (v_item->>'transaction_date')::date;
    v_payload := v_item->'payload';
    v_title := left(coalesce(v_item->>'title', ''), 160);

    insert into public.maker_drafts (
      kitchen_id, created_by, title, status, payload, transaction_date,
      version, last_event_at
    ) values (
      v_kitchen_id, p_actor_user_id, nullif(v_title, ''),
      'ready', v_payload, v_transaction_date, 1, v_deleted_at
    )
    returning * into v_draft;

    insert into public.maker_history (
      kitchen_id, actor_user_id, draft_id, event_type, summary, snapshot
    ) values (
      v_kitchen_id, p_actor_user_id, v_draft.id,
      'NORMAL', 'Import snapshot final Maker-Pencairan',
      jsonb_build_object('version', 1, 'payload', v_payload)
    );

    v_created_count := v_created_count + 1;
    v_created := v_created || jsonb_build_array(jsonb_build_object(
      'id', v_draft.id, 'kitchen_id', v_kitchen_id, 'transaction_date', v_transaction_date
    ));
  end loop;

  return jsonb_build_object(
    'ok', true, 'mode', p_mode, 'created_count', v_created_count,
    'replaced_count', v_replaced_count, 'created', v_created
  );
end;
$$;

revoke all on function public.maker_history_import_atomic(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.maker_history_import_atomic(uuid, text, jsonb) to service_role;
