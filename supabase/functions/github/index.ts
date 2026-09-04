/* Source-editing proxy for the myProductivitySpace AI sidebar.
 *
 * Why this exists: the board is one static HTML file served off a CDN, so
 * until now the AI could only change it through stored patches, which attach
 * at three named hooks and reach nothing else. Anything outside those hooks
 * got a refusal. This is the other half: the panel can edit the real source
 * file, commit it, and let Netlify and GitHub Pages redeploy.
 *
 * The token never touches the browser. The page calls this with its own
 * Supabase JWT; this function holds a fine-grained GitHub PAT and makes the
 * call. Same shape as the notion function next door, same reasons.
 *
 * WHAT STOPS IT. Straight-to-live means there is no human in the loop on the
 * ordinary path, so the guard here IS the review. Three layers, all fail
 * closed:
 *
 *   1. Only one Supabase user may write, named by GITHUB_ALLOWED_USER_ID.
 *      The board is invite-gated but invited is not the same as "may commit
 *      to my repository", and without this every guest would inherit the
 *      PAT's reach.
 *   2. Protected tokens. Identifiers the owner declared off limits (the
 *      widget chrome, the design tokens, the OAuth config, the patch
 *      runtime). Checked against the lines an edit actually CHANGES, not the
 *      lines it merely quotes -- see changedLines() in guard.ts for why
 *      that distinction is the whole design.
 *   3. Smoke checks on the resulting file. The guard above knows what was
 *      forbidden; it knows nothing about what is correct. These catch the
 *      catastrophic class -- an unbalanced <script>, a file that lost half
 *      its bytes -- because a source commit has none of the crash
 *      protections the patch runtime has, and a dead board is where you
 *      would have gone to fix it.
 *
 * Deploy:
 *   supabase secrets set GITHUB_TOKEN=github_pat_...
 *   supabase secrets set GITHUB_REPO=lucasjung2015-web/myproductivityspace
 *   supabase secrets set GITHUB_ALLOWED_USER_ID=<your auth.users uuid>
 *   supabase functions deploy github
 *
 * The PAT should be fine-grained, scoped to that ONE repository, with
 * Contents: read and write. Nothing else. It does not need Actions, Pages,
 * Workflows or Metadata beyond the default.
 *
 * JWT verification is on by default. Do NOT deploy with --no-verify-jwt.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
/* The fence lives next door so it can be run and checked without Deno or a
   network. It is the only review an ordinary commit gets. */
import { PROTECTED, PROTECTED_PATHS, fenceCheck, smokeCheck } from "./guard.ts";

const GH_API = "https://api.github.com";

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

/* ------------------------------------------------------------------ *
 * GitHub, through the Git Data API
 *
 * Not the Contents API, which is the obvious choice and the wrong one here:
 * it refuses reads over 1 MB and myProductivitySpace.html is over 2 MB. The
 * blob/tree/commit/ref sequence below has no such limit.
 * ------------------------------------------------------------------ */

function ghHeaders(token: string, accept = "application/vnd.github+json") {
  return {
    authorization: "Bearer " + token,
    accept,
    "x-github-api-version": "2022-11-28",
    "user-agent": "myProductivitySpace-ai",
  };
}

