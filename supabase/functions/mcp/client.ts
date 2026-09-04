/* A minimal MCP client, protocol revision 2026-07-28.
 *
 * Its own module, with no Deno APIs and no network, so the fiddly half --
 * header construction, value encoding, SSE framing, result shaping -- can be
 * run and checked. Everything here is a pure function of its inputs; the
 * fetch lives in index.ts.
 *
 * WHY THIS IS SMALL. The 2026-07-28 revision removed protocol-level sessions
 * and the `initialize` handshake, and removed the standalone GET stream. A
 * conforming client for tools is now: POST one JSON-RPC request, send five
 * headers, accept either a JSON object or an SSE stream back. There is no
 * connection to establish, nothing to keep alive, and no state to lose.
 *
 * WHAT IS DELIBERATELY MISSING. Resources, prompts, subscriptions/listen,
 * elicitation and OAuth. Tools are the whole of what the board needs, and
 * each of the others is a surface that would have to be understood before it
 * could be trusted. Bearer tokens cover the servers worth adding first.
 */

export const PROTOCOL_VERSION = "2026-07-28";
const CLIENT_INFO = { name: "myProductivitySpace", version: "1.0" };

/* Spec 2026-07-28, Value Encoding. Header values must be visible ASCII, so a
   value that is not gets carried in a sentinel-wrapped Base64 form. The rule
   also applies to a plain-ASCII value that happens to LOOK like the sentinel,
   or a server could not tell an encoded value from a literal one. */
const SENTINEL = /^=\?base64\?.*\?=$/;
export function encodeHeaderValue(raw: string): string {
  const s = String(raw);
  const plain = /^[\x20-\x7E]*$/.test(s) &&
    s === s.trim() &&
    !SENTINEL.test(s);
  if (plain) return s;
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return "=?base64?" + btoa(bin) + "?=";
}

/* Spec: x-mcp-header. A server may ask that certain tool arguments be
   mirrored into HTTP headers so proxies can route without reading the body,
   and clients MUST honour it. Only properties reachable from the schema root
   through a chain of `properties` keys count -- not through items, $ref, or
   any composition keyword -- so this walks that chain and nothing else.

   A tool whose annotations break the rules MUST be excluded from tools/list
   rather than called, which is what validateHeaderAnnotations is for: one
   malformed tool must not take the others down with it. */
type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function collectHeaderAnnotations(
  schema: unknown,
  path: string[] = [],
  out: { name: string; path: string[]; type: string }[] = [],
): { name: string; path: string[]; type: string }[] {
  if (!isObj(schema)) return out;
  const props = schema.properties;
  if (!isObj(props)) return out;
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (!isObj(p)) continue;
    const here = path.concat(key);
    if (typeof p["x-mcp-header"] === "string") {
      out.push({ name: p["x-mcp-header"] as string, path: here, type: String(p.type ?? "") });
    }
    // Recurse only through nested object `properties`; any other keyword
    // makes the property not statically reachable and its annotation invalid.
    collectHeaderAnnotations(p, here, out);
  }
  return out;
}

/** null when the tool's annotations are legal, else why it must be excluded. */
export function validateHeaderAnnotations(schema: unknown): string | null {
  const found = collectHeaderAnnotations(schema);
  const seen = new Set<string>();
  for (const a of found) {
    if (!a.name) return "x-mcp-header is empty";
    if (!TCHAR.test(a.name)) return 'x-mcp-header "' + a.name + '" is not a valid header token';
    if (/[\r\n]/.test(a.name)) return "x-mcp-header contains a control character";
    const lower = a.name.toLowerCase();
    if (seen.has(lower)) return 'x-mcp-header "' + a.name + '" is used twice';
    seen.add(lower);
    // number is excluded by the spec; only integer, string and boolean carry.
    if (["string", "integer", "boolean"].indexOf(a.type) === -1) {
      return 'x-mcp-header "' + a.name + '" is on a ' + (a.type || "typeless") +
        " property; only string, integer and boolean may be mirrored";
    }
  }
  return null;
}

