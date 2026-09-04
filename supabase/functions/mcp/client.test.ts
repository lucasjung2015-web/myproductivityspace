/* Run with: node supabase/functions/mcp/client.test.ts
 *
 * Every case here is a rule from the 2026-07-28 spec rather than a guess at
 * what seemed reasonable: the Value Encoding table, the x-mcp-header
 * constraints, the header/body match the server rejects with -32020, and the
 * SSE comment lines a client MUST ignore. A server enforces all of these, so
 * getting one wrong shows up as a 400 nobody can read.
 */
import {
  encodeHeaderValue, validateHeaderAnnotations, paramHeaders,
  buildRequest, parseSse, shapeToolResult, shapeToolList, checkUrl,
} from "./client.ts";

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + "\n         got  " + JSON.stringify(got) + "\n         want " + JSON.stringify(want)); }
}

console.log("\n--- header value encoding (spec: Value Encoding) ---");
eq("plain ascii passes through", encodeHeaderValue("us-west1"), "us-west1");
eq("non-ascii is base64 sentinel", encodeHeaderValue("Hello, 世界"), "=?base64?SGVsbG8sIOS4lueVjA==?=");
eq("leading/trailing space encoded", encodeHeaderValue(" padded "), "=?base64?IHBhZGRlZCA=?=");
eq("newline encoded", encodeHeaderValue("line1\nline2"), "=?base64?bGluZTEKbGluZTI=?=");
eq("a literal that looks like the sentinel is encoded",
   encodeHeaderValue("=?base64?literal?="), "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");

console.log("\n--- x-mcp-header validation ---");
const good = { type: "object", properties: {
  region: { type: "string", "x-mcp-header": "Region" },
  query:  { type: "string" } } };
eq("a legal annotation validates", validateHeaderAnnotations(good), null);
eq("empty name rejected",
   validateHeaderAnnotations({ type:"object", properties:{ a:{ type:"string", "x-mcp-header":"" } } }),
   "x-mcp-header is empty");
eq("number type rejected",
   validateHeaderAnnotations({ type:"object", properties:{ a:{ type:"number", "x-mcp-header":"A" } } }),
   'x-mcp-header "A" is on a number property; only string, integer and boolean may be mirrored');
eq("duplicate name rejected (case-insensitive)",
   validateHeaderAnnotations({ type:"object", properties:{
     a:{ type:"string", "x-mcp-header":"Tenant" }, b:{ type:"string", "x-mcp-header":"tenant" } } }),
   'x-mcp-header "tenant" is used twice');
eq("illegal token character rejected",
   validateHeaderAnnotations({ type:"object", properties:{ a:{ type:"string", "x-mcp-header":"Bad Header" } } }),
   'x-mcp-header "Bad Header" is not a valid header token');
// Reachability: an annotation under `items` is not statically reachable.
eq("annotation inside array items is ignored, not honoured",
   paramHeaders({ type:"object", properties:{ xs:{ type:"array", items:{ type:"object",
     properties:{ a:{ type:"string", "x-mcp-header":"Nope" } } } } } }, { xs: [{ a: "v" }] }),
   {});

console.log("\n--- param header mirroring ---");
eq("value mirrored", paramHeaders(good, { region: "us-west1", query: "SELECT 1" }),
   { "Mcp-Param-Region": "us-west1" });
eq("absent value omits the header", paramHeaders(good, { query: "SELECT 1" }), {});
eq("null value omits the header", paramHeaders(good, { region: null }), {});
eq("boolean lowercased",
   paramHeaders({ type:"object", properties:{ live:{ type:"boolean", "x-mcp-header":"Live" } } }, { live: false }),
   { "Mcp-Param-Live": "false" });
eq("nested object property is reachable",
   paramHeaders({ type:"object", properties:{ opts:{ type:"object", properties:{
     t:{ type:"string", "x-mcp-header":"Tenant" } } } } }, { opts: { t: "acme" } }),
   { "Mcp-Param-Tenant": "acme" });

console.log("\n--- request construction ---");
const req = buildRequest({ id: 4, method: "tools/call", name: "get_quote",
  args: { symbol: "MSFT" }, inputSchema: { type:"object", properties:{ symbol:{ type:"string" } } },
  token: "tok" });