async function gh(token: string, path: string, init?: RequestInit) {
  const r = await fetch(GH_API + path, {
    ...init,
    headers: { ...ghHeaders(token), "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) {
    const msg = (body && typeof body === "object" && "message" in body)
      ? String((body as Record<string, unknown>).message)
      : ("HTTP " + r.status);
    throw new Error("GitHub: " + msg);
  }
  return body as Record<string, unknown>;
}

async function headOf(token: string, repo: string, branch: string) {
  const ref = await gh(token, `/repos/${repo}/git/ref/heads/${branch}`);
  const sha = String((ref.object as Record<string, unknown>).sha);
  const commit = await gh(token, `/repos/${repo}/git/commits/${sha}`);
  return { commitSha: sha, treeSha: String((commit.tree as Record<string, unknown>).sha), commit };
}

async function readFileAt(token: string, repo: string, treeSha: string, path: string) {
  /* Walk the tree a segment at a time rather than asking for it recursively:
     recursive=1 on a repo this size returns every entry to find one, and
     truncates silently past its limit, which would read as "the file does
     not exist". */
  const parts = path.split("/").filter(Boolean);
  let tree = treeSha;
  for (let i = 0; i < parts.length; i++) {
    const t = await gh(token, `/repos/${repo}/git/trees/${tree}`);
    const entries = (t.tree as Record<string, unknown>[]) || [];
    const hit = entries.find((e) => String(e.path) === parts[i]);
    if (!hit) return null;
    if (i === parts.length - 1) {
      if (String(hit.type) !== "blob") return null;
      const r = await fetch(`${GH_API}/repos/${repo}/git/blobs/${String(hit.sha)}`, {
        headers: ghHeaders(token, "application/vnd.github.raw"),
      });
      if (!r.ok) throw new Error("GitHub: could not read " + path + " (HTTP " + r.status + ").");
      return { content: await r.text(), sha: String(hit.sha) };
    }
    if (String(hit.type) !== "tree") return null;
    tree = String(hit.sha);
  }
  return null;
}

/* ------------------------------------------------------------------ */

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  const token = Deno.env.get("GITHUB_TOKEN");
  const repo = Deno.env.get("GITHUB_REPO");
  const allowedUser = Deno.env.get("GITHUB_ALLOWED_USER_ID");
  const branch = Deno.env.get("GITHUB_BRANCH") ?? "main";

  // Who is calling. Never taken from the body: one account must not be able
  // to act as another, and here "acting as another" means committing to
  // somebody's repository.
  const authHeader = req.headers.get("authorization") ?? "";
  const anonClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: userData, error: userErr } = await anonClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Not signed in." }, 401, cors);
  const userId = userData.user.id;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* status takes no body */ }
  const action = String(body.action ?? "status");

  const configured = !!(token && repo && allowedUser);
  const mayWrite = configured && userId === allowedUser;

  if (action === "status") {
    let head: string | null = null;
    let lastMessage: string | null = null;
    if (configured) {
      try {
        const h = await headOf(token!, repo!, branch);
        head = h.commitSha;
        lastMessage = String((h.commit as Record<string, unknown>).message ?? "").split("\n")[0];
      } catch { /* reported as an unreachable repo below */ }
    }
    return json({
      configured,
      may_write: mayWrite,
      repo: configured ? repo : null,
      branch,
      head_commit: head,
      last_commit_message: lastMessage,
      reachable: !!head,
      locked: PROTECTED.map((g) => ({ rule: g.rule, why: g.why })),
      locked_paths: PROTECTED_PATHS,
      note: !configured
        ? "Source editing is not configured. Set GITHUB_TOKEN, GITHUB_REPO and GITHUB_ALLOWED_USER_ID."
        : !mayWrite
          ? "This account may read the repository's state but not commit to it."
          : "Ready. A commit reaches the live site about a minute later.",
    }, 200, cors);
  }

  if (!configured) return json({ error: "Source editing is not configured on the server." }, 500, cors);

  /* ---- read: the file as the REPOSITORY has it ----
     Distinct from the panel's read_source, which fetches the deployed page.
     Those disagree for the minute or two a deploy takes, and editing against
     the stale one is how you get an edit that no longer matches. */
  if (action === "read") {
    const path = String(body.path ?? "");
    if (!path) return json({ error: "No path." }, 400, cors);
    try {
      const h = await headOf(token!, repo!, branch);
      const file = await readFileAt(token!, repo!, h.treeSha, path);
      if (!file) return json({ error: 'No file at "' + path + '" on ' + branch + "." }, 404, cors);
      return json({ path, head_commit: h.commitSha, bytes: file.content.length, content: file.content }, 200, cors);
    } catch (e) {
      return json({ error: String((e as Error).message ?? e) }, 502, cors);
    }
  }

  if (action === "commit") {
    if (!mayWrite) return json({ error: "This account may not commit to the repository." }, 403, cors);

    const path = String(body.path ?? "");
    if (!path) return json({ error: "No path." }, 400, cors);
    if (PROTECTED_PATHS.some((p) => path === p || path.startsWith(p))) {
      return json({
        error: 'Refused: "' + path + '" is a locked path.',
        rule: "locked-path",
        why: "server code, CI config and deploy config are outside what the assistant may change",
      }, 403, cors);
    }

    const edits = Array.isArray(body.edits) ? body.edits as Record<string, unknown>[] : [];
    if (!edits.length) return json({ error: "No edits. Pass edits: [{old_string, new_string}]." }, 400, cors);
    if (edits.length > 40) return json({ error: "Too many edits in one commit (40 max)." }, 400, cors);

    const message = String(body.message ?? "").trim();
    if (!message) return json({ error: "No commit message." }, 400, cors);

    try {
      const h = await headOf(token!, repo!, branch);
      const file = await readFileAt(token!, repo!, h.treeSha, path);
      if (!file) return json({ error: 'No file at "' + path + '" on ' + branch + "." }, 404, cors);

      const before = file.content;
      let after = before;
      const applied: { index: number; bytes: number }[] = [];

      for (let i = 0; i < edits.length; i++) {
        const oldStr = String(edits[i].old_string ?? "");
        const newStr = String(edits[i].new_string ?? "");
        if (!oldStr) {
          return json({ error: "Edit " + (i + 1) + " has an empty old_string. Every edit must say what it replaces." }, 400, cors);
        }
        if (oldStr === newStr) {
          return json({ error: "Edit " + (i + 1) + " changes nothing: old_string and new_string are identical." }, 400, cors);
        }

        // The fence runs BEFORE the edit is applied, so a refused commit
        // leaves nothing half-done and the message can name the exact line.
        const refusal = fenceCheck(oldStr, newStr);
        if (refusal) {
          return json({
            error: "Refused by the fence.",
            rule: refusal.rule,
            why: refusal.why,
            token: refusal.token,
            line: refusal.line,
            edit_index: i + 1,
            note: "This edit changes a line the board's owner locked (" + refusal.rule +
              ": " + refusal.why + "). Nothing was committed. You may still build things NEXT to " +
              "locked code as long as the locked lines themselves come through your edit unchanged. " +
              "If the change genuinely needs to touch it, say so plainly and let the owner make it.",
          }, 403, cors);
        }

        const first = after.indexOf(oldStr);
        if (first === -1) {
          return json({
            error: "Edit " + (i + 1) + " did not match anything in " + path + ".",
            note: "The repository's copy differs from what you read, most likely because you read the " +
              "deployed page and a newer commit has not reached the CDN yet. Re-read the file with " +
              "read_source from:'repo' and rebuild the edit against that.",
          }, 409, cors);
        }
        if (after.indexOf(oldStr, first + 1) !== -1) {
          return json({
            error: "Edit " + (i + 1) + " matched more than once in " + path + ".",
            note: "Include more surrounding context in old_string so it identifies exactly one place.",
          }, 409, cors);
        }
        after = after.slice(0, first) + newStr + after.slice(first + oldStr.length);
        applied.push({ index: i + 1, bytes: newStr.length - oldStr.length });
      }

      const smoke = smokeCheck(path, before, after);
      if (smoke) {
        return json({ error: "Refused by the smoke check.", rule: "smoke", note: smoke }, 422, cors);
      }

      // blob -> tree -> commit -> ref. The ref update is not forced, so a
      // commit that landed in between fails here rather than erasing it.
      const blob = await gh(token!, `/repos/${repo}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: after, encoding: "utf-8" }),
      });
      const tree = await gh(token!, `/repos/${repo}/git/trees`, {
        method: "POST",
        body: JSON.stringify({
          base_tree: h.treeSha,
          tree: [{ path, mode: "100644", type: "blob", sha: String(blob.sha) }],
        }),
      });
      /* Revert-With goes in the message on purpose. When a commit breaks the
         board, the board is not available to look anything up in -- the
         parent SHA has to be readable from the phone, in the commit itself. */
      const full = message + "\n\nRevert-With: git revert " + h.commitSha.slice(0, 12) +
        "..HEAD\nCommitted by the myProductivitySpace assistant.";
      const commit = await gh(token!, `/repos/${repo}/git/commits`, {
        method: "POST",
        body: JSON.stringify({ message: full, tree: String(tree.sha), parents: [h.commitSha] }),
      });
      await gh(token!, `/repos/${repo}/git/refs/heads/${branch}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: String(commit.sha), force: false }),
      });

      return json({
        ok: true,
        commit: String(commit.sha),
        short: String(commit.sha).slice(0, 7),
        parent: h.commitSha,
        path,
        edits_applied: applied.length,
        bytes_before: before.length,
        bytes_after: after.length,
        note: "Committed to " + branch + ". Netlify and GitHub Pages rebuild from this, so it is " +
          "live in roughly a minute; the board must be reloaded to pick it up. To undo: " +
          "git revert " + h.commitSha.slice(0, 12) + "..HEAD, or revert the commit on github.com.",
      }, 200, cors);
    } catch (e) {
      return json({ error: String((e as Error).message ?? e) }, 502, cors);
    }
  }

  return json({ error: 'Unknown action "' + action + '".' }, 400, cors);
});
