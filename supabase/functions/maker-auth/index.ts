import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://rversse.github.io",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
]);
const SESSION_HOURS = 8;
const encoder = new TextEncoder();

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
function fromB64url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
async function sha256(value: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  let parts = stored.split("$");
  // Backward compatibility for malformed hashes created by earlier
  // change-password/reset implementations.
  if (parts.length === 1) {
    const legacy = stored.match(/^pbkdf2_sha256(310000)([A-Za-z0-9_-]{22})([A-Za-z0-9_-]{43})$/);
    if (!legacy) return false;
    parts = ["pbkdf2_sha256", legacy[1], legacy[2], legacy[3]];
  } else if (parts.length === 2 && parts[0] === "pbkdf2_sha256") {
    const legacy = parts[1].match(/^310000([A-Za-z0-9_-]{22})([A-Za-z0-9_-]{43})$/);
    if (!legacy) return false;
    parts = ["pbkdf2_sha256", "310000", legacy[1], legacy[2]];
  }
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 300_000 || iterations > 1_000_000) return false;
  try {
    const salt = fromB64url(parts[2]);
    const expected = fromB64url(parts[3]);
    if (salt.length < 16 || expected.length < 32 || expected.length > 64) return false;
    const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      material,
      expected.length * 8,
    );
    const actual = new Uint8Array(bits);
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}
async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 310_000 },
    material,
    256,
  );
  return ["pbkdf2_sha256", "310000", b64url(salt), b64url(new Uint8Array(bits))].join("$");
}
function getBearer(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : null;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json(request, { error: "Authentication service unavailable" }, 503);

  const db = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const body = await request.json();
    const action = String(body?.action ?? "");

    if (action === "list_kitchens") {
      const { data: assignments, error: assignmentError } = await db.from("maker_assignments")
        .select("kitchen_id,maker_user_id");
      if (assignmentError) return json(request, { error: "Kitchen list unavailable" }, 503);
      const userIds = (assignments ?? []).map((row) => row.maker_user_id);
      if (!userIds.length) return json(request, { ok: true, kitchens: [] });
      const [{ data: profiles, error: profileError }, { data: credentials, error: credentialError }] = await Promise.all([
        db.from("maker_profiles").select("user_id,is_active,role").in("user_id", userIds),
        db.from("maker_credentials").select("maker_user_id,credential_type").in("maker_user_id", userIds),
      ]);
      if (profileError || credentialError) return json(request, { error: "Kitchen list unavailable" }, 503);
      const activeIds = new Set((profiles ?? []).filter((row) => row.role === "accountant" && row.is_active).map((row) => row.user_id));
      const credentialIds = new Set((credentials ?? []).filter((row) => row.credential_type === "accountant_password").map((row) => row.maker_user_id));
      const kitchenIds = (assignments ?? []).filter((row) => activeIds.has(row.maker_user_id) && credentialIds.has(row.maker_user_id)).map((row) => row.kitchen_id);
      if (!kitchenIds.length) return json(request, { ok: true, kitchens: [] });
      const { data: kitchens, error: kitchenError } = await db.from("kitchens")
        .select("id,name").in("id", kitchenIds).eq("is_active", true).order("name");
      if (kitchenError) return json(request, { error: "Kitchen list unavailable" }, 503);
      return json(request, { ok: true, kitchens: kitchens ?? [] });
    }

    if (action === "login") {
      const role = String(body?.role ?? "");
      const password = String(body?.password ?? "");
      if (!password || password.length > 256) return json(request, { error: "Kredensial tidak valid" }, 400);

      let credential = null;
      let profile = null;
      let kitchenId: string | null = null;
      let hasActiveKitchen = true;

      if (role === "admin") {
        const { data, error } = await db.from("maker_credentials")
          .select("maker_user_id,credential_type,credential_hash,hash_algorithm,must_change_credential")
          .eq("login_identifier", "admin@internal.com").maybeSingle();
        if (error) return json(request, { error: "Authentication temporarily unavailable" }, 503);
        credential = data;
      } else if (role === "accountant") {
        const selectedKitchenId = String(body?.kitchen_id ?? "");
        if (!/^[0-9a-f-]{36}$/i.test(selectedKitchenId)) return json(request, { error: "Pilih dapur terlebih dahulu" }, 400);
        kitchenId = selectedKitchenId;
        const { data: assignment, error: assignmentError } = await db.from("maker_assignments")
          .select("maker_user_id").eq("kitchen_id", kitchenId).maybeSingle();
        if (assignmentError) return json(request, { error: "Assignment service unavailable" }, 503);
        if (assignment) {
          const { data, error } = await db.from("maker_credentials")
            .select("maker_user_id,credential_type,credential_hash,hash_algorithm,must_change_credential")
            .eq("maker_user_id", assignment.maker_user_id).maybeSingle();
          if (error) return json(request, { error: "Authentication temporarily unavailable" }, 503);
          credential = data;
        }
        const { data: kitchen, error: kitchenError } = await db.from("kitchens")
          .select("id").eq("id", kitchenId).eq("is_active", true).maybeSingle();
        if (kitchenError) return json(request, { error: "Kitchen service unavailable" }, 503);
        hasActiveKitchen = Boolean(kitchen && credential);
        if (credential) {
          const { data: kitchenLock, error: kitchenLockError } = await db.from("maker_kitchen_login_locks")
            .select("failed_attempts,locked_at").eq("kitchen_id", kitchenId).maybeSingle();
          if (kitchenLockError) return json(request, { error: "Login protection service unavailable" }, 503);
          if (kitchenLock?.locked_at) return json(request, {
            error: "Akses login dapur ini dikunci setelah 5 kali percobaan gagal. Silakan hubungi Admin untuk membuka blokir.",
            code: "KITCHEN_LOGIN_LOCKED",
          }, 423);
        }
      } else {
        return json(request, { error: "Metode login tidak valid" }, 400);
      }

      if (credential) {
        const { data, error } = await db.from("maker_profiles")
          .select("user_id,role,display_name,is_active").eq("user_id", credential.maker_user_id).maybeSingle();
        if (error) return json(request, { error: "Authentication temporarily unavailable" }, 503);
        profile = data;
      }

      const adminPasswordValid = role === "admin" && credential?.credential_type === "admin_password" &&
        /^(?=.*[A-Za-z])(?=.*\d)[\x21-\x7E]{8,16}$/.test(password);
      const legacyAdminMigration = role === "admin" && credential?.credential_type === "admin_pin" &&
        credential.must_change_credential && /^\d{8}$/.test(password);
      const accountantPasswordValid = role === "accountant" && credential?.credential_type === "accountant_password" &&
        /^(?=.*[A-Za-z])(?=.*\d)[\x21-\x7E]{8,16}$/.test(password);
      const roleMatches = profile && ((profile.role === "admin" && (adminPasswordValid || legacyAdminMigration)) ||
        (profile.role === "accountant" && accountantPasswordValid));

      if (role === "accountant" && profile && !profile.is_active) {
        return json(request, { error: "Akun dinonaktifkan oleh admin" }, 403);
      }
      const valid = Boolean(credential && profile?.is_active && roleMatches && hasActiveKitchen &&
        credential.hash_algorithm === "pbkdf2_sha256" &&
        await verifyPassword(password, credential.credential_hash));

      if (!valid) {
        if (role === "accountant" && kitchenId && credential) {
          const { data: lockResult, error: rateError } = await db.rpc("maker_register_kitchen_login_failure", {
            p_kitchen_id: kitchenId,
          }).maybeSingle();
          if (rateError || !lockResult) return json(request, { error: "Login protection service unavailable" }, 503);
          if (lockResult.is_locked) return json(request, {
            error: "Akses login dapur ini dikunci setelah 5 kali percobaan gagal. Silakan hubungi Admin untuk membuka blokir.",
            code: "KITCHEN_LOGIN_LOCKED",
          }, 423);
          return json(request, { error: "Password salah", attempts_remaining: Math.max(0, 5 - lockResult.attempts) }, 401);
        }
        return json(request, { error: role === "admin" ? "Password Admin salah" : "Akun dapur tidak ditemukan atau tidak aktif" }, 401);
      }

      if (role === "accountant" && kitchenId) {
        const { error: clearKitchenError } = await db.rpc("maker_clear_kitchen_login_failures", { p_kitchen_id: kitchenId });
        if (clearKitchenError) return json(request, { error: "Login protection service unavailable" }, 503);
      }

      const rawToken = new Uint8Array(32);
      crypto.getRandomValues(rawToken);
      const sessionToken = b64url(rawToken);
      const tokenHash = await sha256(sessionToken);
      const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
      const { error: sessionError } = await db.from("maker_sessions").insert({
        maker_user_id: profile.user_id, token_hash: tokenHash, expires_at: expiresAt,
      });
      if (sessionError) return json(request, { error: "Tidak dapat membuat sesi" }, 500);
      return json(request, {
        ok: true, access_token: sessionToken, token_type: "Bearer", expires_at: expiresAt,
        must_change_credential: credential.must_change_credential || legacyAdminMigration,
        user: { id: profile.user_id, role: profile.role, display_name: profile.display_name },
      });
    }

    const sessionToken = getBearer(request);
    if (!sessionToken || sessionToken.length < 40 || sessionToken.length > 128) {
      return json(request, { error: "Sesi tidak valid" }, 401);
    }
    const tokenHash = await sha256(sessionToken);

    if (action === "change_password") {
      const newPassword = String(body?.new_password ?? "");
      const oldPassword = String(body?.old_password ?? "");
      if (!/^(?=.*[A-Za-z])(?=.*\d)[\x21-\x7E]{8,16}$/.test(newPassword)) {
        return json(request, { error: "Password harus 8–16 karakter tanpa spasi" }, 400);
      }
      const { data: session, error: sessionError } = await db
        .from("maker_sessions")
        .select("id,maker_user_id")
        .eq("token_hash", tokenHash)
        .is("revoked_at", null)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
      if (sessionError) return json(request, { error: "Session service unavailable" }, 503);
      if (!session) return json(request, { error: "Sesi tidak valid atau kedaluwarsa" }, 401);
      const { data: profile, error: profileError } = await db
        .from("maker_profiles")
        .select("user_id,role,is_active")
        .eq("user_id", session.maker_user_id)
        .maybeSingle();
      if (profileError) return json(request, { error: "Profile service unavailable" }, 503);
      if (!profile?.is_active) return json(request, { error: "Akun tidak aktif" }, 403);
      const { data: credential, error: credentialError } = await db
        .from("maker_credentials")
        .select("credential_hash,must_change_credential,credential_version")
        .eq("maker_user_id", profile.user_id)
        .maybeSingle();
      if (credentialError || !credential) return json(request, { error: "Credential service unavailable" }, 503);
      if (!credential.must_change_credential && !(await verifyPassword(oldPassword, credential.credential_hash))) {
        return json(request, { error: "Password lama tidak sesuai" }, 401);
      }
      const nextHash = await hashPassword(newPassword);
      const { error: updateError } = await db.from("maker_credentials").update({
        credential_hash: nextHash,
        credential_type: profile.role === "admin" ? "admin_password" : "accountant_password",
        hash_algorithm: "pbkdf2_sha256",
        must_change_credential: false,
        credential_version: credential.credential_version + 1,
        failed_attempts: 0,
        locked_until: null,
        credential_updated_at: new Date().toISOString(),
      }).eq("maker_user_id", profile.user_id);
      if (updateError) return json(request, { error: "Unable to change password" }, 503);
      const { error: revokeError } = await db.from("maker_sessions").update({
        revoked_at: new Date().toISOString(),
        revoke_reason: "password_changed",
      }).eq("maker_user_id", profile.user_id).neq("id", session.id).is("revoked_at", null);
      if (revokeError) return json(request, { error: "Password changed but other sessions could not be revoked" }, 503);
      return json(request, { ok: true, must_change_credential: false });
    }

    if (action === "session") {
      const { data: session, error: sessionError } = await db
        .from("maker_sessions")
        .select("id,maker_user_id,expires_at")
        .eq("token_hash", tokenHash)
        .is("revoked_at", null)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
      if (sessionError) return json(request, { error: "Session service unavailable" }, 503);
      if (!session) return json(request, { error: "Sesi tidak valid atau kedaluwarsa" }, 401);

      const { data: profile, error: profileError } = await db
        .from("maker_profiles")
        .select("user_id,role,display_name,is_active")
        .eq("user_id", session.maker_user_id)
        .maybeSingle();
      if (profileError) return json(request, { error: "Session service unavailable" }, 503);
      if (!profile?.is_active) return json(request, { error: "Akun tidak aktif" }, 403);

      const { data: credential, error: credentialError } = await db.from("maker_credentials")
        .select("must_change_credential")
        .eq("maker_user_id", profile.user_id)
        .maybeSingle();
      if (credentialError) return json(request, { error: "Credential service unavailable" }, 503);
      if (!credential) return json(request, { error: "Credential not found" }, 403);

      const { error: touchError } = await db.from("maker_sessions")
        .update({ last_seen_at: new Date().toISOString() }).eq("id", session.id);
      if (touchError) return json(request, { error: "Session service unavailable" }, 503);

      return json(request, {
        ok: true,
        expires_at: session.expires_at,
        user: { id: profile.user_id, role: profile.role, display_name: profile.display_name },
        must_change_credential: credential.must_change_credential,
      });
    }

    if (action === "logout") {
      const { error: revokeError } = await db.from("maker_sessions")
        .update({ revoked_at: new Date().toISOString(), revoke_reason: "user_logout" })
        .eq("token_hash", tokenHash)
        .is("revoked_at", null);
      if (revokeError) return json(request, { error: "Session service unavailable" }, 503);
      return json(request, { ok: true });
    }

    return json(request, { error: "Unknown action" }, 400);
  } catch {
    return json(request, { error: "Permintaan tidak dapat diproses" }, 400);
  }
});