eq("Mcp-Method set", req.headers["Mcp-Method"], "tools/call");
eq("Mcp-Name set", req.headers["Mcp-Name"], "get_quote");
eq("protocol version header", req.headers["MCP-Protocol-Version"], "2026-07-28");
eq("accepts both content types", req.headers["accept"], "application/json, text/event-stream");
eq("bearer token attached", req.headers["authorization"], "Bearer tok");
const parsed = JSON.parse(req.body);
eq("header matches body name (server rejects -32020 otherwise)",
   req.headers["Mcp-Name"], parsed.params.name);
eq("_meta protocol version matches the header",
   parsed.params._meta["io.modelcontextprotocol/protocolVersion"], req.headers["MCP-Protocol-Version"]);
eq("clientCapabilities present", parsed.params._meta["io.modelcontextprotocol/clientCapabilities"], {});
eq("no token means no auth header",
   buildRequest({ id:1, method:"tools/list" }).headers["authorization"], undefined);
eq("tools/list sends no Mcp-Name",
   buildRequest({ id:1, method:"tools/list" }).headers["Mcp-Name"], undefined);

console.log("\n--- SSE framing ---");
eq("final response picked out of a stream", parseSse(
  ": keep-alive\n\n" +
  'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"p":1}}\n\n' +
  'data: {"jsonrpc":"2.0","id":2,"result":{"resultType":"complete","content":[]}}\n\n'
), { jsonrpc: "2.0", id: 2, result: { resultType: "complete", content: [] } });
eq("multi-line data joined", parseSse('data: {"jsonrpc":"2.0","id":1,\ndata: "result":{"ok":true}}\n\n'),
   { jsonrpc: "2.0", id: 1, result: { ok: true } });
eq("comment-only stream yields nothing", parseSse(":\n\n:\n\n"), null);
eq("error response is picked up too", parseSse('data: {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"nope"}}\n\n'),
   { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nope" } });

console.log("\n--- result shaping ---");
eq("structured content preferred, text kept",
   shapeToolResult({ resultType:"complete", content:[{type:"text",text:"72F"}], structuredContent:{ t:72 } }),
   { is_error:false, data:{ t:72 }, text:"72F" });
eq("isError carried", shapeToolResult({ content:[{type:"text",text:"bad date"}], isError:true }),
   { is_error:true, text:"bad date" });
eq("image content named, not inlined",
   shapeToolResult({ content:[{type:"image",data:"AAAA",mimeType:"image/png"}] }),
   { is_error:false, attachments:["image content (not shown)"] });
eq("empty result says so", shapeToolResult({ content:[] }), { is_error:false, text:"(the tool returned nothing)" });

console.log("\n--- tool list shaping ---");
const listed = shapeToolList({ tools: [
  { name:"ok_tool", description:"fine", inputSchema:{ type:"object" } },
  { name:"bad_tool", description:"x", inputSchema:{ type:"object", properties:{ a:{ type:"number","x-mcp-header":"A" } } } },
]});
eq("legal tool kept", listed.tools.map(t=>t.name), ["ok_tool"]);
eq("illegal tool excluded with a reason", listed.rejected.map(r=>r.name), ["bad_tool"]);
eq("a long description is truncated",
   shapeToolList({ tools:[{ name:"t", description:"x".repeat(900), inputSchema:{type:"object"} }] }).tools[0].description.length,
   600);

console.log("\n--- url guard ---");
eq("https public url allowed", checkUrl("https://mcp.example.com/mcp"), null);
eq("http refused", checkUrl("http://mcp.example.com/mcp"), "The server URL must be https.");
eq("localhost refused", checkUrl("https://localhost/mcp"),
   "A server on localhost is not reachable from the board's backend.");
eq("private range refused", checkUrl("https://192.168.1.4/mcp"), "Private network addresses are not allowed.");
eq("172.16/12 refused", checkUrl("https://172.20.0.1/mcp"), "Private network addresses are not allowed.");
eq("172.32 is public and allowed", checkUrl("https://172.32.0.1/mcp"), null);
eq("garbage refused", checkUrl("not a url"), "That is not a valid URL.");

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
