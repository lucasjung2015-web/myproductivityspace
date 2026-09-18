/* The board, as an MCP server, for Claude agents.
 *
 * A Claude Managed Agent runs in Anthropic's cloud on a schedule, with nobody
 * signed in. This is how it reaches one user's board: Pages, lists, Google
 * Tasks and Google Calendar, plus post_result, which is how a run reports
 * back to the Automations widget.
 *
 * WHO IS CALLING. Not a Supabase user. Each account that uses agents gets one
 * random bearer token, minted by the agents function, stored in that user's
 * Anthropic vault (Anthropic injects it into requests to this URL; the agent's
 * sandbox never sees it), and stored HERE only as a SHA-256 hash in
 * agent_accounts. The hash names the user. Nothing in a request body can name
 * a different one.
 *
 * WHAT IT CAN DO. Read and write the four things above, and nothing else on
 * the board: no widget definitions, no layout, no settings, no deletes. Page
 * writes go through the same block format the board's own editor saves, and
 * every write is stamped writer "agent" so the board adopts it on its next
 * pull. A board tab with unsynced edits to the same Page keeps its own copy.
 *
 * PROTOCOL. Streamable HTTP, stateless: one JSON-RPC request per POST, a JSON
 * reply, 202 for notifications. initialize is answered for clients on the
 * older revisions that still send it; nothing is kept between requests.
 *
 * Deploy:
 *   supabase functions deploy board-mcp --no-verify-jwt
 * --no-verify-jwt is required: the caller is Anthropic's MCP client, which
 * carries this function's own bearer token, not a Supabase session. The
 * token check below is the authentication.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  adminClient, anthropicClient, enforceCap, isOwnerId, sha256Hex, syncAutomation, writeAutomationsTopic,
} from "../_shared/agents-common.ts";
import { markdownToBlocks, readBlocks } from "./blocks.ts";

type Json = Record<string, unknown>;

const SUPPORTED_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"];
const PAGE_MAX_BYTES = 200_000;
const RESULT_MAX_CHARS = 6000;
const TASKS_API = "https://www.googleapis.com/tasks/v1";
const CAL_API = "https://www.googleapis.com/calendar/v3";

/* ---------------- board storage ---------------- */

// The six widgets every board starts with. Anything else is in
// "dynamic-widgets", written by the board when a widget is added with +.
const BUILTIN: Record<string, { type: string; title: string }> = {
  cal: { type: "calendar", title: "Calendar" },
  unschedTasks: { type: "tasks", title: "Google Tasks" },
  readingList: { type: "readingList", title: "Reading List" },
  atomicHabits: { type: "page", title: "Atomic Habits" },
  affirmations: { type: "page", title: "Affirmations" },
  vocab: { type: "vocab", title: "Vocabulary" },
};
const DYNAMIC_TYPE: Record<string, string> = {
  page: "page", list: "list", readingList: "readingList", calView: "calendar",
  tasksView: "tasks", vocab: "vocab", menu: "bookmarks", custom: "custom",
};

async function kvGet(db: SupabaseClient, userId: string, key: string): Promise<string | null> {
  const { data } = await db.from("kv").select("value").eq("user_id", userId).eq("key", key).maybeSingle();
  return (data?.value as string | undefined) ?? null;
}

async function kvSet(db: SupabaseClient, userId: string, key: string, value: string): Promise<void> {
  const { error } = await db.from("kv").upsert(
    { user_id: userId, key, value, writer: "agent" },
    { onConflict: "user_id,key" },
  );
  if (error) throw new Error("Could not save to the board: " + error.message);
}

async function widgets(db: SupabaseClient, userId: string): Promise<{ id: string; type: string; title: string }[]> {
  let titles: Record<string, string> = {};
  try { titles = JSON.parse((await kvGet(db, userId, "widget-titles")) ?? "{}") || {}; } catch { titles = {}; }
  let dyn: { id: string; type: string }[] = [];
  try { dyn = JSON.parse((await kvGet(db, userId, "dynamic-widgets")) ?? "[]") || []; } catch { dyn = []; }
  const out = Object.keys(BUILTIN).map((id) => ({ id, type: BUILTIN[id].type, title: titles[id] || BUILTIN[id].title }));
  for (const w of dyn) {
    if (!w || typeof w.id !== "string") continue;
    const type = DYNAMIC_TYPE[w.type] ?? w.type;
    out.push({ id: w.id, type, title: titles[w.id] || "" });
  }
  return out;
}

