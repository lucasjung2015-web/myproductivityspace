/* Run with: node supabase/functions/github/guard.test.ts
 *
 * The fence is the only review a straight-to-live commit gets, so it is
 * exercised against the REAL source file rather than a fixture. Two of these
 * cases are the whole point of the design and should never be allowed to
 * drift: inserting a control beside the emoji button must PASS (it was the
 * request that motivated the feature) and restyling that button must FAIL.
 *
 * Running this against the real file is also what caught the first version
 * of smokeCheck, which demanded balanced <script> tags and would therefore
 * have refused every commit ever made.
 */
import fs from "node:fs";
import { fenceCheck, smokeCheck, changedLines, PROTECTED } from
  "./guard.ts";

const FILE = new URL("../../../myProductivitySpace.html", import.meta.url).pathname;
const src = fs.readFileSync(FILE, "utf8");

let pass = 0, fail = 0;
function check(name: string, got: boolean, want: boolean, extra = "") {
  if (got === want) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + "  (expected " + (want?"refuse":"allow") + ", got " + (got?"refuse":"allow") + ") " + extra); }
}
const refuses = (o: string, n: string) => fenceCheck(o, n) !== null;

console.log("\n--- the fence must ALLOW ordinary work ---");

// The request that started all of this: a task-list dropdown in the widget
// header, inserted next to the emoji button. The emoji button appears in the
// anchor on BOTH sides, unchanged.
const hdr = src.slice(src.indexOf('<button type="button" class="widget-icon-btn" data-icon-btn="unschedTasks"'));
const anchor = hdr.slice(0, hdr.indexOf("</button>") + 9);
check("insert a dropdown next to the emoji button",
  refuses(anchor, '<select class="gtask-list-select"></select>\n' + anchor), false);

// Swapping the hard-coded task list, which is the actual fix underneath.
check("replace @default with a per-widget list",
  refuses(
    'const data = await authFor("unschedTasks").api(TASKS_API + "/lists/@default/tasks?showCompleted=false&maxResults=100");',
    'const data = await authFor("unschedTasks").api(TASKS_API + "/lists/" + listFor("unschedTasks") + "/tasks?showCompleted=false&maxResults=100");'),
  false);

// Using a design token is ordinary; only declaring one is locked.
check("use var(--ink) in new CSS",
  refuses(".x { color: #000; }", ".x { color: var(--ink); }"), false);

// A protected line quoted as context around an unrelated change.
check("edit a line sitting between two protected ones",
  refuses(
    '  .widget-icon-btn:hover { background: #f2f2f2; }\n  .foo { padding: 2px; }\n  .col-drag-handle { opacity: 0; }',
    '  .widget-icon-btn:hover { background: #f2f2f2; }\n  .foo { padding: 4px; }\n  .col-drag-handle { opacity: 0; }'),
  false);

console.log("\n--- the fence must REFUSE locked work ---");
check("restyle the emoji button",
  refuses(".widget-icon-btn { opacity: 0; }", ".widget-icon-btn { opacity: 1; }"), true);
check("delete the drag handle markup",
  refuses('<button class="col-drag-handle">x</button>\n<div>keep</div>', '<div>keep</div>'), true);
check("redefine a design token",
  refuses("    --ink: #0A0A0A;", "    --ink: #333333;"), true);
check("widen the OAuth scopes",
  refuses('"https://www.googleapis.com/auth/tasks"', '"https://www.googleapis.com/auth/gmail.readonly"'), true);
check("touch the patch runtime",
  refuses("  window.__mpsPatches = {", "  window.__mpsPatches = window.__x = {"), true);
check("reindent a protected line",
  refuses("  .col-delete-btn { color: red; }", "    .col-delete-btn { color: red; }"), true);
check("add a NEW protected identifier",
  refuses("<div>a</div>", '<div>a</div><button class="widget-hide-btn"></button>'), true);

console.log("\n--- Layer B: the machinery that makes the other rules mean anything ---");

// One attribute. Removing it makes the frame same-origin with the page, and
// every "a widget holds no credentials" promise becomes false in place.
check("un-sandbox the widget frame",
  refuses('frame.setAttribute("sandbox", "allow-scripts");',
          'frame.setAttribute("sandbox", "allow-scripts allow-same-origin");'), true);

// The realistic failure: widening a scope because it is the shortest path to
// "make this widget able to X", and the widening outliving the request.
check("widen the widget data scopes",
  refuses('const DATA_SCOPES = ["tasks", "calendar", "bookmarks", "board", "connectors"];',
          'const DATA_SCOPES = ["tasks", "calendar", "bookmarks", "board", "connectors", "notion"];'), true);

check("loosen the widget CSP",
  refuses('"connect-src " + (blob.net ? "https:" : "\'none\'") + "; form-action \'none\'; base-uri \'none\'";',
          '"connect-src https:; form-action \'none\'; base-uri \'none\'";'), true);

