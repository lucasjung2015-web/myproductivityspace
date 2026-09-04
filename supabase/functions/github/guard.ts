/* The fence: what the assistant may not change in the app's source.
 *
 * Its own module, and not because index.ts was getting long. Straight-to-live
 * means nobody reviews an ordinary commit, so this file IS the review. It has
 * no Deno imports and no network calls precisely so it can be run against the
 * real 2 MB source file and checked, which is how the tag-balance bug below
 * was found -- the first version of smokeCheck would have refused every
 * commit ever made.
 */

/* Identifiers the AI may read past and build next to, but may not add,
   remove or alter. Grouped so a refusal can name WHICH rule it hit rather
   than just saying no: a refusal the model cannot explain to the user is one
   the user experiences as the thing being broken.

   Matched as plain substrings against changed lines. Deliberately blunt --
   the alternative is parsing 2 MB of HTML, CSS and JS in an edge function to
   decide what a line means, and a blunt rule that always fires beats a
   clever one that sometimes does not. */
export const PROTECTED: { rule: string; why: string; tokens: string[] }[] = [
  {
    rule: "widget-chrome",
    why: "the emoji button, hover controls and title in every widget header",
    tokens: [
      // The emoji placeholder next to a widget's title.
      "widget-icon-btn", "widget-icon-display", "data-icon-btn", "data-icon-display",
      "__wireWidgetIcon", "__applyWidgetIcon",
      // The controls that fade in on hover.
      "col-drag-handle", "col-color-btn", "widget-fullscreen-btn", "widget-hide-btn",
      "col-delete-btn", "section-hide-btn", "section-drag-handle", "collapsible-unhide",
      // The title itself.
      "section-header-title", "data-widget-title-id", "__applyWidgetTitle",
    ],
  },
  {
    rule: "design-tokens",
    why: "the board's colours, spacing and easing, which every widget inherits",
    /* Declaration form only. "--ink:" defines the token; "var(--ink)" merely
       spends it, and code that spends a colour is ordinary work. Locking the
       spend would forbid writing almost any styled markup at all. */
    tokens: [
      "--bg:", "--ink:", "--ink-soft:", "--hair:", "--panel:", "--ease-spring:",
      "--canvas:", "--dot:", "--card:", "--muted:", "--line:",
      "--accent:", "--accent-soft:", "--danger:", "--shadow:", "--radius:",
    ],
  },
  {
    rule: "google-auth",
    why: "the OAuth client and scopes; changing them silently breaks sign-in for everyone",
    tokens: ["CLIENT_ID", "SUPABASE_ANON_KEY", "SUPABASE_URL", "googleapis.com/auth/"],
  },
  {
    rule: "patch-runtime",
    why: "the safety machinery that disables a bad patch and rescues the board",
    tokens: [
      "__mpsPatches", "__mpsRunHook", "__mpsHooks", "__mpsBlameNow", "__mpsPatchError",
      "mps-patch-running", "RUNNING_KEY", "mps-patches-v1",
    ],
  },
];

/* Files this function will not touch at all, whatever the diff says.
   `supabase/` is where this guard itself lives, and a proxy that can rewrite
   its own fence is not a fence. */
export const PROTECTED_PATHS = [
  "supabase/", ".github/", "netlify.toml", ".gitignore", "manifest.webmanifest",
];

/* The lines an edit genuinely changes.
 *
 * This is the piece that makes the fence usable rather than merely strict.
 * An edit is old_string -> new_string, and old_string almost always carries
 * surrounding context so the match is unambiguous. That context is how the
 * model says WHERE, not what it is changing. A protected line quoted
 * identically on both sides is an anchor and must pass, or adding a control
 * next to the emoji button becomes impossible -- which is the exact request
 * that motivated building any of this.
 *
 * So: multiset difference, both directions. A line surviving unchanged
 * cancels out. A line whose indentation moved does not cancel and counts as
 * changed, which is the conservative answer and the right one.
 */
export function changedLines(oldStr: string, newStr: string): string[] {
  const count = (s: string) => {
    const m = new Map<string, number>();
    for (const line of s.split("\n")) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const a = count(oldStr), b = count(newStr);
  const out: string[] = [];
  for (const [line, n] of a) if (n > (b.get(line) ?? 0)) out.push(line);
  for (const [line, n] of b) if (n > (a.get(line) ?? 0)) out.push(line);
  return out;
}

export type Refusal = { rule: string; why: string; token: string; line: string };

export function fenceCheck(oldStr: string, newStr: string): Refusal | null {
  for (const line of changedLines(oldStr, newStr)) {
    for (const group of PROTECTED) {
      for (const token of group.tokens) {
        if (line.includes(token)) {
          return { rule: group.rule, why: group.why, token, line: line.trim().slice(0, 160) };
        }
      }
    }
  }
  return null;
}

/* Correctness is not the fence's job, but "the board still parses" is cheap
   enough to check and expensive enough to get wrong. A source commit gets no
   try/catch, no crash sentinel and no ?safe=1: if it kills the page, the page
   was the place you would have gone to fix it. */
export function smokeCheck(path: string, before: string, after: string): string | null {
  if (!after.trim()) return "The result is empty.";

  const delta = Math.abs(after.length - before.length) / Math.max(1, before.length);
  if (delta > 0.25) {
    return "The file's size changed by " + Math.round(delta * 100) + "% (" +
      before.length + " to " + after.length + " bytes). That is far more than an " +
      "edit of this kind should move, so it has been refused as a likely mistake. " +
      "Make the change in smaller, targeted edits.";
  }

  if (/\.html?$/i.test(path)) {
    /* Counted as a CHANGE against the file we started from, never against
       zero. myProductivitySpace.html genuinely contains 30 "<script" and 14
       "</script>", because several are inside JavaScript strings: the
       custom-widget frame builds its own document. Demanding balance
       outright would refuse every commit ever made, which is how this was
       written first and what running it against the real file caught. What
       actually signals damage is the balance MOVING. */
    const pairs: [RegExp, RegExp, string][] = [
      [/<script[\s>]/gi, /<\/script>/gi, "script"],
      [/<style[\s>]/gi, /<\/style>/gi, "style"],
    ];
    for (const [openRe, closeRe, name] of pairs) {
      const wasOpen = (before.match(openRe) || []).length;
      const wasClose = (before.match(closeRe) || []).length;
      const nowOpen = (after.match(openRe) || []).length;
      const nowClose = (after.match(closeRe) || []).length;
      if (nowOpen - nowClose !== wasOpen - wasClose) {
        return "This edit changes how many <" + name + "> tags are opened versus closed (" +
          wasOpen + "/" + wasClose + " before, " + nowOpen + "/" + nowClose + " after). " +
          "An unbalanced " + name + " block takes the whole board down with no way to " +
          "recover from inside it, so this was refused. If you meant to add a " + name +
          " block, add its closing tag in the same edit.";
      }
    }
    if (!/<html[\s>]/i.test(after)) return "The result no longer contains an <html> tag.";
  }
  return null;
}
