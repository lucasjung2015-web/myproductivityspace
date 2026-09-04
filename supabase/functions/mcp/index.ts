/* Custom connectors for myProductivitySpace.
 *
 * The board can be pointed at any server speaking MCP (Model Context
 * Protocol). This function is the client: it holds each connector's token,
 * makes the calls, and hands rows back. The browser never sees a token and
 * never talks to the server directly -- it could not anyway, since a page
 * cannot POST to an arbitrary host and get a reply.
 *
 * Same shape as the notion function next door: JWT-verified, origin-checked,
 * every row scoped to the caller's own auth.uid(). The protocol half lives in
 * client.ts so it can be tested without Deno or a network.
 *
 * WHO MAY CALL WHAT. Two callers, two different rules.
 *
 *   The AI panel calls `call` with a connector and a tool. The user is shown
 *   a confirm for each call, in the panel, before it happens. That is where
 *   the human-in-the-loop the spec asks for lives.
 *
 *   A custom widget calls `call` too, through the parent page, but a widget
 *   runs unattended on a timer -- there is nobody to show a confirm to. So a
 *   widget's calls are checked against a grant list fixed when the widget was
 *   built and visible in its gear: connector plus tool, both named. A widget
 *   granted get_quote can call get_quote forever and can never call anything
 *   else. That check is enforced in the page, which owns the widget config;
 *   this function enforces only that the caller owns the connector.
 *
 * Deploy:
 *   supabase functions deploy mcp
 * (No secrets of its own: each connector's token is supplied by the user and
 * stored in connector_secrets.)
 *
 * JWT verification is on by default. Do NOT deploy with --no-verify-jwt.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  buildRequest, parseSse, shapeToolResult, shapeToolList, checkUrl,
} from "./client.ts";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// A server that has not answered by now is not going to, and the AI panel is
// holding a turn open waiting for it.
const TIMEOUT_MS = 20000;
const MAX_CONNECTORS = 20;
// Tool output goes straight into a model's context or a widget's DOM. A
// server returning megabytes, by accident or otherwise, is not something to
// pass along whole.
const MAX_RESULT_BYTES = 120000;

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

/* One round trip to an MCP server.
 *
 * Errors are returned rather than thrown, and worded for the person who added
 * the connector: "that server took too long" is actionable, a stack trace is
 * not. The two error channels the spec defines are kept distinct -- a
 * JSON-RPC `error` is the request being wrong, while `isError` inside a
 * result is the tool itself failing, which a model can often correct and
 * retry. Collapsing them would hide that difference. */
