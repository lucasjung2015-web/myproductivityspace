/* Builds demo-board.json: the frozen copy of a board that "?demo" serves.
 *
 * Paste this whole file into the DevTools console on the live board, signed
 * in as the account whose board the demo should show, then run:
 *
 *   mpsDemoPlan()                      -- what would ship, and what would not
 *   mpsExportDemoBoard(["id","id"])    -- the same, minus these, and download
 *
 * The argument is a list of widget ids (or exact titles) to leave out on top
 * of everything already excluded below. Run mpsDemoPlan() first; it prints
 * the ids.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AN ALLOWLIST
 * ---------------------------------------------------------------------------
 * An earlier version of this file took a list of things to exclude. Run
 * against a real board it was wrong four separate times, and each way was
 * invisible until something went looking for it:
 *
 *   1. HIDDEN WIDGETS. "Hidden" is a render flag, not a storage one. A hidden
 *      widget's content is still a key, so it still lands in the file, and
 *      anyone can open /demo-board.json directly and read it. The board looks
 *      clean; the file is not.
 *
 *   2. ORPHANED PAGES. Pages that are not in the layout at all -- deleted
 *      from the board, never placed, left over from an experiment -- still
 *      have their note-content key in storage. They are on no list because
 *      they are on no board.
 *
 *   3. THE AI SIDEBAR. Every conversation lives under ai-chat:<id>. On the
 *      board this file was written against that was ~2MB, the single largest
 *      thing in storage, and nobody would think to name it: it is not a
 *      widget and it is not on the board.
 *
 *   4. widget-titles. One key that names EVERY widget, hidden and orphaned
 *      ones included. Ship it whole and you publish the name of every private
 *      page even when none of their content went.
 *
 * So the rule is inverted. Content, names, colours and emoji ship only for
 * widgets VISIBLE ON THE BOARD. Everything else is refused by default and
 * needs no list, including things that do not exist yet.
 *
 * ---------------------------------------------------------------------------
 * WHAT HIDDEN WIDGETS KEEP
 * ---------------------------------------------------------------------------
 * Their slot and their hidden flag, and nothing else -- no content, no title,
 * no emoji, no colour.
 *
 * They have to keep the slot. The loader accepts a stored layout only if its
 * flattened ids are an EXACT set match for WIDGET_IDS (see the widget-layout
 * branch in init()); a layout that is merely a subset is thrown away whole
 * and the board opens in default order. Dropping hidden widgets from the
 * layout is therefore the one change that silently destroys the arrangement
 * this export exists to preserve.
 *
 * A hidden widget renders nothing, so an empty one and a full one look
 * identical on screen. The arrangement survives; the content does not travel.
 *
 * ---------------------------------------------------------------------------
 * WHAT CANNOT TRAVEL AT ALL
 * ---------------------------------------------------------------------------
 * No credential, because none is in the browser to take: Google, Notion and
 * connector tokens live server-side in tables with RLS on and zero policies
 * (see supabase/schema.sql). Calendar, Tasks and Notion widgets therefore
 * render in the demo as their "Connect ..." buttons. That is the honest
 * state, and it does mean the demo cannot show those doing anything.
 *
 * ---------------------------------------------------------------------------
 * AFTER RUNNING IT
 * ---------------------------------------------------------------------------
 * Chrome may block the download -- look for the blocked-download icon at the
 * right of the address bar and allow it. Put the file in the repo root next
 * to myProductivitySpace.html, deploy, then OPEN /?demo AND READ IT before
 * sending the link on. Everything in that file is public to anyone with the
 * link, permanently, and it sits in a public repo.
 */

