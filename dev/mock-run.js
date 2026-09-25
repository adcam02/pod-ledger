/*
 * Stands in for google.script.run in the local preview. Calls go to the real
 * Code.gs functions (loaded as code.js) running against the in-memory sheet in
 * mock-gas.js, with arguments and results serialised the way Apps Script does.
 *
 *   preview.html            empty spreadsheet
 *   preview.html?seed       spreadsheet with a dozen games already logged
 *   preview.html?offline    no spreadsheet at all (the page's not-connected state)
 */
(function () {
  "use strict";
  const params = new URLSearchParams(location.search);
  if (params.has("offline")) { window.__noLedgerApi = true; return; } // and don't let the page reach the real sheet

  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  function runner(ok, fail) {
    return new Proxy({}, {
      get(_, name) {
        if (name === "withSuccessHandler") return (fn) => runner(fn, fail);
        if (name === "withFailureHandler") return (fn) => runner(ok, fn);
        return function () {
          const args = clone(Array.from(arguments));
          setTimeout(() => {
            let out;
            try { out = clone(window[name].apply(null, args)); }
            catch (e) { if (fail) fail(new Error(e.message)); return; }
            if (ok) ok(out);
          }, 300);
        };
      },
    });
  }
  window.google = { script: { run: runner(null, null) } };

  if (!params.has("seed")) return;
  const day = (k) => { const d = new Date(); d.setDate(d.getDate() - k); return d.toISOString().slice(0, 10); };
  // Optional knockouts per seat: [place, knocked out by, how].
  const seats = (list, ko) => list.map((s, i) => {
    const k = (ko && ko[i]) || [];
    const mulls = [0, 1, 0, 2, 0, 1, 0, 0][(i + list.length) % 8]; // a spread of mulligans for the preview
    return { player: s[0], commander: s[1], partner: s[2] || "", place: k[0] || null, outBy: k[1] || "", outHow: k[2] || "", mulls: ko ? mulls : null };
  });
  const seed = [
    [3, [["Adam", "Tuvasa the Sunlit"], ["Ben", "Krenko, Mob Boss"], ["Chloe", "The Wise Mothman"], ["Dan", "Lathril, Blade of the Elves"]], 0, 1, "combat", "Enchantress draw into a huge Tuvasa", 9, 95, "Sigil of the Empty Throne",
      [null, [2, "Adam", "combat"], [3, "Ben", "combat"], [4, "Adam", "combat"]]],
    [3, [["Ben", "Krenko, Mob Boss"], ["Chloe", "The Wise Mothman"], ["Dan", "Lathril, Blade of the Elves"], ["Ellie", "Doctor Doom, King of Latveria"]], 1, 0, "mill", "Mothman milled the table out", 12, 120, "Bruvac the Grandiloquent",
      [[3, "Chloe", "mill"], null, [2, "Chloe", "mill"], [4, "Dan", "drain"]]],
    [10, [["Adam", "Tuvasa the Sunlit"], ["Dan", "Beorn the Fierce"], ["Ellie", "Cloud, Ex-SOLDIER"]], 2, 1, "commander", "Cloud with a Colossus Hammer", 8, 60, "Colossus Hammer",
      [[2, "Ellie", "commander"], [3, "Adam", "combat"], null]],
    [17, [["Adam", "Tuvasa the Sunlit"], ["Ben", "Krenko, Mob Boss"], ["Chloe", "Pantlaza, Sun-Favored"], ["Ellie", "Doctor Doom, King of Latveria"]], 1, 2, "combat", "Goblins went wide", 7, 70, "Impact Tremors",
      [[2, "Ben", "combat"], null, [2, "Ben", "combat"], [4, "", "concede"]]],
    [24, [["Ben", "Krenko, Mob Boss"], ["Chloe", "The Wise Mothman"], ["Dan", "Lathril, Blade of the Elves"], ["Ellie", "Cloud, Ex-SOLDIER"]], 2, 3, "drain", "Lathril drained for the win", 10, 100, "Elvish Archdruid"],
    [31, [["Adam", "Tuvasa the Sunlit"], ["Ben", "Krenko, Mob Boss"], ["Chloe", "The Wise Mothman"], ["Dan", "Lathril, Blade of the Elves"], ["Ellie", "Doctor Doom, King of Latveria"]], null, 0, "", "Called at midnight", 14, 200, ""],
    [38, [["Adam", "Tuvasa the Sunlit"], ["Chloe", "The Wise Mothman"], ["Ellie", "Doctor Doom, King of Latveria"], ["Dan", "Beorn the Fierce"]], 0, 3, "combo", "Solemnity and Decree of Silence lock", 11, 110, "Solemnity"],
    [45, [["Ben", "Krenko, Mob Boss"], ["Dan", "Lathril, Blade of the Elves"], ["Ellie", "Doctor Doom, King of Latveria"], ["Chloe", "Pantlaza, Sun-Favored"]], 2, 1, "alt", "Doom's plan came together", 12, 115, "Approach of the Second Sun"],
    [52, [["Adam", "Tuvasa the Sunlit"], ["Ben", "Krenko, Mob Boss"], ["Chloe", "The Wise Mothman"], ["Dan", "Lathril, Blade of the Elves"]], 1, 0, "combat", "Krenko on turn six", 6, 45, "Skullclamp"],
    [66, [["Adam", "Tuvasa the Sunlit"], ["Ellie", "Cloud, Ex-SOLDIER"], ["Chloe", "The Wise Mothman"], ["Dan", "Beorn the Fierce"]], 0, 2, "combat", "Tuvasa swung for lethal", 10, 90, "Ancestral Mask"],
    [80, [["Ben", "Krenko, Mob Boss"], ["Chloe", "The Wise Mothman"], ["Dan", "Lathril, Blade of the Elves"], ["Ellie", "Doctor Doom, King of Latveria"]], 1, 3, "mill", "Mothman again", 13, 130, "Maddening Cacophony"],
    [400, [["Adam", "Tuvasa the Sunlit"], ["Ben", "Krenko, Mob Boss"], ["Chloe", "The Wise Mothman"], ["Dan", "Lathril, Blade of the Elves"]], 3, 0, "combat", "Elves from last year", 9, 80, "Craterhoof Behemoth"],
  ];
  seed.forEach((g) => {
    window.saveGame({ playedOn: day(g[0]), seats: seats(g[1], g[9]), winner: g[2], first: g[3], winType: g[4], winDetail: g[5], endTurn: g[6], minutes: g[7], keyCard: g[8], notes: "" });
  });
  window.setPodName("Thursday Night Commander");
})();