async function widgetOfType(db: SupabaseClient, userId: string, id: string, types: string[]) {
  const w = (await widgets(db, userId)).find((x) => x.id === id);
  if (!w) throw new Error("No widget with id '" + id + "'. Call list_widgets for the current ids.");
  if (!types.includes(w.type)) throw new Error("'" + id + "' is a " + w.type + " widget, not a " + types.join(" or ") + ".");
  return w;
}

function listKey(id: string, type: string): string {
  if (type === "readingList") return id === "readingList" ? "reading-list-items" : "reading-list-items:" + id;
  return "list-items:" + id;
}

/* ---------------- Google ---------------- */

async function googleToken(db: SupabaseClient, userId: string): Promise<string> {
  const { data: row } = await db.from("google_tokens").select("refresh_token").eq("user_id", userId).maybeSingle();
  if (!row) throw new Error("Google is not connected for this account. The user needs to sign in to the board again.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
      refresh_token: row.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.access_token) {
    throw new Error("Google refused the stored sign-in (" + (payload.error ?? res.status) + "). The user needs to sign in to the board again.");
  }
  return payload.access_token as string;
}

async function gapi(token: string, url: string, init: RequestInit = {}): Promise<Json | null> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: "Bearer " + token, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Google API " + res.status + ": " + (body?.error?.message ?? "request failed"));
  return body as Json;
}

/* ---------------- tools ---------------- */

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const TOOLS = [
  {
    name: "list_widgets",
    description: "List the widgets on the user's board with their id, type (page, list, readingList, tasks, calendar, vocab, bookmarks, custom) and title. Call this first to find the id of a Page or list.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ,
  },
  {
    name: "read_page",
    description: "Read a Page widget as numbered blocks (type, indent, text, checked for to-dos).",
    inputSchema: { type: "object", properties: { widget_id: { type: "string" } }, required: ["widget_id"], additionalProperties: false },
    annotations: READ,
  },
  {
    name: "write_page",
    description: "Write Markdown into a Page widget. mode 'append' (default) adds to the end and keeps what is there; 'replace' overwrites the whole Page, so use it only when the task says to rewrite that Page. Supports # headings, - bullets, 1. numbered, [ ] to-dos, > quotes, ``` code, **bold**, *italic*, `code`, [links](https://...).",
    inputSchema: {
      type: "object",
      properties: {
        widget_id: { type: "string" },
        markdown: { type: "string" },
        mode: { type: "string", enum: ["append", "replace"] },
      },
      required: ["widget_id", "markdown"],
      additionalProperties: false,
    },
    annotations: WRITE,
  },
  {
    name: "read_list",
    description: "Read a list widget (Lists or Reading List): each item's id, text, done state and tags.",
    inputSchema: { type: "object", properties: { widget_id: { type: "string" } }, required: ["widget_id"], additionalProperties: false },
    annotations: READ,
  },
  {
    name: "add_list_item",
    description: "Add one item to the end of a list widget.",
    inputSchema: {
      type: "object",
      properties: { widget_id: { type: "string" }, text: { type: "string" } },
      required: ["widget_id", "text"],
      additionalProperties: false,
    },
    annotations: WRITE,
  },
  {
    name: "set_list_item_done",
    description: "Mark a list item done or not done.",
    inputSchema: {
      type: "object",
      properties: { widget_id: { type: "string" }, item_id: { type: "string" }, done: { type: "boolean" } },
      required: ["widget_id", "item_id", "done"],
      additionalProperties: false,
    },
    annotations: WRITE,
  },
  {
    name: "list_tasks",
    description: "List the user's open Google Tasks (default list): id, title, notes, due date.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ,
  },
  {
    name: "create_task",
    description: "Create a Google Task in the default list. due is a date, YYYY-MM-DD.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, notes: { type: "string" }, due: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
    annotations: WRITE,
  },
  {
    name: "complete_task",
    description: "Mark a Google Task completed.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false },
    annotations: WRITE,
  },
  {
    name: "list_events",
    description: "List events on the user's primary Google Calendar from days_back days ago to days_ahead days from now (defaults 0 and 7, max 60 each).",
    inputSchema: {
      type: "object",
      properties: { days_back: { type: "integer" }, days_ahead: { type: "integer" } },
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: "create_event",
    description: "Create an event on the user's primary Google Calendar. start and end are ISO 8601 date-times; time_zone is an IANA name such as America/New_York.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" }, description: { type: "string" },
        start: { type: "string" }, end: { type: "string" }, time_zone: { type: "string" },
      },
      required: ["summary", "start", "end"],
      additionalProperties: false,
    },
    annotations: WRITE,
  },
  {
    name: "post_result",
    description: "Report this run's result to the user's Automations widget. Call it exactly once, at the end of every run, including runs that could not finish (say why). summary is plain text or light Markdown, under 6000 characters.",
    inputSchema: {
      type: "object",
      properties: { automation_id: { type: "string" }, summary: { type: "string" } },
      required: ["automation_id", "summary"],
      additionalProperties: false,
    },
    annotations: WRITE,
  },
];

