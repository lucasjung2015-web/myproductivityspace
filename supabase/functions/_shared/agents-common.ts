/* Shared by the agents and board-mcp functions.
 *
 * Three things both of them need and must agree on:
 *
 *   1. The Anthropic client, built from ANTHROPIC_API_KEY (the same secret the
 *      ai function already uses).
 *   2. The spend ledger and the monthly cap. Every agent run is a session with
 *      a list cost; agent_runs records it per session so a month's spend is
 *      one sum. The owner (allowed_emails.note = 'owner') has no monthly cap;
 *      everyone else stops at AGENT_MONTHLY_CAP_CENTS.
 *   3. The "automations" topic. The board's Automations widget is an ordinary
 *      custom widget that reads this topic, the same way the Morning News
 *      widget reads the one the feed function writes. Both functions rewrite
 *      it from the agent_automations table whenever something changes, so the
 *      widget never shows a half-updated list.
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.125.0";

export const AUTOMATIONS_TOPIC = "automations";
const TOPIC_KEY = "cw-topic:" + AUTOMATIONS_TOPIC;
const TOPIC_INDEX = "cw-topic:__index";
// Mirrors MAX_VALUE in the board's topic code. A larger value is stored here
// and then ignored by the board, which reads as a widget that never updates.
const MAX_TOPIC_VALUE = 64 * 1024;

export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

export function anthropicClient(): Anthropic {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set for this project.");
  return new Anthropic({ apiKey });
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A list_cost amount ("250" = $2.50) as whole cents. */
export function centsOf(cost: { amount?: string } | null | undefined): number {
  const n = parseInt(String(cost?.amount ?? "0"), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function errorText(e: unknown): string {
  if (e instanceof Anthropic.APIError) return "Anthropic API " + (e.status ?? "") + ": " + e.message;
  return String((e as Error)?.message ?? e);
}

/* ---------------- spend ---------------- */

export async function isOwnerEmail(db: SupabaseClient, email: string | null | undefined): Promise<boolean> {
  const e = String(email ?? "").toLowerCase();
  if (!e) return false;
  const { data } = await db.from("allowed_emails").select("email").eq("note", "owner");
  return (data ?? []).some((r: { email: string }) => String(r.email).toLowerCase() === e);
}

export async function isOwnerId(db: SupabaseClient, userId: string): Promise<boolean> {
  const { data } = await db.auth.admin.getUserById(userId);
  return isOwnerEmail(db, data?.user?.email);
}

export function monthlyCapCents(): number {
  const n = parseInt(Deno.env.get("AGENT_MONTHLY_CAP_CENTS") ?? "500", 10);
  return Number.isFinite(n) && n > 0 ? n : 500;
}

/** Calendar month in UTC. */
export async function monthSpendCents(db: SupabaseClient, userId: string): Promise<number> {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const { data } = await db.from("agent_runs").select("cost_cents")
    .eq("user_id", userId).gte("created_at", start.toISOString());
  return (data ?? []).reduce((s: number, r: { cost_cents: number }) => s + (r.cost_cents || 0), 0);
}

export type AutomationRow = {
  user_id: string;
  id: string;
  name: string;
  deployment_id: string | null;
  agent_id: string | null;
  status: string;
};

/* Pull the latest runs of one automation from Anthropic, record each run's
   cost in the ledger, and note the newest run on the row. Costs are read off
   the session, so a run still in progress is recorded at its cost so far and
   corrected on the next sync. */
export async function syncAutomation(client: Anthropic, db: SupabaseClient, row: AutomationRow): Promise<void> {
  if (!row.deployment_id) return;
  let runs;
  try {
    runs = await client.beta.deploymentRuns.list({ deployment_id: row.deployment_id, limit: 5 });
  } catch {
    return;
  }
  const list = runs.data ?? [];
  let latest: (typeof list)[number] | null = null;
  let latestCost: number | null = null;
  for (const run of list) {
    const newer = !latest || String(run.created_at) > String(latest.created_at);
    let cost = 0;
    if (run.session_id) {
      try {
        const s = await client.beta.sessions.retrieve(run.session_id);
        cost = centsOf(s.usage?.list_cost);
        await db.from("agent_runs").upsert({
          session_id: run.session_id, user_id: row.user_id, automation_id: row.id,
          cost_cents: cost, created_at: run.created_at,
        }, { onConflict: "session_id" });
      } catch { /* one unreadable session must not stop the rest */ }
    }
    if (newer) { latest = run; latestCost = run.session_id ? cost : null; }
  }
  if (!latest) return;
  await db.from("agent_automations").update({
    last_run_at: latest.created_at,
    last_session_id: latest.session_id,
    last_cost_cents: latestCost,
    last_error: latest.error ? latest.error.type + ": " + latest.error.message : null,
  }).eq("user_id", row.user_id).eq("id", row.id);
}

/* The monthly cap, enforced by pausing. A paused deployment stops firing but
   keeps its schedule, so resuming next month is one call. The owner has no
   monthly cap; the per-run budget on each deployment still applies. */
export async function enforceCap(
  client: Anthropic, db: SupabaseClient, userId: string, owner: boolean,
): Promise<{ spent_cents: number; cap_cents: number | null; over_cap: boolean }> {
  const spent = await monthSpendCents(db, userId);
  const cap = owner ? null : monthlyCapCents();
  const over = cap !== null && spent >= cap;
  if (over) {
    const { data } = await db.from("agent_automations").select("id, deployment_id")
      .eq("user_id", userId).eq("status", "active");
    for (const r of data ?? []) {
      if (r.deployment_id) {
        try { await client.beta.deployments.pause(r.deployment_id); } catch { /* retried next sync */ }
      }
      await db.from("agent_automations").update({ status: "over_cap" })
        .eq("user_id", userId).eq("id", r.id);
    }
  }
  return { spent_cents: spent, cap_cents: cap, over_cap: over };
}

/* ---------------- the widget's topic ---------------- */

export async function writeAutomationsTopic(db: SupabaseClient, userId: string): Promise<void> {
  const { data } = await db.from("agent_automations")
    .select("id, name, schedule, timezone, status, last_run_at, last_cost_cents, last_error, result_text, result_at, created_at")
    .eq("user_id", userId).order("created_at", { ascending: true });
  const items = (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id, name: r.name, schedule: r.schedule, timezone: r.timezone, status: r.status,
    last_run_at: r.last_run_at, last_cost_cents: r.last_cost_cents, last_error: r.last_error,
    result_text: String(r.result_text ?? ""), result_at: r.result_at,
  }));

  // Fit the 64KB topic limit by shortening the longest result first, rather
  // than dropping whole automations off the widget.
  let value = JSON.stringify({ text: "", data: { automations: items } });
  for (let guard = 0; value.length > MAX_TOPIC_VALUE - 512 && guard < 40; guard++) {
    let longest = -1;
    items.forEach((it, i) => {
      if (longest === -1 || it.result_text.length > items[longest].result_text.length) longest = i;
    });
    if (longest === -1 || items[longest].result_text.length < 200) break;
    const t = items[longest].result_text;
    items[longest].result_text = t.slice(0, Math.floor(t.length / 2)) + "…";
    value = JSON.stringify({ text: "", data: { automations: items } });
  }

  const entry = { value, at: new Date().toISOString(), from: "agents" };
  await db.from("kv").upsert(
    { user_id: userId, key: TOPIC_KEY, value: JSON.stringify(entry), writer: "agents" },
    { onConflict: "user_id,key" },
  );

  const idx = await db.from("kv").select("value").eq("user_id", userId).eq("key", TOPIC_INDEX).maybeSingle();
  let names: string[] = [];
  try { names = JSON.parse(idx.data?.value ?? "[]") || []; } catch { names = []; }
  if (!names.includes(AUTOMATIONS_TOPIC)) {
    names.push(AUTOMATIONS_TOPIC);
    await db.from("kv").upsert(
      { user_id: userId, key: TOPIC_INDEX, value: JSON.stringify(names), writer: "agents" },
      { onConflict: "user_id,key" },
    );
  }
}
