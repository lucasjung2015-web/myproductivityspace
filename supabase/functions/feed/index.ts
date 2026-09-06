/* Digest ingest for the myProductivitySpace board.
 *
 * Why this exists: the three scheduled Claude Code routines (morning news,
 * portfolio summary, email assistant) run in Anthropic's cloud and post their
 * output to Telegram. Telegram is a fine phone notification and a dead end as
 * a data source -- a bot cannot read its own outgoing messages back through
 * getUpdates -- so nothing the routines produce was reachable from the board.
 * This is the other end of that: a routine posts its digest here, this writes
 * it into the board's existing topic system, and a widget reads it.
 *
 * WHY A TOPIC AND NOT A NEW TABLE. The board already has labelled boxes that
 * widgets may be granted read access to (see "topics" in myProductivitySpace
 * .html). They are two rows in the kv table -- cw-topic:<name> holding
 * {value, at, from}, and cw-topic:__index listing the names. Writing into
 * that costs no schema change, no new sync path, and no widget permission
 * that does not already exist. The widgets that read these need no network
 * access and hold no credentials.
 *
 * WHAT STOPS IT. This is called by an unattended routine, so the caller is a
 * shared secret rather than a signed-in user, and a shared secret in three
 * routine configs is a secret with three chances to leak. So it is scoped as
 * narrowly as the job allows:
 *
 *   1. FEED_SECRET must match, compared in constant time so a wrong guess
 *      leaks nothing through timing.
 *   2. The topic name must be a valid topic name. Note what is NOT relied on
 *      here: the key written is always "cw-topic:" + name, built by string
 *      concatenation, so there is no name that produces the key
 *      "dynamic-widgets" or any other board key. The kv table holds every
 *      page, note, widget definition and setting on the board, and none of
 *      them are reachable from this function at all -- not because a list
 *      forbids them, but because the key it writes cannot spell them.
 *      The pattern below adds the two things that construction does not
 *      give for free: it forbids underscores, which is what keeps
 *      "cw-topic:__index" (the index of topic names) unwritable, and it
 *      caps the length. It is copied verbatim from TOPIC_RE in
 *      myProductivitySpace.html, so a name accepted here is always a name
 *      the board will actually load -- a divergent rule would let a digest
 *      be stored successfully and then never appear, with both halves
 *      reporting success.
 *      This started as a three-name whitelist. That meant every new
 *      routine-fed widget needed this file edited and redeployed, and
 *      supabase/ is on the board assistant's locked-paths list, so the one
 *      thing that could otherwise build the widget end to end was shut out
 *      of the only step that was left. The cost of the swap is that a leaked
 *      secret can now scribble on any topic box rather than three. It still
 *      reaches no board data, no other key, and no other user.
 *   3. One user, named by FEED_USER_ID. Never taken from the body.
 *   4. 64KB per value, matching MAX_VALUE in the board's own topic code.
 *      A larger value would be written here and silently ignored there.
 *
 * Deploy:
 *   supabase secrets set FEED_SECRET=<a long random string>
 *   supabase secrets set FEED_USER_ID=<your auth.users uuid>
 *   supabase functions deploy feed --no-verify-jwt
 *
 * --no-verify-jwt is REQUIRED here and is the one place in this project it is
 * correct. The caller is a cron job with no Supabase session; the secret above
 * is the authentication. Every other function in this project takes a real
 * user JWT and must keep verifying it.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

/* Verbatim from TOPIC_RE in myProductivitySpace.html: lowercase letters,
   digits and hyphens, 2-40 characters, starting and ending alphanumeric.
   Underscores are excluded, which is what puts "cw-topic:__index" out of
   reach. Keep this identical to the board's copy. */
const TOPIC_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// Mirrors MAX_VALUE in the board's topic code. Kept in sync by hand, because
// a value over this is accepted here and then dropped there, which looks like
// a routine that ran and produced nothing.
const MAX_VALUE = 64 * 1024;

const TOPIC_KEY = (n: string) => "cw-topic:" + n;
const TOPIC_INDEX = "cw-topic:__index";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/* Constant time, so the number of correct leading characters is not
   observable in the response latency. Length is compared first and the
   comparison still runs to completion, because bailing early on a length
   mismatch is itself a timing signal. */
function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("FEED_SECRET");
  const userId = Deno.env.get("FEED_USER_ID");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const url = Deno.env.get("SUPABASE_URL");
  if (!secret || !userId || !serviceKey || !url) {
    return json({ error: "Feed ingest is not configured. Set FEED_SECRET and FEED_USER_ID." }, 500);
  }

  const given = req.headers.get("x-feed-secret") ?? "";
  if (!secretsMatch(given, secret)) return json({ error: "Bad secret." }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Body must be JSON." }, 400); }

  const topic = String(body.topic ?? "");
  if (!TOPIC_RE.test(topic)) {
    return json({ error: "Topic names are lowercase letters, digits and hyphens, " +
                         "2-40 characters, starting and ending with a letter or digit." }, 400);
  }

  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim() && body.data == null) {
    return json({ error: "Nothing to store: send `text`, `data`, or both." }, 400);
  }

  /* Stored as ONE JSON string because that is what a topic value is: the
     board's own publish path stringifies anything that is not already a
     string. The widget parses this back out; `at` it reads off the topic
     entry rather than from in here, so there is one clock and it is the
     one the board recorded. */
  const value = JSON.stringify({ text: text, data: body.data ?? null });
  if (value.length > MAX_VALUE) {
    return json({
      error: "Too large (" + value.length + " bytes; " + MAX_VALUE + " max). " +
             "Trim the digest or drop the raw text and send only `data`.",
    }, 413);
  }

  const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

  const entry = { value: value, at: new Date().toISOString(), from: "routine" };
  const wrote = await sb.from("kv").upsert(
    { user_id: userId, key: TOPIC_KEY(topic), value: JSON.stringify(entry), writer: "routine" },
    { onConflict: "user_id,key" },
  );
  if (wrote.error) return json({ error: wrote.error.message }, 500);

  /* The index tells the board which topic rows to load at boot. Read first
     and write only when this name is genuinely missing, which is once per
     topic ever: two routines firing in the same minute would otherwise
     read-modify-write over each other, and after the first run there is
     nothing left to race over. */
  const idx = await sb.from("kv").select("value")
    .eq("user_id", userId).eq("key", TOPIC_INDEX).maybeSingle();
  let names: string[] = [];
  try { names = JSON.parse(idx.data?.value ?? "[]") || []; } catch { names = []; }
  if (!names.includes(topic)) {
    names.push(topic);
    await sb.from("kv").upsert(
      { user_id: userId, key: TOPIC_INDEX, value: JSON.stringify(names), writer: "routine" },
      { onConflict: "user_id,key" },
    );
  }

  return json({ ok: true, topic: topic, at: entry.at, bytes: value.length });
});
