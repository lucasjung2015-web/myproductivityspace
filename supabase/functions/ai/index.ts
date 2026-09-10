/* Anthropic proxy for the myProductivitySpace AI sidebar.
 *
 * Exists so the API key stops living in the page. The dashboard is one
 * self-contained HTML file served publicly, so anything in it — including a
 * billable credential — ships to every visitor. This holds the key instead
 * and forwards to Anthropic, which also puts the panel behind the same
 * invite gate as the rest of the board: nobody who merely finds the URL can
 * spend against the account.
 *
 * Deploy:
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
 *   supabase functions deploy ai
 *
 * JWT verification is on by default, so an unauthenticated call is rejected
 * before this code runs. Do NOT deploy with --no-verify-jwt.
 */

/* Where each model id is sent, and which secret signs the request. Every
   upstream here speaks Anthropic's Messages format, so the page builds one
   request shape and this function only re-addresses it. Anything the page
   asks for that is not on this list falls back to MODEL: a tester with
   devtools open can pick between the models the owner has priced, and
   nothing else.

   Deploy a second provider with its key, e.g.
     supabase secrets set DEEPSEEK_API_KEY=sk-...
   A provider whose key is not set is simply not offered: the request falls
   back to MODEL rather than failing. */
type Provider = { url: string; keyEnv: string; kind: "anthropic" | "deepseek" };
const PROVIDERS: Record<string, Provider> = {
  "claude-sonnet-5": { url: "https://api.anthropic.com/v1/messages", keyEnv: "ANTHROPIC_API_KEY", kind: "anthropic" },
  "deepseek-flash":  { url: "https://api.deepseek.com/anthropic/v1/messages", keyEnv: "DEEPSEEK_API_KEY", kind: "deepseek" },
};

/* The fallback when the page names nothing, or names something off the list.
   Overridable by env so the default can be changed without a code edit:
     supabase secrets set AI_MODEL=claude-sonnet-5 */
const MODEL = Deno.env.get("AI_MODEL") ?? "claude-sonnet-5";
const MAX_TOKENS = Number(Deno.env.get("AI_MAX_TOKENS") ?? "32000");

/* DeepSeek's Anthropic-compatible endpoint takes the same request with four
   differences, per its compatibility table: `cache_control` is ignored (its
   caching is automatic), `thinking` is enabled/disabled rather than adaptive,
   `display` is not a field it knows, and effort "none" is spelled as thinking
   off. Stripping the ignored fields rather than forwarding them keeps a
   future strictness change on their side from turning into a 400 here. */
function stripCacheControl(x: unknown): void {
  if (Array.isArray(x)) { for (const y of x) stripCacheControl(y); return; }
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    delete o.cache_control;
    for (const k of Object.keys(o)) stripCacheControl(o[k]);
  }
}
function adaptForDeepseek(payload: Record<string, unknown>): void {
  stripCacheControl(payload);
  const oc = (payload.output_config ?? {}) as Record<string, unknown>;
  const effort = typeof oc.effort === "string" ? oc.effort : "high";
  if (effort === "none") {
    payload.thinking = { type: "disabled" };
    delete payload.output_config;
  } else {
    payload.thinking = { type: "enabled" };
    payload.output_config = { effort };
  }
}

// The board is served from one origin; echo it back rather than using "*",
// since these requests carry an Authorization header.
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin))
    ? origin
    : (ALLOWED_ORIGINS[0] ?? "*");
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": "authorization, content-type, anthropic-version",
    "access-control-allow-methods": "POST, OPTIONS",
    "vary": "origin",
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: { message: "Method not allowed" } }), {
      status: 405,
      headers: { ...cors, "content-type": "application/json" },
    });
  }

  let body: string;
  let provider: Provider;
  let key: string;
  try {
    const payload = await req.json();

    /* The model and the output ceiling are decided HERE, not in the page.
       Everything this function forwards arrives from a browser, so a tester
       with devtools open could otherwise set `model` to a five-times-pricier
       one and `max_tokens` to 128000 and spend against the account at will.
       The invite gate stops strangers; it does not stop a curious friend.
       The page's choice is honoured only when it names a model on the
       PROVIDERS list whose key is configured; otherwise it is MODEL. */
    const asked = typeof payload.model === "string" ? payload.model : "";
    let model = PROVIDERS[asked] && Deno.env.get(PROVIDERS[asked].keyEnv) ? asked : MODEL;
    if (!PROVIDERS[model]) model = "claude-sonnet-5";
    provider = PROVIDERS[model];
    key = Deno.env.get(provider.keyEnv) ?? "";
    payload.model = model;
    payload.max_tokens = Math.min(Number(payload.max_tokens) || MAX_TOKENS, MAX_TOKENS);
    if (provider.kind === "deepseek") adaptForDeepseek(payload);

    body = JSON.stringify(payload);
  } catch {
    return new Response(JSON.stringify({ error: { message: "Invalid JSON body." } }), {
      status: 400,
      headers: { ...cors, "content-type": "application/json" },
    });
  }
  if (!key) {
    return new Response(JSON.stringify({ error: { message: "Proxy is not configured." } }), {
      status: 500,
      headers: { ...cors, "content-type": "application/json" },
    });
  }

  const upstream = await fetch(provider.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": req.headers.get("anthropic-version") ?? "2023-06-01",
    },
    body,
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text();
    return new Response(detail, {
      status: upstream.status,
      headers: { ...cors, "content-type": "application/json" },
    });
  }

  /* Pipe through an explicit TransformStream rather than handing back
     `upstream.body` directly. The direct handoff has been reported to stall
     on the edge runtime (supabase/edge-runtime#91) because a ReadableStream
     carries no size, and a stall here reads as "the AI panel hangs forever"
     with nothing in the console. The pump costs nothing and is predictable. */
  const { readable, writable } = new TransformStream();
  upstream.body.pipeTo(writable).catch(() => {});

  return new Response(readable, {
    status: 200,
    headers: {
      ...cors,
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      // Defensive: some proxies buffer SSE into one lump without this,
      // which would defeat the point of streaming.
      "x-accel-buffering": "no",
    },
  });
});