export const READ_TOOL_NAMES = TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);

function str(v: unknown): string { return typeof v === "string" ? v : ""; }

async function callTool(db: SupabaseClient, userId: string, name: string, a: Json): Promise<Json> {
  switch (name) {
    case "list_widgets":
      return { widgets: await widgets(db, userId) };

    case "read_page": {
      const w = await widgetOfType(db, userId, str(a.widget_id), ["page"]);
      const html = (await kvGet(db, userId, "note-content:" + w.id)) ?? "";
      return { widget_id: w.id, title: w.title, blocks: readBlocks(html) };
    }

    case "write_page": {
      const w = await widgetOfType(db, userId, str(a.widget_id), ["page"]);
      const md = str(a.markdown);
      if (!md.trim()) throw new Error("markdown is empty.");
      const key = "note-content:" + w.id;
      const current = (await kvGet(db, userId, key)) ?? "";
      const replace = a.mode === "replace";
      const next = replace
        ? markdownToBlocks(md, true)
        : current + markdownToBlocks(md, !readBlocks(current).length);
      if (new TextEncoder().encode(next).length > PAGE_MAX_BYTES) throw new Error("That would make the Page larger than 200 KB.");
      await kvSet(db, userId, key, next);
      return { ok: true, widget_id: w.id, mode: replace ? "replace" : "append", blocks: readBlocks(next).length };
    }

    case "read_list": {
      const w = await widgetOfType(db, userId, str(a.widget_id), ["list", "readingList"]);
      let items: Json[] = [];
      try { items = JSON.parse((await kvGet(db, userId, listKey(w.id, w.type))) ?? "[]") || []; } catch { items = []; }
      return { widget_id: w.id, items };
    }

    case "add_list_item": {
      const w = await widgetOfType(db, userId, str(a.widget_id), ["list", "readingList"]);
      const text = str(a.text).trim();
      if (!text) throw new Error("text is required.");
      const key = listKey(w.id, w.type);
      let items: Json[] = [];
      try { items = JSON.parse((await kvGet(db, userId, key)) ?? "[]") || []; } catch { items = []; }
      const item = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 7), text: text.slice(0, 2000), done: false };
      items.push(item);
      await kvSet(db, userId, key, JSON.stringify(items));
      return { ok: true, item };
    }

    case "set_list_item_done": {
      const w = await widgetOfType(db, userId, str(a.widget_id), ["list", "readingList"]);
      const key = listKey(w.id, w.type);
      let items: Json[] = [];
      try { items = JSON.parse((await kvGet(db, userId, key)) ?? "[]") || []; } catch { items = []; }
      const it = items.find((x) => x.id === str(a.item_id));
      if (!it) throw new Error("No item with that id. Call read_list for the current ids.");
      it.done = !!a.done;
      if (it.done) it.completedAt = new Date().toISOString(); else delete it.completedAt;
      await kvSet(db, userId, key, JSON.stringify(items));
      return { ok: true, item: it };
    }

    case "list_tasks": {
      const token = await googleToken(db, userId);
      const r = await gapi(token, TASKS_API + "/lists/%40default/tasks?showCompleted=false&maxResults=100");
      const items = ((r?.items as Json[]) ?? []).filter((t) => t.title).map((t) => ({
        id: t.id, title: t.title, notes: t.notes ?? "", due: t.due ? String(t.due).slice(0, 10) : null,
      }));
      return { tasks: items };
    }

    case "create_task": {
      const title = str(a.title).trim();
      if (!title) throw new Error("title is required.");
      const due = str(a.due);
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error("due must be YYYY-MM-DD.");
      const token = await googleToken(db, userId);
      const body: Json = { title, notes: str(a.notes) };
      if (due) body.due = due + "T00:00:00.000Z";
      const t = await gapi(token, TASKS_API + "/lists/%40default/tasks", { method: "POST", body: JSON.stringify(body) });
      return { ok: true, task: { id: t?.id, title: t?.title, due: due || null } };
    }

    case "complete_task": {
      const id = str(a.task_id);
      if (!id) throw new Error("task_id is required.");
      const token = await googleToken(db, userId);
      await gapi(token, TASKS_API + "/lists/%40default/tasks/" + encodeURIComponent(id), {
        method: "PATCH", body: JSON.stringify({ id, status: "completed" }),
      });
      return { ok: true, completed: id };
    }

    case "list_events": {
      const back = Math.min(60, Math.max(0, Number(a.days_back ?? 0) || 0));
      const ahead = Math.min(60, Math.max(0, Number(a.days_ahead ?? 7) || 7));
      const now = Date.now();
      const q = new URLSearchParams({
        timeMin: new Date(now - back * 86400000).toISOString(),
        timeMax: new Date(now + ahead * 86400000).toISOString(),
        singleEvents: "true", orderBy: "startTime", maxResults: "100",
      });
      const token = await googleToken(db, userId);
      const r = await gapi(token, CAL_API + "/calendars/primary/events?" + q.toString());
      const items = ((r?.items as Json[]) ?? []).filter((e) => e.status !== "cancelled").map((e) => ({
        id: e.id, summary: e.summary ?? "", description: e.description ?? "",
        start: (e.start as Json)?.dateTime ?? (e.start as Json)?.date,
        end: (e.end as Json)?.dateTime ?? (e.end as Json)?.date,
        location: e.location ?? "",
      }));
      return { events: items };
    }

    case "create_event": {
      const summary = str(a.summary).trim();
      const start = str(a.start), end = str(a.end);
      if (!summary || isNaN(Date.parse(start)) || isNaN(Date.parse(end))) {
        throw new Error("summary, and start and end as ISO 8601 date-times, are required.");
      }
      const tz = str(a.time_zone);
      const token = await googleToken(db, userId);
      const e = await gapi(token, CAL_API + "/calendars/primary/events", {
        method: "POST",
        body: JSON.stringify({
          summary, description: str(a.description),
          start: tz ? { dateTime: start, timeZone: tz } : { dateTime: start },
          end: tz ? { dateTime: end, timeZone: tz } : { dateTime: end },
        }),
      });
      return { ok: true, event: { id: e?.id, summary: e?.summary, link: e?.htmlLink } };
    }

    case "post_result": {
      const id = str(a.automation_id);
      const summary = str(a.summary).trim();
      if (!summary) throw new Error("summary is required.");
      const { data: row } = await db.from("agent_automations")
        .select("user_id, id, name, deployment_id, agent_id, status")
        .eq("user_id", userId).eq("id", id).maybeSingle();
      if (!row) throw new Error("No automation with id '" + id + "' on this account.");
      await db.from("agent_automations").update({
        result_text: summary.slice(0, RESULT_MAX_CHARS),
        result_at: new Date().toISOString(),
      }).eq("user_id", userId).eq("id", id);
      // Record what this run has cost so far and apply the monthly cap, so a
      // capped account stops at the run that crossed the line.
      try {
        const client = anthropicClient();
        await syncAutomation(client, db, row);
        await enforceCap(client, db, userId, await isOwnerId(db, userId));
      } catch { /* the result is saved either way; the next list syncs cost */ }
      await writeAutomationsTopic(db, userId);
      return { ok: true };
    }
  }
  throw new Error("Unknown tool '" + name + "'.");
}