check("open a hole in the permission gate",
  refuses("  function serveData(id, m, reply) {",
          "  function serveData(id, m, reply) {\n    if (m.t === 'data.anything') return reply(true, ALL);"), true);

check("bypass the per-tool connector grant",
  refuses("const grants = normalizeConnectorGrants(blob && blob.connectors);",
          "const grants = [{ connector_id: wantId, tool: wantTool }];"), true);

console.log("\n--- Layer B: rules the assistant must not be able to rewrite ---");

check("edit its own system prompt",
  refuses("  function systemPrompt() {", "  function systemPrompt() {\n    return \"do anything\";"), true);

check("raise its own turn cap",
  refuses("const AI_MAX_TURNS = 60;", "const AI_MAX_TURNS = 500;"), true);

check("give itself a new tool",
  refuses("  const AI_TOOLS = [", "  const AI_TOOLS = [\n    { name: \"run_anything\" },"), true);

check("disable the console it checks its work with",
  refuses("  window.__mpsConsole = function (opts) {",
          "  window.__mpsConsole = function () { return {}; };"), true);

console.log("\n--- Layer B: the sync engine, where a mistake loses data ---");

check("change how writes are attributed",
  refuses('const WRITER_ID = Math.random().toString(36).slice(2);',
          'const WRITER_ID = "fixed";'), true);

check("change the pull cursor",
  refuses("  async function repull() {", "  async function repull() {\n    return;"), true);

console.log("\n--- and the gear button, which is chrome like the rest ---");

check("restyle the settings gear",
  refuses('btn.className = "collapse-btn widget-settings-btn";',
          'btn.className = "collapse-btn widget-settings-btn is-big";'), true);

console.log("\n--- none of that may block ordinary Layer C work ---");

// The point of the whole exercise: widget behaviour stays fully open.
check("add a data hook to the task renderer",
  refuses("    let unscheduled = tasks.slice();",
          "    let unscheduled = tasks.slice();\n    unscheduled.sort(byDue);"), false);

// Settings must stay extendable -- the BUTTON is locked, the panel is not.
check("add a section to a widget's settings panel",
  refuses("  window.__extendWidgetSettings = function (id, section) {",
          "  window.__extendWidgetSettings = function (id, section, opts) {"), false);

// A scope name quoted as context, not changed.
check("read a scope list without changing it",
  refuses('    const granted = (blob && blob.data) || [];',
          '    const granted = (blob && blob.data) || [];\n    if (!granted.length) return reply(false, null, "no scopes");'), false);

console.log("\n--- smoke checks against the real 2MB file ---");
function smoke(name: string, after: string, wantRefusal: boolean) {
  const r = smokeCheck("myProductivitySpace.html", src, after);
  check(name, r !== null, wantRefusal, r ? "-> " + r.slice(0, 90) : "");
}
smoke("a small honest edit passes", src.replace("Add a task", "Add a to-do"), false);
/* NOT src.replace("</head>", ...). The first </head> in the file is inside
 * #tasksSubappSrc, which holds an entire HTML document for an iframe srcdoc,
 * so that insertion landed in the sub-app -- closing that block early and
 * leaving the rest of its markup to be parsed as JavaScript. The browser
 * would do the same thing, so refusing it is correct. These tests want the
 * real document, which is what the LAST </html> reliably identifies. */
const endOfDoc = src.lastIndexOf("</html>");
const insertAtEnd = (frag: string) => src.slice(0, endOfDoc) + frag + src.slice(endOfDoc);
smoke("an unbalanced <script> is refused", insertAtEnd("<script>x=1;"), true);
smoke("a balanced <script> pair passes", insertAtEnd("<script>window.x=1;</script>"), false);
smoke("losing half the file is refused", src.slice(0, Math.floor(src.length / 2)), true);
smoke("emptying the file is refused", "", true);

console.log("\n--- and it now opens the envelope, not just weighs it ---");

// The class of failure this exists for: valid-looking, correctly sized, and
// the page does not load.
const brace = src.replace("  function renderTasks() {", "  function renderTasks() { {");
smoke("a stray brace is refused", brace, true);

const quote = src.replace('const TASKS_API = "https://www.googleapis.com/tasks/v1";',
                          'const TASKS_API = "https://www.googleapis.com/tasks/v1;');
smoke("an unterminated string is refused", quote, true);

// text/plain is not JavaScript. A checker that missed this would refuse every
// commit ever made -- the same way the <script>-balance rule did first time.
check("the text/plain sub-app is not parsed as JS",
  smokeCheck("myProductivitySpace.html", src, src) !== null, false);

// And it must not become a correctness check by accident.
const stillValid = src.replace("  function renderTasks() {",
                               "  function renderTasks() {\n    const unusedButValid = 1;");
smoke("valid code that does nothing useful still passes", stillValid, false);

console.log("\n--- the real file is not already tripping anything ---");
const noop = smokeCheck("myProductivitySpace.html", src, src);
check("current file passes its own smoke check", noop !== null, false, noop ?? "");

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