(function () {
  "use strict";

  var P = "daily-widget:";
  var g = function (k) { try { return localStorage.getItem(P + k); } catch (e) { return null; } };
  var j = function (k, d) { try { var r = g(k); return r == null ? d : JSON.parse(r); } catch (e) { return d; } };

  /* Stores that are not part of how the board looks. Refused before anything
     else looks at them, so no later rule can accidentally let one through.
     ai-chat is the one that matters most; see note 3 in the header. */
  var NEVER = /^(ai-chat|ai-chats|gcal-widget-accounts|gtask-|notion-|connector|__mps|daily-vocab-api-v5:)/;

  /* Board-shape keys: they position things and hold no content of their own.
     The three maps are rewritten further down rather than copied. */
  var SHAPE = ["widget-layout", "dynamic-widgets", "widget-colors", "widget-icons",
               "widget-titles", "widgets-off-board", "links-menu-items",
               "links-menu-position", "cal-view", "cal-zone", "board-accent",
               "add-card-removed"];

  var GEOMETRY = /(-width$|-height$|Width$|Height$|^manuallyResized-)/;

  /* Last line of defence, not the first. Nothing should reach here carrying a
     credential; if something does, it is refused and named in the report
     rather than silently dropped. */
  var DANGER = /(ghp_|github_pat_|sk-[A-Za-z0-9]{20,}|xox[baprs]-|AIza|-----BEGIN|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/;

  function allKeys() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(P) === 0) out.push(k.slice(P.length));
      }
    } catch (e) {}
    return out;
  }

  /* The name the UI shows: the stored title, else the page's first line.
     Six of the pages on the board this was written against have an EMPTY
     widget-titles entry and are named only by their first line, so a matcher
     that read titles alone matched none of them. */
  function firstLine(id) {
    var raw = g("note-content:" + id);
    if (!raw) return "";
    try {
      var d = document.createElement("div");
      d.innerHTML = raw;
      var b = d.querySelector("[data-b]");
      return ((b ? b.textContent : d.textContent) || "").trim().slice(0, 70);
    } catch (e) { return ""; }
  }
  function nameOf(id) {
    var t = j("widget-titles", {});
    return t[id] || firstLine(id) || id;
  }

  function survey() {
    var layout = j("widget-layout", []);
    var inLayout = [];
    layout.forEach(function (s) {
      (Array.isArray(s) ? s : [s]).forEach(function (i) { inLayout.push(i); });
    });
    var visible = inLayout.filter(function (id) { return g(id + "-hidden") !== "true"; });
    var hidden  = inLayout.filter(function (id) { return g(id + "-hidden") === "true"; });
    return { layout: layout, inLayout: inLayout, visible: visible, hidden: hidden };
  }

  window.mpsDemoPlan = function () {
    var s = survey();
    console.log("%cWould ship -- visible on the board, content and all",
      "font-weight:bold");
    console.table(s.visible.map(function (id) { return { id: id, name: nameOf(id) }; }));
    console.log("%cSlot only -- hidden, keeps its place, no content or name",
      "font-weight:bold");
    console.table(s.hidden.map(function (id) { return { id: id, name: nameOf(id) }; }));
    var orphans = {};
    allKeys().forEach(function (k) {
      var m = /^note-content:(.+)$/.exec(k);
      if (m && s.inLayout.indexOf(m[1]) === -1) orphans[m[1]] = nameOf(m[1]);
    });
    var ok = Object.keys(orphans);
    console.log("%cRefused -- " + ok.length + " page(s) not on the board at all",
      "font-weight:bold");
    if (ok.length) console.table(ok.map(function (id) { return { id: id, name: orphans[id] }; }));
    console.log('Then:  mpsExportDemoBoard(["<id to also leave out>", ...])');
    return s;
  };

  window.mpsExportDemoBoard = function (alsoExclude) {
    var s = survey();
    var drop = [], unmatched = [];
    (alsoExclude || []).forEach(function (want) {
      var needle = String(want).trim().toLowerCase();
      var hit = s.inLayout.filter(function (id) {
        return id.toLowerCase() === needle || nameOf(id).trim().toLowerCase() === needle;
      });
      if (!hit.length) unmatched.push(want);
      hit.forEach(function (id) { drop.push(id); });
    });

    /* Refuse rather than warn. A name that matched nothing is the exact shape
       of the accident this guards: you meant to remove a page, you mistyped
       it, and a warning scrolls past while the page ships. */
    if (unmatched.length) {
      console.error("%cNothing exported.", "font-weight:bold");
      console.error("Matched no widget on the board: " +
        unmatched.map(function (n) { return JSON.stringify(n); }).join(", "));
      console.error("Run mpsDemoPlan() and copy an id from the first table.");
      return;
    }

    var keepId = function (id) { return drop.indexOf(id) === -1; };
    var ALLOW  = s.visible.filter(keepId);
    var HIDDEN = s.hidden.filter(keepId);

    var out = {}, refused = 0, flagged = [];
    allKeys().forEach(function (k) {
      if (NEVER.test(k)) { refused++; return; }
      if (drop.some(function (id) { return k.indexOf(id) !== -1; })) { refused++; return; }
      var ok = SHAPE.indexOf(k) !== -1
            || ALLOW.some(function (id) { return k.indexOf(id) !== -1; })
            || (GEOMETRY.test(k) && s.inLayout.some(function (id) { return k.indexOf(id) !== -1; }))
            || HIDDEN.some(function (id) { return k === id + "-hidden"; });
      if (!ok) { refused++; return; }
      var v = g(k);
      if (v == null) return;
      if (DANGER.test(v)) { flagged.push(k); refused++; return; }
      out[k] = v;
    });

    out["widget-layout"] = JSON.stringify(
      s.layout.map(function (slot) { return (Array.isArray(slot) ? slot : [slot]).filter(keepId); })
              .filter(function (slot) { return slot.length; }));
    out["dynamic-widgets"] = JSON.stringify(
      j("dynamic-widgets", []).filter(function (e) { return e && e.id && keepId(e.id); }));
    ["widget-colors", "widget-icons", "widget-titles"].forEach(function (m) {
      var o = j(m, {}), n = {};
      ALLOW.forEach(function (id) { if (o[id] != null) n[id] = o[id]; });
      out[m] = JSON.stringify(n);
    });
    HIDDEN.forEach(function (id) { out[id + "-hidden"] = "true"; });

    var doc = {
      exported_at: new Date().toISOString(),
      note: "Frozen copy served by ?demo. Exact arrangement; hidden widgets keep their slot and hidden state and nothing else.",
      keys: out
    };
    var json = JSON.stringify(doc, null, 2);

    console.log("%c" + Object.keys(out).length + " keys, " + json.length + " bytes. " +
      ALLOW.length + " widgets with content, " + HIDDEN.length + " slots held open, " +
      refused + " keys refused.", "font-weight:bold");
    if (flagged.length) {
      console.warn("Refused for looking like a credential or an address: " + flagged.join(", "));
    }
    console.table(ALLOW.map(function (id) { return { id: id, name: nameOf(id) }; }));

    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    a.download = "demo-board.json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    console.log("Saved demo-board.json. If nothing downloaded, Chrome blocked it -- " +
      "allow it from the icon at the right of the address bar and run this again.");
    return doc;
  };

  console.log("%cReady.%c  mpsDemoPlan()  then  mpsExportDemoBoard([...])",
    "font-weight:bold", "");
})();