function valueAt(args: unknown, path: string[]): unknown {
  let cur: unknown = args;
  for (const seg of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function paramHeaders(schema: unknown, args: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of collectHeaderAnnotations(schema)) {
    const v = valueAt(args, a.path);
    // Spec: omit the header when the value is absent or null. A server MUST
    // NOT then expect it, so sending an empty one would be the mismatch.
    if (v == null) continue;
    const s = typeof v === "boolean" ? (v ? "true" : "false") : String(v);
    out["Mcp-Param-" + a.name] = encodeHeaderValue(s);
  }
  return out;
}

/* One JSON-RPC request, plus the headers that must accompany it. `name` is
   params.name for tools/call and is what the Mcp-Name header mirrors; the
   server rejects a mismatch between the two with -32020. */
export function buildRequest(opts: {
  id: number;
  method: string;
  name?: string;
  args?: unknown;
  inputSchema?: unknown;
  token?: string | null;
}): { headers: Record<string, string>; body: string } {
  const params: Json = {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
  if (opts.name != null) params.name = opts.name;
  if (opts.args !== undefined) params.arguments = opts.args;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    // Both, always: the server chooses per request which to send back and the
    // client MUST support either.
    "accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
    "Mcp-Method": opts.method,
  };
  if (opts.name != null) headers["Mcp-Name"] = encodeHeaderValue(opts.name);
  if (opts.token) headers["authorization"] = "Bearer " + opts.token;
  if (opts.inputSchema && opts.args !== undefined) {
    Object.assign(headers, paramHeaders(opts.inputSchema, opts.args));
  }

  return {
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: opts.id, method: opts.method, params }),
  };
}

/* Pull the final JSON-RPC response out of an SSE body.
 *
 * A server may answer a request with a stream that carries progress
 * notifications first and the response last. Only the response matters here:
 * the board has nowhere to show a progress notification, and the spec says
 * the final response SHOULD terminate the stream. Lines beginning with a
 * colon are SSE comments (used as keep-alives) and MUST be ignored. */
export function parseSse(text: string): Json | null {
  let last: Json | null = null;
  for (const chunk of String(text).split(/\r?\n\r?\n/)) {
    const data: string[] = [];
    for (const line of chunk.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i === -1 ? line : line.slice(0, i);
      const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "data") data.push(value);
    }
    if (!data.length) continue;
    try {
      const msg = JSON.parse(data.join("\n"));
      // A notification has no id and is not what we are waiting for.
      if (isObj(msg) && ("result" in msg || "error" in msg)) last = msg;
    } catch { /* a partial or non-JSON frame is not the response */ }
  }
  return last;
}

/* Flatten a tool result into something worth putting in front of a model or a
   widget. structuredContent is preferred when present because it is typed;
   otherwise the text blocks are joined. Non-text content is named rather than
   inlined -- a base64 image in a tool result would blow out the context
   window for no benefit the board can currently use. */
export function shapeToolResult(result: Json): Json {
  const out: Json = { is_error: !!result.isError };
  if ("structuredContent" in result) out.data = result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  const texts: string[] = [];
  const other: string[] = [];
  for (const c of content) {
    if (!isObj(c)) continue;
    if (c.type === "text" && typeof c.text === "string") texts.push(c.text);
    else if (c.type === "resource_link") other.push("resource_link: " + String(c.uri ?? ""));
    else other.push(String(c.type ?? "unknown") + " content (not shown)");
  }
  if (texts.length) out.text = texts.join("\n");
  if (other.length) out.attachments = other;
  if (!texts.length && !("data" in out) && !other.length) out.text = "(the tool returned nothing)";
  return out;
}

/* Reduce a tools/list payload to what the board stores and shows. Tools whose
   header annotations are illegal are dropped with a reason rather than kept
   and failed at call time. */
export function shapeToolList(result: Json): {
  tools: { name: string; title: string; description: string; inputSchema: unknown }[];
  rejected: { name: string; reason: string }[];
} {
  const tools: { name: string; title: string; description: string; inputSchema: unknown }[] = [];
  const rejected: { name: string; reason: string }[] = [];
  const raw = Array.isArray(result.tools) ? result.tools : [];
  for (const t of raw) {
    if (!isObj(t) || typeof t.name !== "string") continue;
    const bad = validateHeaderAnnotations(t.inputSchema);
    if (bad) { rejected.push({ name: t.name, reason: bad }); continue; }
    tools.push({
      name: t.name,
      title: typeof t.title === "string" ? t.title : "",
      // Truncated on the way in. A description is text the SERVER wrote, and
      // it ends up in front of a model; an unbounded one is both a context
      // cost and a bigger canvas for an injection attempt.
      description: typeof t.description === "string" ? t.description.slice(0, 600) : "",
      inputSchema: isObj(t.inputSchema) ? t.inputSchema : { type: "object" },
    });
  }
  return { tools, rejected };
}

/** A URL the board is willing to POST to. */
export function checkUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(String(raw)); } catch { return "That is not a valid URL."; }
  if (u.protocol !== "https:") return "The server URL must be https.";
  const host = u.hostname.toLowerCase();
  /* No loopback or link-local. This function runs on Supabase's network, not
     the user's, so "localhost" here would mean Supabase's own localhost --
     it could never reach a server on the user's machine, and asking for it
     only points the request somewhere internal. */
  if (host === "localhost" || host === "[::1]" || host.endsWith(".localhost")) {
    return "A server on localhost is not reachable from the board's backend.";
  }
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return "Private network addresses are not allowed.";
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return "Private network addresses are not allowed.";
  return null;
}
