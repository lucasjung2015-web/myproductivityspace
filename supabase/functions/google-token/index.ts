/* Google access-token broker for myProductivitySpace.
 *
 * The problem it solves: Supabase hands over Google's provider_token only on
 * the OAuth callback and never persists it, so Calendar/Tasks access died with
 * each browser tab while the board's own session lived on. GIS's silent
 * re-mint was supposed to cover that and doesn't reliably — Chrome's
 * third-party-cookie restrictions make it succeed sometimes and fail others no
 * matter how long it is given.
 *
 * Google's refresh token is the durable answer, but redeeming one requires the
 * OAuth client SECRET, which must never reach a browser. So the refresh token
 * is handed here once at sign-in, stored in a table with RLS on and no
 * policies (service_role only — the browser cannot read it back), and redeemed
 * here for short-lived access tokens.
 *
 * Deploy:
 *   supabase secrets set GOOGLE_CLIENT_ID=...apps.googleusercontent.com
 *   supabase secrets set GOOGLE_CLIENT_SECRET=GOCSPX-...
 *   supabase functions deploy google-token
 *
 * JWT verification is on by default and every path below is scoped to the
 * caller's own auth.uid(). Do NOT deploy with --no-verify-jwt.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin))
    ? origin
    : (ALLOWED_ORIGINS[0] ?? "*");
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "vary": "origin",
  };
}

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return json({ error: "Broker is not configured." }, 500, cors);
  }

  // Identify the caller from their Supabase JWT. Everything below is scoped to
  // this id — the request body never names a user, so one signed-in account
  // cannot ask for another's token.
  const authHeader = req.headers.get("authorization") ?? "";
  const anonClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: userData, error: userErr } = await anonClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Not signed in." }, 401, cors);
  const userId = userData.user.id;

  // service_role, because google_tokens has RLS on and no policies at all.
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  let body: { action?: string; refresh_token?: string } = {};
  try { body = await req.json(); } catch { /* empty body is fine for "get" */ }

  /* ---- store: called once, right after the OAuth callback ---- */
  if (body.action === "store") {
    if (!body.refresh_token) return json({ error: "No refresh_token." }, 400, cors);
    const { error } = await admin.from("google_tokens").upsert({
      user_id: userId,
      refresh_token: body.refresh_token,
    }, { onConflict: "user_id" });
    if (error) return json({ error: error.message }, 500, cors);
    return json({ ok: true }, 200, cors);
  }

  /* ---- forget: called on sign-out ---- */
  if (body.action === "forget") {
    await admin.from("google_tokens").delete().eq("user_id", userId);
    return json({ ok: true }, 200, cors);
  }

  /* ---- get (default): redeem the stored refresh token ---- */
  const { data: row, error: readErr } = await admin
    .from("google_tokens")
    .select("refresh_token")
    .eq("user_id", userId)
    .maybeSingle();
  if (readErr) return json({ error: readErr.message }, 500, cors);
  // Not an error: it just means this account has never completed a consent
  // that returned a refresh token. The caller falls back to its own flow.
  if (!row) return json({ error: "no_refresh_token" }, 404, cors);

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: row.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const payload = await res.json();

  if (!res.ok) {
    /* A revoked or expired grant is permanent — retrying it forever would
       mean every page load pays a pointless round trip to Google. Drop the
       dead token so the client falls back to a real consent instead. Note
       that Google expires refresh tokens after 7 days while the OAuth consent
       screen is still in "Testing" mode; publishing it removes that. */
    if (payload?.error === "invalid_grant") {
      await admin.from("google_tokens").delete().eq("user_id", userId);
      return json({ error: "invalid_grant" }, 404, cors);
    }
    return json({ error: payload?.error ?? "refresh_failed" }, 502, cors);
  }

  // Only the short-lived half ever goes back to the browser.
  return json({
    access_token: payload.access_token,
    expires_in: payload.expires_in ?? 3600,
  }, 200, cors);
});
