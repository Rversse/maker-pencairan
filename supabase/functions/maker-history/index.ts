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
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value + "T00:00:00Z"));
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
    const canAccessKitchen = async (kitchenId: string): Promise<boolean> => {
      if (profile.role === "admin") return true;
      const { data, error } = await db.from("maker_assignments")
        .select("id").eq("maker_user_id", profile.user_id).eq("kitchen_id", kitchenId).maybeSingle();
      if (error) throw new Error("Assignment service unavailable");
      return Boolean(data);
    };

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
        const { data: assignments, error } = await db.from("maker_assignments")
          .select("kitchen_id").eq("maker_user_id", profile.user_id);
        if (error) return json(request, { error: "Assignment service unavailable" }, 503);
        const ids = (assignments ?? []).map((row) => row.kitchen_id);
        if (!ids.length) return json(request, { ok: true, histories: [] });
        query = query.in("kitchen_id", ids);
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
      const { data: draft, error } = await db.from("maker_drafts").insert({
        kitchen_id: kitchenId, created_by: profile.user_id, title: String(body?.title ?? "").slice(0, 160) || null,
        status: "ready", payload, transaction_date: transactionDate, version: 1, last_event_at: new Date().toISOString(),
      }).select("*").single();
      if (error) return json(request, { error: "HISTORY gagal disimpan" }, 503);
      const { error: eventError } = await db.from("maker_history").insert({
        kitchen_id: kitchenId, actor_user_id: profile.user_id, draft_id: draft.id,
        event_type: "NORMAL", summary: "Pencairan awal", snapshot: { version: 1, payload },
      });
      if (eventError) {
        await db.from("maker_drafts").delete().eq("id", draft.id);
        return json(request, { error: "HISTORY gagal mencatat riwayat awal" }, 503);
      }
      return json(request, { ok: true, history: draft });
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

      const nextVersion = draft.version + 1;
      const event = {
        kitchen_id: draft.kitchen_id, actor_user_id: profile.user_id, draft_id: draft.id,
        event_type: eventType, summary: String(body?.summary ?? "").slice(0, 240) || null,
        snapshot: { version: nextVersion, delta, payload: nextSnapshot },
      };
      const { data: insertedEvent, error: eventError } = await db.from("maker_history")
        .insert(event).select("id").single();
      if (eventError) return json(request, { error: "Riwayat perubahan gagal disimpan" }, 503);

      const { data: updated, error: updateError } = await db.from("maker_drafts").update({
        payload: nextSnapshot, version: nextVersion, last_event_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", draft.id).eq("version", expectedVersion).is("deleted_at", null).select("*").maybeSingle();
      if (updateError || !updated) {
        await db.from("maker_history").delete().eq("id", insertedEvent.id);
        return json(request, { error: "HISTORY berubah bersamaan. Muat ulang dan coba lagi." }, 409);
      }
      return json(request, { ok: true, history: updated });
    }

    return json(request, { error: "Action tidak dikenal" }, 400);
  } catch (error) {
    const message = error instanceof Error && error.message === "Assignment service unavailable"
      ? error.message : "Permintaan HISTORY tidak dapat diproses";
    return json(request, { error: message }, 400);
  }
});
