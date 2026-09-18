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
     supabase secrets set FIREWORKS_API_KEY=fw_...
   A provider whose key is not set is simply not offered: the request falls
   back to MODEL rather than failing. */
type Provider = {
  url: string; keyEnv: string; kind: "anthropic" | "fireworks";
  upstreamModel?: string;  // the provider's own name for the model, when it differs from the page's id
};
const PROVIDERS: Record<string, Provider> = {
  "claude-sonnet-5": { url: "https://api.anthropic.com/v1/messages", keyEnv: "ANTHROPIC_API_KEY", kind: "anthropic" },
  /* The open-weights DeepSeek V4.1 Flash, served by Fireworks from US
     infrastructure rather than by DeepSeek itself, so board data does not
     go to DeepSeek's servers. The id stays "deepseek-flash" so pages
     already in browsers, and each browser's stored model choice, keep
     working. */
  "deepseek-flash": {
    url: "https://api.fireworks.ai/inference/v1/messages", keyEnv: "FIREWORKS_API_KEY", kind: "fireworks",
    upstreamModel: "accounts/fireworks/models/deepseek-v4p1-flash",
  },
};

/* The fallback when the page names nothing, or names something off the list.
   Overridable by env so the default can be changed without a code edit:
     supabase secrets set AI_MODEL=claude-sonnet-5 */
const MODEL = Deno.env.get("AI_MODEL") ?? "claude-sonnet-5";
const MAX_TOKENS = Number(Deno.env.get("AI_MAX_TOKENS") ?? "32000");

/* Removes cache_control at any depth, for upstreams that cache on their own. */
function stripCacheControl(x: unknown): void {
  if (Array.isArray(x)) { for (const y of x) stripCacheControl(y); return; }
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    delete o.cache_control;
    for (const k of Object.keys(o)) stripCacheControl(o[k]);
  }
}
/* Fireworks' Messages endpoint takes thinking only as a fixed budget (at
   least 1,024 tokens, counted inside max_tokens) and has no adaptive mode or
   effort field, so effort becomes a budget here. Its prefix caching is
   automatic, so cache_control is stripped. */
const FIREWORKS_BUDGET: Record<string, number> = { low: 4096, medium: 12000, high: 12000, max: 24000 };
function adaptForFireworks(payload: Record<string, unknown>): void {
  stripCacheControl(payload);
  const oc = (payload.output_config ?? {}) as Record<string, unknown>;
  const effort = typeof oc.effort === "string" ? oc.effort : "high";
  delete payload.output_config;
  const maxTokens = Number(payload.max_tokens);
  const budget = Math.min(FIREWORKS_BUDGET[effort] ?? FIREWORKS_BUDGET.high, maxTokens - 1024);
  payload.thinking = effort === "none" || budget < 1024
    ? { type: "disabled" }
    : { type: "enabled", budget_tokens: budget };
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
    payload.model = provider.upstreamModel ?? model;
    payload.max_tokens = Math.min(Number(payload.max_tokens) || MAX_TOKENS, MAX_TOKENS);
    if (provider.kind === "fireworks") adaptForFireworks(payload);

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
      // Fireworks signs with a bearer token; Anthropic with x-api-key.
      ...(provider.kind === "fireworks" ? { authorization: `Bearer ${key}` } : { "x-api-key": key }),
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
