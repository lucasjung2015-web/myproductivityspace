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

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

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

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) {
    return new Response(JSON.stringify({ error: { message: "Proxy is not configured." } }), {
      status: 500,
      headers: { ...cors, "content-type": "application/json" },
    });
  }

  let body: string;
  try {
    body = JSON.stringify(await req.json());
  } catch {
    return new Response(JSON.stringify({ error: { message: "Invalid JSON body." } }), {
      status: 400,
      headers: { ...cors, "content-type": "application/json" },
    });
  }

  const upstream = await fetch(ANTHROPIC_URL, {
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