/* ---------------- JSON-RPC over HTTP ---------------- */

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function handle(db: SupabaseClient, userId: string, msg: Json): Promise<Json | null> {
  const id = msg.id;
  // A notification has no id and gets no response body.
  if (id === undefined || id === null) return null;
  const method = str(msg.method);
  const params = (msg.params ?? {}) as Json;

  if (method === "initialize") {
    const asked = str(params.protocolVersion);
    return {
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "myProductivitySpace board", version: "1.0" },
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    const name = str(params.name);
    try {
      const out = await callTool(db, userId, name, (params.arguments ?? {}) as Json);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out } };
    } catch (e) {
      // A tool failure is a result the model can read and correct, not a
      // protocol error.
      return {
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: String((e as Error)?.message ?? e) }], isError: true },
      };
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return reply({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Missing bearer token." } }, 401);

  const db = adminClient();
  const { data: acct } = await db.from("agent_accounts").select("user_id")
    .eq("board_token_hash", await sha256Hex(token)).maybeSingle();
  if (!acct) return reply({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unknown token." } }, 401);
  const userId = acct.user_id as string;

  let msg: unknown;
  try { msg = await req.json(); }
  catch { return reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }

  if (Array.isArray(msg)) {
    const outs = (await Promise.all(msg.map((m) => handle(db, userId, m as Json)))).filter(Boolean);
    return outs.length ? reply(outs) : new Response(null, { status: 202 });
  }
  const out = await handle(db, userId, msg as Json);
  return out ? reply(out) : new Response(null, { status: 202 });
});