async function rpc(opts: {
  url: string;
  token: string | null;
  id: number;
  method: string;
  name?: string;
  args?: unknown;
  inputSchema?: unknown;
}): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string; code?: number }> {
  const { headers, body } = buildRequest({
    id: opts.id, method: opts.method, name: opts.name,
    args: opts.args, inputSchema: opts.inputSchema, token: opts.token,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(opts.url, { method: "POST", headers, body, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    const msg = String((e as Error)?.name === "AbortError"
      ? "The server did not answer within " + (TIMEOUT_MS / 1000) + " seconds."
      : "Could not reach the server: " + ((e as Error).message ?? e));
    return { ok: false, error: msg };
  }
  clearTimeout(timer);

  const text = (await res.text()).slice(0, MAX_RESULT_BYTES + 4096);
  const type = res.headers.get("content-type") ?? "";
  let msg: Record<string, unknown> | null = null;
  if (type.includes("text/event-stream")) msg = parseSse(text);
  else {
    try { msg = JSON.parse(text); } catch { msg = null; }
  }

  if (!msg) {
    return {
      ok: false,
      error: res.ok
        ? "The server replied with something that is not a JSON-RPC message."
        : "The server returned HTTP " + res.status + ".",
    };
  }
  if (msg.error && typeof msg.error === "object") {
    const e = msg.error as Record<string, unknown>;
    return { ok: false, error: String(e.message ?? "The server rejected the request."), code: Number(e.code) };
  }
  if (!msg.result || typeof msg.result !== "object") {
    return { ok: false, error: "The server's reply had no result." };
  }
  return { ok: true, result: msg.result as Record<string, unknown> };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

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
  try { body = await req.json(); } catch { /* list takes no body */ }
  const action = String(body.action ?? "list");

  /** The caller's connector, or null. Never takes user_id from the body. */
  async function load(id: string) {
    const { data } = await admin.from("connectors")
      .select("id, name, url, tools, tools_at, last_error")
      .eq("user_id", userId).eq("id", id).maybeSingle();
    if (!data) return null;
    const { data: sec } = await admin.from("connector_secrets")
      .select("access_token").eq("user_id", userId).eq("id", id).maybeSingle();
    let tools: { name: string; title: string; description: string; inputSchema: unknown }[] = [];
    try { tools = JSON.parse(String(data.tools ?? "[]")); } catch { tools = []; }
    return { ...data, tools, token: (sec?.access_token as string | null) ?? null };
  }

  /* ---- list: what the modal draws. Never returns a token. ---- */
  if (action === "list") {
    const { data } = await admin.from("connectors")
      .select("id, name, url, tools, tools_at, last_error, created_at")
      .eq("user_id", userId).order("created_at", { ascending: true });
    const rows = (data ?? []).map((c) => {
      let tools: { name: string; title: string; description: string }[] = [];
      try { tools = JSON.parse(String(c.tools ?? "[]")); } catch { tools = []; }
      return {
        id: c.id, name: c.name, url: c.url,
        tool_count: tools.length,
        // Names and one-line descriptions only. The full input schemas are
        // large and only the call path needs them.
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        checked_at: c.tools_at, last_error: c.last_error ?? "",
      };
    });
    return json({ connectors: rows }, 200, cors);
  }

  /* ---- add: probe first, save second ----
     The form's button says "Test and add" because of this order. A connector
     saved without ever being reached is one the user finds out about days
     later, when the assistant says a tool does not exist. */
  if (action === "add") {
    const name = String(body.name ?? "").trim();
    const url = String(body.url ?? "").trim();
    const token = String(body.token ?? "").trim() || null;

    if (!name) return json({ error: "Give the connector a name." }, 400, cors);
    if (name.length > 60) return json({ error: "That name is too long (60 characters max)." }, 400, cors);
    const urlErr = checkUrl(url);
    if (urlErr) return json({ error: urlErr }, 400, cors);

    const { count } = await admin.from("connectors")
      .select("id", { count: "exact", head: true }).eq("user_id", userId);
    if ((count ?? 0) >= MAX_CONNECTORS) {
      return json({ error: "You already have " + MAX_CONNECTORS + " connectors, which is the limit." }, 400, cors);
    }

    const probe = await rpc({ url, token, id: 1, method: "tools/list" });
    if (!probe.ok) {
      return json({ error: "Couldn't reach that server. " + probe.error, stage: "probe" }, 502, cors);
    }
    const { tools, rejected } = shapeToolList(probe.result);
    if (!tools.length) {
      return json({
        error: rejected.length
          ? "That server answered, but every tool it offers was rejected as malformed."
          : "That server answered but offers no tools, so there is nothing to connect to.",
        rejected,
      }, 400, cors);
    }

    const id = crypto.randomUUID().slice(0, 8);
    const { error: insErr } = await admin.from("connectors").insert({
      user_id: userId, id, name, url,
      tools: JSON.stringify(tools), tools_at: new Date().toISOString(), last_error: "",
    });
    if (insErr) return json({ error: "Could not save the connector." }, 500, cors);
    if (token) {
      await admin.from("connector_secrets").insert({ user_id: userId, id, access_token: token });
    }

    return json({
      ok: true, id, name,
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
      rejected,
      note: "Connected. " + tools.length + " tool" + (tools.length === 1 ? "" : "s") + " available." +
        (rejected.length ? " " + rejected.length + " were skipped as malformed." : ""),
    }, 200, cors);
  }

  /* ---- refresh: re-probe an existing connector ---- */
  if (action === "refresh") {
    const c = await load(String(body.id ?? ""));
    if (!c) return json({ error: "No such connector." }, 404, cors);
    const probe = await rpc({ url: c.url, token: c.token, id: 1, method: "tools/list" });
    if (!probe.ok) {
      await admin.from("connectors").update({ last_error: probe.error })
        .eq("user_id", userId).eq("id", c.id);
      return json({ error: probe.error }, 502, cors);
    }
    const { tools, rejected } = shapeToolList(probe.result);
    await admin.from("connectors").update({
      tools: JSON.stringify(tools), tools_at: new Date().toISOString(), last_error: "",
    }).eq("user_id", userId).eq("id", c.id);
    return json({
      ok: true, tool_count: tools.length,
      tools: tools.map((t) => ({ name: t.name, description: t.description })), rejected,
    }, 200, cors);
  }

  if (action === "remove") {
    const id = String(body.id ?? "");
    if (!id) return json({ error: "No id." }, 400, cors);
    // The secret row cascades on the composite foreign key, so it goes with
    // this rather than being left orphaned holding a live credential.
    const { error } = await admin.from("connectors").delete().eq("user_id", userId).eq("id", id);
    if (error) return json({ error: "Could not remove that connector." }, 500, cors);
    return json({ ok: true, removed: id, note: "Removed. Widgets that used it will say so rather than showing stale rows." }, 200, cors);
  }

  /* ---- call: the whole point ---- */
  if (action === "call") {
    const c = await load(String(body.connector_id ?? ""));
    if (!c) return json({ error: "No such connector. Call list_connectors for the current ids." }, 404, cors);

    const toolName = String(body.tool ?? "");
    const tool = c.tools.find((t) => t.name === toolName);
    if (!tool) {
      return json({
        error: 'The connector "' + c.name + '" has no tool called "' + toolName + '".',
        available: c.tools.map((t) => t.name),
      }, 404, cors);
    }

    const args = body.arguments === undefined ? {} : body.arguments;
    const out = await rpc({
      url: c.url, token: c.token, id: 2, method: "tools/call",
      name: tool.name, args, inputSchema: tool.inputSchema,
    });

    if (!out.ok) {
      /* A -32601 means the server no longer has this tool, which is worth
         saying plainly: the cached list is stale and re-probing is the fix,
         not retrying the same call. */
      const stale = out.code === -32601;
      return json({
        error: out.error,
        code: out.code,
        note: stale
          ? "That server no longer offers this tool. The connector's tool list is out of date; refresh it in Connectors."
          : undefined,
      }, 502, cors);
    }

    const shaped = shapeToolResult(out.result);
    let payload = JSON.stringify(shaped);
    if (payload.length > MAX_RESULT_BYTES) {
      return json({
        error: "That tool returned " + payload.length + " bytes, over the " + MAX_RESULT_BYTES +
          " limit. Call it with narrower arguments.",
      }, 413, cors);
    }
    /* Flagged, not sanitised. This text was written by a third-party server
       and is about to be read by a model that can commit to a repository. The
       page marks it as untrusted when it goes into the transcript; stripping
       it here would only hide it. */
    return json({ ok: true, connector: c.name, tool: tool.name, untrusted: true, result: shaped }, 200, cors);
  }

  return json({ error: 'Unknown action "' + action + '".' }, 400, cors);
});
