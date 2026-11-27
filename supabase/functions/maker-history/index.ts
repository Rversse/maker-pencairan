import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://rversse.github.io",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
]);
const encoder = new TextEncoder();
const EVENT_TYPES = new Set(["NORMAL", "REVISI", "KEKURANGAN", "TAMBAHAN"]);

function cors(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://rversse.github.io",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
  };
}
function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: cors(request) });
}
function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function sha256(value: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
function bearer(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : null;
}
function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json(request, { error: "HISTORY service unavailable" }, 503);

  const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    const token = bearer(request);
    if (!token || token.length < 40 || token.length > 128) {
      return json(request, { error: "Sesi tidak valid" }, 401);
    }
    const tokenHash = await sha256(token);
    const { data: session, error: sessionError } = await db.from("maker_sessions")
      .select("id,maker_user_id")
      .eq("token_hash", tokenHash)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (sessionError) return json(request, { error: "Session service unavailable" }, 503);
    if (!session) return json(request, { error: "Sesi tidak valid atau kedaluwarsa" }, 401);

    const { data: profile, error: profileError } = await db.from("maker_profiles")
      .select("user_id,role,display_name,is_active")
      .eq("user_id", session.maker_user_id)
      .maybeSingle();
    if (profileError) return json(request, { error: "Profile service unavailable" }, 503);
    if (!profile?.is_active || !["admin", "accountant"].includes(profile.role)) {
      return json(request, { error: "Akun tidak aktif atau tidak berhak" }, 403);
    }

    const body = await request.json();
    const action = String(body?.action ?? "");

    if (action === "admin_daily_status") {
      if (profile.role !== "admin") {
        return json(request, { error: "Hanya Admin yang dapat melihat status input seluruh dapur" }, 403);
      }
      const transactionDate = body?.transaction_date;
      if (!validDate(transactionDate)) {
        return json(request, { error: "Tanggal status input tidak valid" }, 400);
      }
      const [kitchensResult, draftsResult] = await Promise.all([
        db.from("kitchens")
          .select("id,name")
          .eq("is_active", true)
          .order("name"),
        db.from("maker_drafts")
          .select("kitchen_id")
          .eq("transaction_date", transactionDate)
          .is("deleted_at", null),
      ]);
      if (kitchensResult.error || draftsResult.error) {
        return json(request, { error: "Status input harian tidak dapat dimuat" }, 503);
      }
      const activeKitchenIds = new Set((kitchensResult.data ?? []).map((kitchen) => kitchen.id));
      const submittedKitchenIds = [...new Set(
        (draftsResult.data ?? [])
          .map((draft) => draft.kitchen_id)
          .filter((kitchenId) => activeKitchenIds.has(kitchenId))
      )];
      return json(request, {
        ok: true,
        transaction_date: transactionDate,
        kitchens: kitchensResult.data ?? [],
        submitted_kitchen_ids: submittedKitchenIds,
      });
    }

    const canAccessKitchen = async (kitchenId: string): Promise<boolean> => {
      if (profile.role === "admin") return true;
      const { data: assignment, error: assignmentError } = await db.from("maker_assignments")
        .select("id").eq("maker_user_id", profile.user_id).eq("kitchen_id", kitchenId).maybeSingle();
      if (assignmentError) throw new Error("Assignment service unavailable");
      if (!assignment) return false;
      const { data: kitchen, error: kitchenError } = await db.from("kitchens")
        .select("id").eq("id", kitchenId).eq("is_active", true).maybeSingle();
      if (kitchenError) throw new Error("Kitchen service unavailable");
      return Boolean(kitchen);
    };

    if (
      action === "ops_real_get" ||
      action === "ops_real_create" ||
      action === "ops_real_update" ||
      action === "ops_real_delete"
    ) {
      const kitchenId = body?.kitchen_id;
      const transactionDate = body?.transaction_date;
      if (!isUuid(kitchenId) || !validDate(transactionDate)) {
        return json(request, { error: "Dapur atau tanggal OPS REAL tidak valid" }, 400);
      }
      if (!(await canAccessKitchen(kitchenId))) {
        return json(request, { error: "Akses dapur ditolak" }, 403);
      }

      const selectColumns = "id,source_system,source_record_id,transaction_date,kitchen_id,amount,note,version,created_at,created_by,source_created_by,source_created_role,edited_by,edited_role,edited_source,edited_at";
      const findSharedRecords = async () => {
        const { data, error } = await db.from("transactions")
          .select(selectColumns)
          .eq("flow_type", "ops_disbursement_real")
          .eq("category", "OPS")
          .eq("kitchen_id", kitchenId)
          .eq("transaction_date", transactionDate)
          .order("created_at", { ascending: true });
        if (error) throw new Error("Data OPS Real gagal diperiksa");
        return data ?? [];
      };

      if (action === "ops_real_get") {
        try {
          const records = await findSharedRecords();
          return json(request, { ok: true, records, record: records[0] ?? null });
        } catch (error) {
          return json(request, { error: error instanceof Error ? error.message : "Data OPS Real gagal dimuat" }, 503);
        }
      }

      const actorRole = profile.role === "accountant" ? "Akuntan" : "Admin";
      const actor = {
        edited_by: profile.user_id,
        edited_role: actorRole,
        edited_source: "maker",
      };

      if (action === "ops_real_create") {
        const amount = String(body?.amount ?? "");
        if (!/^\d{1,15}$/.test(amount) || Number(amount) <= 0 || !Number.isSafeInteger(Number(amount))) {
          return json(request, { error: "Nominal OPS Real harus berupa angka positif yang valid" }, 400);
        }
        const note = typeof body?.note === "string" ? body.note : "";
        if (!note.trim()) return json(request, { error: "Catatan OPS Real wajib diisi" }, 400);

        const sourceRecordId = crypto.randomUUID();
        const { data: created, error } = await db.from("transactions").insert({
          transaction_date: transactionDate,
          kitchen_id: kitchenId,
          amount: Number(amount),
          note: note.trim(),
          flow_type: "ops_disbursement_real",
          category: "OPS",
          account_id: null,
          supplier_id: null,
          destination_label: null,
          operational_type: null,
          source_system: "maker",
          source_record_id: sourceRecordId,
          source_created_by: profile.user_id,
          source_created_role: actorRole,
          ...actor,
        }).select(selectColumns).single();
        if (error?.code === "23505") return json(request, { error: "Transaksi OPS - Pencairan Real dengan nominal dan catatan yang sama sudah ada untuk dapur dan tanggal ini." }, 409);
        if (error) return json(request, { error: "OPS - Pencairan Real gagal disimpan" }, 503);
        return json(request, { ok: true, record: created });
      }

      const transactionId = body?.transaction_id;
      if (!isUuid(transactionId)) {
        return json(request, { error: "ID transaksi OPS Real tidak valid" }, 400);
      }
      const { data: record, error: recordError } = await db.from("transactions")
        .select(selectColumns)
        .eq("id", transactionId)
        .eq("flow_type", "ops_disbursement_real")
        .eq("category", "OPS")
        .eq("kitchen_id", kitchenId)
        .eq("transaction_date", transactionDate)
        .maybeSingle();
      if (recordError) return json(request, { error: "Data OPS Real gagal diperiksa" }, 503);
      if (!record) return json(request, { error: "Transaksi OPS Real tidak ditemukan. Muat ulang riwayat." }, 404);

      const expectedVersion = Number(body?.expected_version);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        return json(request, { error: "Versi data tidak valid. Muat ulang Riwayat." }, 400);
      }
      if (record.version !== expectedVersion) {
        return json(request, { error: "Transaksi OPS Real sudah berubah di aplikasi lain. Muat ulang sebelum melanjutkan." }, 409);
      }

      if (action === "ops_real_delete") {
        const { data: marked, error: markError } = await db.from("transactions")
          .update(actor).eq("id", record.id).eq("version", record.version)
          .select("id,version").maybeSingle();
        if (markError) return json(request, { error: "Aktor penghapus OPS Real gagal dicatat" }, 503);
        if (!marked) return json(request, { error: "Transaksi OPS Real berubah saat proses hapus. Muat ulang sebelum mencoba lagi." }, 409);
        const { data: deleted, error: deleteError } = await db.from("transactions")
          .delete().eq("id", record.id).eq("version", marked.version)
          .select("id").maybeSingle();
        if (deleteError) return json(request, { error: "OPS - Pencairan Real gagal dihapus" }, 503);
        if (!deleted) return json(request, { error: "Transaksi OPS Real berubah saat proses hapus. Muat ulang sebelum mencoba lagi." }, 409);
        return json(request, { ok: true, deleted: true, transaction_id: record.id });
      }

      if (action !== "ops_real_update") return json(request, { error: "Aksi OPS Real tidak dikenal" }, 400);
      const amount = String(body?.amount ?? "");
      if (!/^\d{1,15}$/.test(amount) || Number(amount) <= 0 || !Number.isSafeInteger(Number(amount))) {
        return json(request, { error: "Nominal OPS Real harus berupa angka positif yang valid" }, 400);
      }
      const note = typeof body?.note === "string" ? body.note : "";
      if (!note.trim()) return json(request, { error: "Catatan OPS Real wajib diisi" }, 400);
      const { data: updated, error: updateError } = await db.from("transactions")
        .update({ amount: Number(amount), note: note.trim(), ...actor })
        .eq("id", record.id).eq("version", record.version)
        .select(selectColumns).maybeSingle();
      if (updateError?.code === "23505") return json(request, { error: "Transaksi OPS - Pencairan Real dengan nominal dan catatan yang sama sudah ada untuk dapur dan tanggal ini." }, 409);
      if (updateError) return json(request, { error: "OPS - Pencairan Real gagal diperbarui" }, 503);
      if (!updated) return json(request, { error: "Transaksi OPS Real berubah di aplikasi lain. Muat ulang sebelum menyimpan lagi." }, 409);
      return json(request, { ok: true, record: updated });
    }

    if (action === "list") {
      const kitchenId = body?.kitchen_id;
      const dateFrom = body?.date_from;
      const dateTo = body?.date_to;
      if (profile.role === "accountant" && kitchenId && !isUuid(kitchenId)) {
        return json(request, { error: "Dapur tidak valid" }, 400);
      }
      let query = db.from("maker_drafts")
        .select("id,kitchen_id,created_by,title,status,transaction_date,version,payload,last_event_at,created_at,updated_at")
        .order("transaction_date", { ascending: false }).order("created_at", { ascending: false });
      query = query.is("deleted_at", null);
      if (profile.role === "accountant") {
        const { data: assignments, error: assignmentError } = await db.from("maker_assignments")
          .select("kitchen_id").eq("maker_user_id", profile.user_id);
        if (assignmentError) return json(request, { error: "Assignment service unavailable" }, 503);
        const assignedIds = (assignments ?? []).map((row) => row.kitchen_id);
        if (!assignedIds.length) return json(request, { ok: true, histories: [] });
        const { data: activeKitchens, error: kitchenError } = await db.from("kitchens")
          .select("id").in("id", assignedIds).eq("is_active", true);
        if (kitchenError) return json(request, { error: "Kitchen service unavailable" }, 503);
        const activeIds = (activeKitchens ?? []).map((row) => row.id);
        if (!activeIds.length) return json(request, { ok: true, histories: [] });
        query = query.in("kitchen_id", activeIds);
      }
      if (kitchenId) query = query.eq("kitchen_id", kitchenId);
      if (dateFrom) {
        if (!validDate(dateFrom)) return json(request, { error: "Tanggal awal tidak valid" }, 400);
        query = query.gte("transaction_date", dateFrom);
      }
      if (dateTo) {
        if (!validDate(dateTo)) return json(request, { error: "Tanggal akhir tidak valid" }, 400);
        query = query.lte("transaction_date", dateTo);
      }
      const { data, error } = await query.limit(250);
      if (error) return json(request, { error: "HISTORY tidak dapat dimuat" }, 503);
      return json(request, { ok: true, histories: data ?? [] });
    }

    if (action === "get") {
      if (!isUuid(body?.draft_id)) return json(request, { error: "HISTORY tidak valid" }, 400);
      const { data: draft, error } = await db.from("maker_drafts").select("*")
        .eq("id", body.draft_id).is("deleted_at", null).maybeSingle();
      if (error) return json(request, { error: "HISTORY tidak dapat dimuat" }, 503);
      if (!draft) return json(request, { error: "HISTORY tidak ditemukan" }, 404);
      if (!(await canAccessKitchen(draft.kitchen_id))) return json(request, { error: "Akses dapur ditolak" }, 403);
      const { data: events, error: eventError } = await db.from("maker_history").select("*")
        .eq("draft_id", draft.id).order("created_at", { ascending: true });
      if (eventError) return json(request, { error: "Riwayat perubahan tidak dapat dimuat" }, 503);
      return json(request, {
        ok: true,
        history: draft,
        events: events ?? [],
        locked: profile.role !== "admin" && Date.now() >= new Date(draft.created_at).getTime() + 24 * 60 * 60 * 1000,
        lock_at: new Date(new Date(draft.created_at).getTime() + 24 * 60 * 60 * 1000).toISOString(),
      });
    }

    if (action === "create") {
      const kitchenId = body?.kitchen_id;
      const transactionDate = body?.transaction_date;
      const payload = body?.payload;
      if (!isUuid(kitchenId) || !validDate(transactionDate) || !payload || typeof payload !== "object" || Array.isArray(payload)) {
        return json(request, { error: "Data HISTORY awal tidak lengkap" }, 400);
      }
      if (!(await canAccessKitchen(kitchenId))) return json(request, { error: "Akses dapur ditolak" }, 403);
      const { data: result, error } = await db.rpc("maker_history_create_atomic", {
        p_kitchen_id: kitchenId,
        p_actor_user_id: profile.user_id,
        p_title: String(body?.title ?? "").slice(0, 160) || null,
        p_transaction_date: transactionDate,
        p_payload: payload,
      });
      if (error || !result?.ok) return json(request, { error: "HISTORY gagal disimpan secara utuh" }, 503);
      return json(request, { ok: true, history: result.history });
    }

    if (action === "delete") {
      if (profile.role !== "admin") return json(request, { error: "Hanya Admin yang dapat menghapus transaksi" }, 403);
      const draftId = body?.draft_id;
      if (!isUuid(draftId)) return json(request, { error: "Transaksi tidak valid" }, 400);
      const { data: draft, error: draftError } = await db.from("maker_drafts")
        .select("id,deleted_at").eq("id", draftId).is("deleted_at", null).maybeSingle();
      if (draftError) return json(request, { error: "Transaksi tidak dapat diperiksa" }, 503);
      if (!draft) return json(request, { error: "Transaksi tidak ditemukan atau sudah dihapus" }, 404);
      const deletedAt = new Date().toISOString();
      const { data: deleted, error: deleteError } = await db.from("maker_drafts").update({
        deleted_at: deletedAt, deleted_by: profile.user_id, updated_at: deletedAt,
      }).eq("id", draftId).is("deleted_at", null).select("id").maybeSingle();
      if (deleteError) return json(request, { error: "Transaksi gagal dihapus" }, 503);
      if (!deleted) return json(request, { error: "Transaksi sudah dihapus oleh proses lain" }, 409);
      return json(request, { ok: true, deleted_id: draftId, deleted_at: deletedAt });
    }

    if (action === "import") {
      if (profile.role !== "admin") {
        return json(request, { error: "Hanya Admin yang dapat mengimpor snapshot Maker" }, 403);
      }
      const mode = String(body?.mode ?? "");
      const items = body?.items;
      if (!["insert", "replace"].includes(mode) || !Array.isArray(items) || items.length < 1 || items.length > 100) {
        return json(request, { error: "Mode atau jumlah kelompok import tidak valid" }, 400);
      }

      const seen = new Set<string>();
      for (const item of items) {
        const kitchenId = item?.kitchen_id;
        const transactionDate = item?.transaction_date;
        const payload = item?.payload;
        if (!isUuid(kitchenId) || !validDate(transactionDate) ||
            !payload || typeof payload !== "object" || Array.isArray(payload) ||
            !payload.transaction || typeof payload.transaction !== "object" || Array.isArray(payload.transaction) ||
            !Array.isArray(payload.transaction.rab) ||
            !Array.isArray(payload.transaction.gas) ||
            !Array.isArray(payload.transaction.operasional) ||
            !Array.isArray(payload.transaction.pencairan_harian) ||
            !Array.isArray(payload.transaction.lain_lain) ||
            !Array.isArray(payload.transaction.arutala_lain_lain) ||
            payload.kitchenId !== kitchenId ||
            payload.transactionDate !== transactionDate ||
            payload.transaction.date !== transactionDate ||
            typeof payload.output !== "string" || !payload.output.trim()) {
          return json(request, { error: "Snapshot import tidak lengkap atau tanggal/dapurnya tidak cocok" }, 400);
        }
        const outputLines = payload.output.split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean);
        const header = outputLines[0] ?? "";
        const headerMatch = /^(?:(REVISI|TAMBAHAN|KEKURANGAN)\s*-\s*)?(.+),\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+\(\d+\))?$/.exec(header);
        const months: Record<string, number> = {
          jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, jun: 6,
          jul: 7, agu: 8, sep: 9, okt: 10, nov: 11, des: 12,
        };
        const headerMonth = headerMatch ? months[headerMatch[4].toLowerCase()] : undefined;
        const headerDay = headerMatch ? Number(headerMatch[3]) : 0;
        const headerYear = headerMatch ? Number(headerMatch[5]) : 0;
        const headerParsed = headerMonth ? new Date(Date.UTC(headerYear, headerMonth - 1, headerDay)) : null;
        const headerDate = headerMonth !== undefined && headerParsed &&
          headerParsed.getUTCFullYear() === headerYear &&
          headerParsed.getUTCMonth() === headerMonth - 1 &&
          headerParsed.getUTCDate() === headerDay
          ? headerYear + "-" + String(headerMonth).padStart(2, "0") + "-" + String(headerDay).padStart(2, "0")
          : "";
        if (!headerMatch || headerMatch[1] || outputLines.length < 2 ||
            headerMatch[2].trim().toLocaleLowerCase("id-ID") !== String(payload.kitchenName ?? "").trim().toLocaleLowerCase("id-ID") ||
            headerDate !== transactionDate) {
          return json(request, { error: "Header output tidak cocok dengan nama dapur/tanggal snapshot atau bukan output final" }, 400);
        }
        if (payload.output.length > 100000) {
          return json(request, { error: "Output satu kelompok terlalu besar untuk diimpor" }, 413);
        }
        const key = kitchenId + ":" + transactionDate;
        if (seen.has(key)) {
          return json(request, { error: "Paste berisi dapur dan tanggal yang sama lebih dari sekali" }, 400);
        }
        seen.add(key);
      }

      const { data: imported, error: importError } = await db.rpc("maker_history_import_atomic", {
        p_actor_user_id: profile.user_id,
        p_mode: mode,
        p_items: items,
      });
      if (importError) {
        console.error("[maker-history import]", importError.message);
        return json(request, { error: "Import gagal disimpan secara utuh. Data lama tetap dipertahankan." }, 503);
      }
      if (imported?.reason === "already_exists") {
        return json(request, {
          error: "Snapshot untuk sebagian tanggal sudah ada. Gunakan Replace Data bila memang ingin menggantinya.",
          reason: "already_exists",
          conflicts: imported.conflicts ?? [],
        }, 409);
      }
      if (!imported?.ok) {
        return json(request, { error: "Batch import tidak dapat divalidasi. Tidak ada data yang diubah." }, 400);
      }
      return json(request, {
        ok: true,
        mode: imported.mode,
        created_count: imported.created_count,
        replaced_count: imported.replaced_count,
        created: imported.created ?? [],
      });
    }

    if (action === "change") {
      const draftId = body?.draft_id;
      const eventType = String(body?.event_type ?? "");
      const expectedVersion = Number(body?.expected_version);
      const delta = body?.delta;
      const nextSnapshot = body?.snapshot;
      if (!isUuid(draftId) || !EVENT_TYPES.has(eventType) || eventType === "NORMAL" ||
          !Number.isInteger(expectedVersion) || expectedVersion < 1 ||
          !delta || typeof delta !== "object" || Array.isArray(delta) ||
          !nextSnapshot || typeof nextSnapshot !== "object" || Array.isArray(nextSnapshot)) {
        return json(request, { error: "Data perubahan HISTORY tidak valid" }, 400);
      }
      const { data: draft, error } = await db.from("maker_drafts").select("*")
        .eq("id", draftId).is("deleted_at", null).maybeSingle();
      if (error) return json(request, { error: "HISTORY tidak dapat diperiksa" }, 503);
      if (!draft) return json(request, { error: "HISTORY tidak ditemukan" }, 404);
      if (!(await canAccessKitchen(draft.kitchen_id))) return json(request, { error: "Akses dapur ditolak" }, 403);
      const locked = Date.now() >= new Date(draft.created_at).getTime() + 24 * 60 * 60 * 1000;
      if (locked && profile.role !== "admin") return json(request, { error: "HISTORY sudah terkunci setelah 24 jam" }, 423);
      if (draft.version !== expectedVersion) return json(request, { error: "HISTORY sudah berubah. Muat ulang sebelum menyimpan.", current_version: draft.version }, 409);

      const { data: result, error: atomicError } = await db.rpc("maker_history_change_atomic", {
        p_draft_id: draft.id,
        p_actor_user_id: profile.user_id,
        p_expected_version: expectedVersion,
        p_event_type: eventType,
        p_summary: String(body?.summary ?? "").slice(0, 240) || null,
        p_delta: delta,
        p_next_snapshot: nextSnapshot,
        p_is_admin: profile.role === "admin",
      });
      if (atomicError) return json(request, { error: "Perubahan HISTORY gagal disimpan" }, 503);
      if (result?.reason === "locked") return json(request, { error: "HISTORY sudah terkunci setelah 24 jam" }, 423);
      if (result?.reason === "version_conflict") return json(request, { error: "HISTORY berubah bersamaan. Muat ulang dan coba lagi.", current_version: result.current_version }, 409);
      if (result?.reason === "not_found") return json(request, { error: "HISTORY tidak ditemukan" }, 404);
      if (!result?.ok) return json(request, { error: "Data perubahan HISTORY tidak valid" }, 400);
      return json(request, { ok: true, history: result.history });
    }

    return json(request, { error: "Action tidak dikenal" }, 400);
  } catch (error) {
    const message = error instanceof Error && error.message === "Assignment service unavailable"
      ? error.message : "Permintaan HISTORY tidak dapat diproses";
    return json(request, { error: message }, 400);
  }
});
