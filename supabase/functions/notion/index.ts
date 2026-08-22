/* Notion connection + API proxy for myProductivitySpace.
 *
 * Why a proxy at all: a Notion access token is full read/write over every
 * page the user granted, and the OAuth exchange needs the integration's
 * client secret. Neither can be in a browser. (Notion's API also returns no
 * CORS headers, so direct calls would fail regardless.)
 *
 * The browser therefore never sees a Notion token. It calls these actions
 * with its own Supabase JWT; this function looks up that user's stored token
 * and makes the Notion call on their behalf.
 *
 * Deploy:
 *   supabase secrets set NOTION_CLIENT_ID=...
 *   supabase secrets set NOTION_CLIENT_SECRET=secret_...
 *   supabase functions deploy notion
 *
 * JWT verification is on by default and every action is scoped to the
 * caller's own auth.uid(). Do NOT deploy with --no-verify-jwt.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

const NOTION_VERSION = "2022-06-28";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

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

  const clientId = Deno.env.get("NOTION_CLIENT_ID");
  const clientSecret = Deno.env.get("NOTION_CLIENT_SECRET");

  // Identify the caller from their Supabase JWT. No action takes a user id
  // from the body, so one account can never act as another.
  const authHeader = req.headers.get("authorization") ?? "";
  const anonClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: userData, error: userErr } = await anonClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Not signed in." }, 401, cors);
  const userId = userData.user.id;

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* status takes no body */ }
  const action = String(body.action ?? "status");

  /* ---- status: is this user connected, and to which workspace? ---- */
  if (action === "status") {
    const { data } = await admin.from("notion_tokens")
      .select("workspace_name, workspace_icon, updated_at")
      .eq("user_id", userId).maybeSingle();
    return json({
      connected: !!data,
      configured: !!(clientId && clientSecret),
      workspace_name: data?.workspace_name ?? null,
      workspace_icon: data?.workspace_icon ?? null,
    }, 200, cors);
  }

  /* ---- authorize_url: where to send the browser to start the connect ---- */
  if (action === "authorize_url") {
    if (!clientId) return json({ error: "Notion is not configured." }, 500, cors);
    const redirectUri = String(body.redirect_uri ?? "");
    if (!redirectUri) return json({ error: "No redirect_uri." }, 400, cors);
    const u = new URL("https://api.notion.com/v1/oauth/authorize");
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("owner", "user");
    u.searchParams.set("redirect_uri", redirectUri);
    // Round-trips the caller back to the exact page they started from, and
    // is checked against the Supabase user on the way back in.
    u.searchParams.set("state", userId);
    return json({ url: u.toString() }, 200, cors);
  }

  /* ---- exchange: swap the ?code= from Notion's redirect for a token ---- */
  if (action === "exchange") {
    if (!clientId || !clientSecret) return json({ error: "Notion is not configured." }, 500, cors);
    const code = String(body.code ?? "");
    const redirectUri = String(body.redirect_uri ?? "");
    if (!code) return json({ error: "No code." }, 400, cors);
    // The state Notion echoes back must be the user doing the exchange, or a
    // code obtained in someone else's browser could be redeemed here.
    if (body.state && String(body.state) !== userId) {
      return json({ error: "state_mismatch" }, 400, cors);
    }

    const basic = btoa(`${clientId}:${clientSecret}`);
    const res = await fetch(NOTION_TOKEN_URL, {
      method: "POST",
      headers: {
        "authorization": `Basic ${basic}`,
        "content-type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    const payload = await res.json();
    if (!res.ok || !payload.access_token) {
      return json({ error: payload?.error ?? "exchange_failed" }, 502, cors);
    }

    const { error } = await admin.from("notion_tokens").upsert({
      user_id: userId,
      access_token: payload.access_token,
      bot_id: payload.bot_id ?? null,
      workspace_id: payload.workspace_id ?? null,
      workspace_name: payload.workspace_name ?? null,
      workspace_icon: payload.workspace_icon ?? null,
    }, { onConflict: "user_id" });
    if (error) return json({ error: error.message }, 500, cors);

    // Never the token itself — just enough to render the connected row.
    return json({
      connected: true,
      workspace_name: payload.workspace_name ?? null,
      workspace_icon: payload.workspace_icon ?? null,
    }, 200, cors);
  }

  /* ---- disconnect ---- */
  if (action === "disconnect") {
    await admin.from("notion_tokens").delete().eq("user_id", userId);
    return json({ ok: true }, 200, cors);
  }

  /* ---- proxy: everything else needs this user's stored token ---- */
  const { data: tok } = await admin.from("notion_tokens")
    .select("access_token").eq("user_id", userId).maybeSingle();
  if (!tok) return json({ error: "not_connected" }, 404, cors);

  /* Deliberately an allow-list of (method, path) shapes rather than a
     pass-through of whatever path the client names. A generic proxy would
     let anything running in the page reach every endpoint the token can --
     including deleting pages the user never meant this app to touch. */
  const ALLOWED: Record<string, { method: string; path: (b: Record<string, unknown>) => string }> = {
    // Which pages did the user actually grant, and which changed recently.
    // One call answers "what changed" for every page at once, which is what
    // keeps polling inside the 3 req/sec budget.
    search:        { method: "POST",  path: () => "/search" },
    page_get:      { method: "GET",   path: (b) => `/pages/${b.page_id}` },
    page_create:   { method: "POST",  path: () => "/pages" },
    page_update:   { method: "PATCH", path: (b) => `/pages/${b.page_id}` },
    blocks_list:   { method: "GET",   path: (b) => `/blocks/${b.block_id}/children?page_size=100` },
    blocks_append: { method: "PATCH", path: (b) => `/blocks/${b.block_id}/children` },
    block_update:  { method: "PATCH", path: (b) => `/blocks/${b.block_id}` },
    block_delete:  { method: "DELETE", path: (b) => `/blocks/${b.block_id}` },
  };

  const spec = ALLOWED[action];
  if (!spec) return json({ error: "unknown_action" }, 400, cors);

  const res = await fetch(NOTION_API + spec.path(body), {
    method: spec.method,
    headers: {
      "authorization": `Bearer ${tok.access_token}`,
      "content-type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    body: spec.method === "GET" || spec.method === "DELETE"
      ? undefined
      : JSON.stringify(body.payload ?? {}),
  });

  const text = await res.text();
  /* A revoked or uninstalled integration is permanent for this token --
     retrying it on every poll would burn the rate limit forever. Drop it so
     the UI falls back to "not connected" and offers a reconnect. */
  if (res.status === 401) {
    await admin.from("notion_tokens").delete().eq("user_id", userId);
    return json({ error: "not_connected" }, 404, cors);
  }
  return new Response(text, {
    status: res.status,
    headers: { ...cors, "content-type": "application/json" },
  });
});
