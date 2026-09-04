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

console.log("\n--- smoke checks against the real 2MB file ---");
function smoke(name: string, after: string, wantRefusal: boolean) {
  const r = smokeCheck("myProductivitySpace.html", src, after);
  check(name, r !== null, wantRefusal, r ? "-> " + r.slice(0, 90) : "");
}
smoke("a small honest edit passes", src.replace("Add a task", "Add a to-do"), false);
smoke("an unbalanced <script> is refused", src.replace("</head>", "<script>x=1;</head>"), true);
smoke("a balanced <script> pair passes", src.replace("</head>", "<script>window.x=1;</script></head>"), false);
smoke("losing half the file is refused", src.slice(0, Math.floor(src.length / 2)), true);
smoke("emptying the file is refused", "", true);

console.log("\n--- the real file is not already tripping anything ---");
const noop = smokeCheck("myProductivitySpace.html", src, src);
check("current file passes its own smoke check", noop !== null, false, noop ?? "");

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
