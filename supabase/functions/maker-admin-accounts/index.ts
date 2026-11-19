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
const cors = (request: Request): HeadersInit => {
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
};
const reply = (request: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors(request) });
const sha256 = async (value: string) =>
  btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const b64url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 310_000 }, material, 256);
  return `pbkdf2_sha256$310000$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}
function bearer(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 300_000 || iterations > 1_000_000) return false;
  try {
    const decode = (value: string) => {
      const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
      const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    };
    const salt = decode(parts[2]);
    const expected = decode(parts[3]);
    if (salt.length < 16 || expected.length < 32 || expected.length > 64) return false;
    const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, expected.length * 8);
    const actual = new Uint8Array(bits);
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch { return false; }
}
Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors(request) });
  if (request.method !== "POST") return reply(request, { error: "Method not allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return reply(request, { error: "Service unavailable" }, 503);
  const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    const token = bearer(request);
    if (token.length < 40 || token.length > 128) return reply(request, { error: "Unauthorized" }, 401);
    const tokenHash = await sha256(token);
    const { data: session, error: sessionError } = await db.from("maker_sessions")
      .select("id,maker_user_id").eq("token_hash", tokenHash).is("revoked_at", null)
      .gt("expires_at", new Date().toISOString()).maybeSingle();
    if (sessionError) return reply(request, { error: "Session service unavailable" }, 503);
    if (!session) return reply(request, { error: "Unauthorized" }, 401);

    const { data: admin, error: adminError } = await db.from("maker_profiles")
      .select("user_id,role,is_active").eq("user_id", session.maker_user_id).maybeSingle();
    if (adminError) return reply(request, { error: "Profile service unavailable" }, 503);
    if (!admin?.is_active || admin.role !== "admin") return reply(request, { error: "Forbidden" }, 403);

    const body = await request.json();
    const action = String(body?.action ?? "");

    if (action === "list") {
      const [profilesResult, assignmentsResult, credentialsResult, kitchensResult, activeKitchensResult, loginLocksResult] = await Promise.all([
        db.from("maker_profiles").select("user_id,display_name,role,is_active,created_at,updated_at").eq("role", "accountant").order("display_name"),
        db.from("maker_assignments").select("id,maker_user_id,kitchen_id,assigned_by,created_at"),
        db.from("maker_credentials").select("maker_user_id,login_identifier,must_change_credential,credential_updated_at"),
        db.from("kitchens").select("id,name,is_active").order("name"),
        db.from("kitchens").select("id,name,is_active").eq("is_active", true).order("name"),
        db.from("maker_kitchen_login_locks").select("kitchen_id,failed_attempts,locked_at,last_failed_at,unlocked_at,unlocked_by"),
      ]);
      if (profilesResult.error || assignmentsResult.error || credentialsResult.error || kitchensResult.error || activeKitchensResult.error || loginLocksResult.error) {
        return reply(request, { error: "Unable to load account data" }, 503);
      }
      const assignedKitchenIds = new Set((assignmentsResult.data ?? []).map((row) => row.kitchen_id));
      const credentialByUser = new Map((credentialsResult.data ?? []).map((row) => [row.maker_user_id, row]));
      const kitchenById = new Map((kitchensResult.data ?? []).map((row) => [row.id, row]));
      const assignmentByUser = new Map((assignmentsResult.data ?? []).map((row) => [row.maker_user_id, row]));
      const accountants = (profilesResult.data ?? []).map((profile) => {
        const credential = credentialByUser.get(profile.user_id);
        const assignment = assignmentByUser.get(profile.user_id);
        const kitchen = assignment ? kitchenById.get(assignment.kitchen_id) ?? null : null;
        return {
          ...profile,
          email: credential?.login_identifier ?? null,
          must_change_credential: credential?.must_change_credential ?? false,
          credential_updated_at: credential?.credential_updated_at ?? null,
          kitchen: kitchen ? { id: kitchen.id, name: kitchen.name, is_active: kitchen.is_active } : null,
        };
      });
      const loginLocks = new Map((loginLocksResult.data ?? []).map((row) => [row.kitchen_id, row]));
      const accountantsWithLock = accountants.map((account) => ({
        ...account,
        login_lock: account.kitchen ? loginLocks.get(account.kitchen.id) ?? null : null,
      }));
      const availableKitchens = (activeKitchensResult.data ?? []).filter((kitchen) => kitchen.name !== "Sukaraharja" && !assignedKitchenIds.has(kitchen.id));
      return reply(request, {
        ok: true,
        accountants: accountantsWithLock,
        assignments: assignmentsResult.data ?? [],
        kitchens: activeKitchensResult.data ?? [],
        available_kitchens: availableKitchens,
      });
    }

    if (action === "unlock_kitchen_login") {
      const kitchenId = String(body?.kitchen_id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(kitchenId)) return reply(request, { error: "Dapur tidak valid" }, 400);
      const { data: kitchen, error: kitchenError } = await db.from("kitchens")
        .select("id,name").eq("id", kitchenId).maybeSingle();
      if (kitchenError) return reply(request, { error: "Unable to load kitchen" }, 503);
      if (!kitchen) return reply(request, { error: "Dapur tidak ditemukan" }, 404);
      const { error: unlockError } = await db.from("maker_kitchen_login_locks").upsert({
        kitchen_id: kitchenId,
        failed_attempts: 0,
        locked_at: null,
        last_failed_at: null,
        unlocked_at: new Date().toISOString(),
        unlocked_by: admin.user_id,
        updated_at: new Date().toISOString(),
      }, { onConflict: "kitchen_id" });
      if (unlockError) return reply(request, { error: "Gagal membuka blokir login dapur" }, 503);
      return reply(request, { ok: true, kitchen: { id: kitchen.id, name: kitchen.name } });
    }

    if (action === "create_account") {
      const kitchenId = String(body?.kitchen_id ?? "");
      const password = String(body?.password ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(kitchenId)) return reply(request, { error: "Pilih dapur yang valid" }, 400);
      if (! /^(?=.*[A-Za-z])(?=.*\d)[\x21-\x7E]{8,16}$/.test(password)) return reply(request, { error: "Password harus 8–16 karakter tanpa spasi" }, 400);

      const { data: kitchen, error: kitchenError } = await db.from("kitchens")
        .select("id,name,is_active").eq("id", kitchenId).eq("is_active", true).maybeSingle();
      if (kitchenError) return reply(request, { error: "Unable to validate kitchen" }, 503);
      if (!kitchen) return reply(request, { error: "Dapur tidak ditemukan atau sudah nonaktif" }, 404);

      const slug = kitchen.name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
      if (!slug) return reply(request, { error: "Nama dapur tidak dapat dijadikan identitas login" }, 400);
      const email = `akuntan.${slug}@internal.com`;
      const displayName = `Akuntan ${kitchen.name}`;

      const { data: existingAssignment, error: assignmentCheckError } = await db.from("maker_assignments")
        .select("id").eq("kitchen_id", kitchenId).maybeSingle();
      if (assignmentCheckError) return reply(request, { error: "Unable to check kitchen account" }, 503);
      if (existingAssignment) return reply(request, { error: "Dapur ini sudah memiliki akun Accountant" }, 409);
      const { data: existingCredential, error: credentialCheckError } = await db.from("maker_credentials")
        .select("maker_user_id").eq("login_identifier", email).maybeSingle();
      if (credentialCheckError) return reply(request, { error: "Unable to check login identifier" }, 503);
      if (existingCredential) return reply(request, { error: "Email login dapur ini sudah digunakan" }, 409);

      const { data: profile, error: profileError } = await db.from("maker_profiles")
        .insert({ role: "accountant", display_name: displayName, is_active: true })
        .select("user_id,display_name,role,is_active,created_at").single();
      if (profileError || !profile) return reply(request, { error: "Unable to create account" }, 503);

      const credentialHash = await hashPassword(password);
      const { error: credentialError } = await db.from("maker_credentials").insert({
        maker_user_id: profile.user_id,
        login_identifier: email,
        credential_type: "accountant_password",
        credential_hash: credentialHash,
        hash_algorithm: "pbkdf2_sha256",
        must_change_credential: true,
      });
      if (credentialError) {
        await db.from("maker_profiles").delete().eq("user_id", profile.user_id);
        return reply(request, { error: credentialError.code === "23505" ? "Email login sudah digunakan" : "Unable to save account credential" }, credentialError.code === "23505" ? 409 : 503);
      }

      const { error: assignmentError } = await db.from("maker_assignments").insert({
        maker_user_id: profile.user_id,
        kitchen_id: kitchen.id,
        assigned_by: admin.user_id,
      });
      if (assignmentError) {
        await db.from("maker_profiles").delete().eq("user_id", profile.user_id);
        return reply(request, { error: assignmentError.code === "23505" ? "Dapur sudah memiliki akun Accountant" : "Unable to save kitchen assignment" }, assignmentError.code === "23505" ? 409 : 503);
      }
      return reply(request, {
        ok: true,
        accountant: profile,
        email,
        kitchen: { id: kitchen.id, name: kitchen.name },
        must_change_credential: true,
      });
    }

    if (action === "set_account_status") {
      const userId = String(body?.user_id ?? "");
      const isActive = body?.is_active;
      if (!/^[0-9a-f-]{36}$/i.test(userId) || typeof isActive !== "boolean") return reply(request, { error: "Invalid account status request" }, 400);
      const { data: target, error: targetError } = await db.from("maker_profiles")
        .select("user_id,role,is_active").eq("user_id", userId).maybeSingle();
      if (targetError) return reply(request, { error: "Unable to load account" }, 503);
      if (!target || target.role !== "accountant") return reply(request, { error: "Accountant tidak ditemukan" }, 404);
      if (isActive) {
        const { data: assignment, error: assignmentError } = await db.from("maker_assignments")
          .select("kitchen_id").eq("maker_user_id", userId).maybeSingle();
        if (assignmentError) return reply(request, { error: "Unable to validate kitchen assignment" }, 503);
        if (!assignment) return reply(request, { error: "Akun belum memiliki assignment dapur" }, 409);
        const { data: kitchen, error: kitchenError } = await db.from("kitchens")
          .select("id").eq("id", assignment.kitchen_id).eq("is_active", true).maybeSingle();
        if (kitchenError) return reply(request, { error: "Unable to validate kitchen status" }, 503);
        if (!kitchen) return reply(request, { error: "Dapur tidak aktif; akun tidak dapat diaktifkan" }, 409);
      }
      const { error: updateError } = await db.from("maker_profiles").update({ is_active: isActive, updated_at: new Date().toISOString() }).eq("user_id", userId);
      if (updateError) return reply(request, { error: "Unable to update account status" }, 503);
      if (!isActive) {
        const { error: revokeError } = await db.from("maker_sessions").update({ revoked_at: new Date().toISOString(), revoke_reason: "account_deactivated" }).eq("maker_user_id", userId).is("revoked_at", null);
        if (revokeError) return reply(request, { error: "Account deactivated but session revocation failed; retry revocation" }, 503);
      }
      return reply(request, { ok: true, user_id: userId, is_active: isActive });
    }

    if (action === "reset_password") {
      const userId = String(body?.user_id ?? "");
      const password = String(body?.password ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(userId) || ! /^(?=.*[A-Za-z])(?=.*\d)[\x21-\x7E]{8,16}$/.test(password)) return reply(request, { error: "Password harus 8–16 karakter tanpa spasi" }, 400);
      const { data: target, error: targetError } = await db.from("maker_profiles").select("role,is_active").eq("user_id", userId).maybeSingle();
      if (targetError) return reply(request, { error: "Unable to load account" }, 503);
      if (!target || target.role !== "accountant") return reply(request, { error: "Accountant tidak ditemukan" }, 404);
      const { data: currentCredential, error: currentCredentialError } = await db.from("maker_credentials").select("credential_version").eq("maker_user_id", userId).maybeSingle();
      if (currentCredentialError || !currentCredential) return reply(request, { error: "Unable to load credential" }, 503);
      const credentialHash = await hashPassword(password);
      const { error: credentialError } = await db.from("maker_credentials").update({
        credential_hash: credentialHash, hash_algorithm: "pbkdf2_sha256",
        must_change_credential: true, credential_version: currentCredential.credential_version + 1,
        failed_attempts: 0, locked_until: null, credential_updated_at: new Date().toISOString(),
      }).eq("maker_user_id", userId);
      if (credentialError) return reply(request, { error: "Unable to reset credential" }, 503);
      const { error: revokeError } = await db.from("maker_sessions").update({ revoked_at: new Date().toISOString(), revoke_reason: "credential_reset" }).eq("maker_user_id", userId).is("revoked_at", null);
      if (revokeError) return reply(request, { error: "Credential reset but session revocation failed; retry revocation" }, 503);
      return reply(request, { ok: true, must_change_credential: true });
    }

    if (action === "change_password") {
      const newPassword = String(body?.new_password ?? "");
      const oldPassword = String(body?.old_password ?? "");
      if (!/^(?=.*[A-Za-z])(?=.*\\d)[\\x21-\\x7E]{8,16}$/.test(newPassword)) return reply(request, { error: "Password harus 8–16 karakter, minimal huruf dan angka, tanpa spasi" }, 400);
      const { data: credential, error: credentialError } = await db.from("maker_credentials")
        .select("credential_hash,must_change_credential,credential_version").eq("maker_user_id", admin.user_id).maybeSingle();
      if (credentialError || !credential) return reply(request, { error: "Unable to load credential" }, 503);
      if (!credential.must_change_credential && !(await verifyPassword(oldPassword, credential.credential_hash))) {
        return reply(request, { error: "Password lama tidak sesuai" }, 401);
      }
      const nextHash = await hashPassword(newPassword);
      const { error: updateError } = await db.from("maker_credentials").update({
        credential_hash: nextHash, credential_type: "admin_password", hash_algorithm: "pbkdf2_sha256",
        must_change_credential: false, credential_version: credential.credential_version + 1,
        failed_attempts: 0, locked_until: null, credential_updated_at: new Date().toISOString(),
      }).eq("maker_user_id", admin.user_id);
      if (updateError) return reply(request, { error: "Unable to change password" }, 503);
      const { error: revokeError } = await db.from("maker_sessions").update({
        revoked_at: new Date().toISOString(), revoke_reason: "password_changed",
      }).eq("maker_user_id", admin.user_id).neq("id", session.id).is("revoked_at", null);
      if (revokeError) return reply(request, { error: "Password changed but other sessions could not be revoked" }, 503);
      return reply(request, { ok: true, must_change_credential: false });
    }

    return reply(request, { error: "Unknown action" }, 400);
  } catch {
    return reply(request, { error: "Request could not be processed" }, 400);
  }
});