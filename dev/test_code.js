// Round-trip tests for apps-script/Code.gs against the in-memory mock.
// Run: deno run --allow-read dev/test_code.js
const here = new URL(".", import.meta.url);
(0, eval)(await Deno.readTextFile(new URL("mock-gas.js", here)));
(0, eval)(await Deno.readTextFile(new URL("../apps-script/Code.gs", here)) +
  "\n;globalThis.__C = { WIDTH: WIDTH, LOGGED: LOGGED, DELETED: DELETED, KO0: KO0, MUL0: MUL0, HEAD: HEAD, TAIL: TAIL };");
const { WIDTH, LOGGED, DELETED, KO0, MUL0, HEAD, TAIL } = globalThis.__C;

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail) : "")); }
}
function throws(name, fn, match) {
  try { fn(); check(name, false, "no error thrown"); }
  catch (e) { check(name, !match || match.test(e.message), e.message); }
}
const clone = (v) => JSON.parse(JSON.stringify(v)); // google.script.run serialises arguments and results

const game = {
  playedOn: "2026-09-20",
  seats: [
    { player: "Sam", commander: "Atraxa, Praetors' Voice", partner: "" },
    { player: "Alex", commander: "Krenko, Mob Boss", partner: "" },
    { player: "=Hydra", commander: "Kraum, Ludevic's Opus", partner: "Tymna the Weaver" },
    { player: "Éowyn fan", commander: "Éowyn, Fearless Knight", partner: "" },
  ],
  winner: 1, first: 0, winType: "combat", winDetail: "Forty goblins and an Impact Tremors",
  endTurn: "8", minutes: 85, keyCard: "Impact Tremors", notes: "Line one\nLine two",
};

console.log("fresh spreadsheet");
__mockSheets.reset();
let led = clone(getLedger());
const ss = __mockSheets.active();
check("creates the Games tab by renaming Sheet1", ss.getSheets().length === 2 && ss.getSheets()[0].name === "Games");
check("creates the Players tab with the pod's names in order",
  JSON.stringify(led.players) === JSON.stringify(["Adam", "Chantel", "Ben", "Grady", "Max", "McCutcheon", "Philly", "Luke", "Floyd"]), led.players);
check("widens the sheet to fit every column", ss.getSheetByName("Games").maxCols >= WIDTH, ss.getSheetByName("Games").maxCols);
check("header row written", ss.getSheetByName("Games").getRange(1, 1).getValue() === "ID");
check("empty ledger", led.games.length === 0 && led.podName === "", led);

console.log("save a game");
let res = clone(saveGame(clone(game)));
const g = res.ledger.games[0];
check("returns an id", typeof res.id === "string" && res.id.length > 3, res.id);
check("one game in the ledger", res.ledger.games.length === 1);
check("date round-trips", g.playedOn === "2026-09-20", g.playedOn);
check("seats round-trip", g.seats.length === 4 && g.seats[2].partner === "Tymna the Weaver" && g.seats[0].commander === "Atraxa, Praetors' Voice", g.seats);
check("formula-looking name stored as text", g.seats[2].player === "=Hydra", g.seats[2].player);
check("accented name kept", g.seats[3].player === "Éowyn fan");
check("winner resolves to Alex", g.winner === 1, g.winner);
check("first resolves to Sam", g.first === 0, g.first);
check("win type round-trips", g.winType === "combat", g.winType);
check("turn string becomes number", g.endTurn === 8, g.endTurn);
check("minutes kept", g.minutes === 85);
check("notes keep line breaks", g.notes === "Line one\nLine two", g.notes);
const sheet = ss.getSheetByName("Games");
check("winner stored as a name in the sheet", sheet.getRange(2, 3).getValue() === "Alex", sheet.getRange(2, 3).getValue());
check("win type stored as its label", sheet.getRange(2, 4).getValue() === "Combat damage");
const loggedAt = sheet.getRange(2, LOGGED + 1).getValue();

console.log("edit the game");
const edited = clone(game);
edited.id = res.id;
edited.winner = 0;
edited.winType = "poison";
edited.endTurn = 11;
res = clone(saveGame(edited));
check("still one game", res.ledger.games.length === 1);
check("edit applied", res.ledger.games[0].winner === 0 && res.ledger.games[0].winType === "poison" && res.ledger.games[0].endTurn === 11, res.ledger.games[0]);
check("same row reused", sheet.getLastRow() === 2, sheet.getLastRow());
check("logged-at time preserved", sheet.getRange(2, LOGGED + 1).getValue() === loggedAt);
const id = res.id;

console.log("delete and restore");
led = clone(deleteGame(id));
check("deleted game hidden", led.games.length === 0);
check("row kept in the sheet", sheet.getRange(2, DELETED + 1).getValue() === "deleted");
led = clone(restoreGame(id));
check("restored game back", led.games.length === 1);
throws("unknown id rejected", () => deleteGame("nope"), /could not be found/);

console.log("pod name");
led = clone(setPodName("  Thursday   Night Commander  "));
check("pod name saved and tidied", led.podName === "Thursday Night Commander", led.podName);

console.log("draw");
const draw = clone(game);
draw.winner = null; draw.winType = "combat";
res = clone(saveGame(draw));
const d = res.ledger.games.find((x) => x.id === res.id);
check("draw has no winner or win type", d.winner === null && d.winType === null, d);

console.log("validation");
throws("one player rejected", () => saveGame({ playedOn: "2026-09-20", seats: [{ player: "Solo" }] }), /at least two/);
throws("duplicate players rejected", () => saveGame({ playedOn: "2026-09-20", seats: [{ player: "Sam" }, { player: "sam " }] }), /twice/);
throws("bad date rejected", () => saveGame({ playedOn: "yesterday", seats: [{ player: "A" }, { player: "B" }] }), /date/);
throws("blank player row rejected", () => saveGame({ playedOn: "2026-09-20", seats: [{ player: "A" }, { player: "" }, { player: "B" }] }), /needs a name/);
res = clone(saveGame({ playedOn: "2026-09-21", seats: [{ player: "A" }, { player: "B" }], winner: 0, winType: "constructor" }));
check("unknown win type becomes Something else", res.ledger.games.find((x) => x.id === res.id).winType === "other");

console.log("hand edits in the sheet");
sheet.getRange(2, 3).setValue("sam");                 // winner typed in lower case
sheet.getRange(2, 2).setNumberFormats([["@"]]);
sheet.getRange(2, 2).setValue("21/09/2026");          // Australian date typed by hand
led = clone(getLedger());
const h = led.games.find((x) => x.id === id);
check("winner matched regardless of case", h.winner === 0, h.winner);
check("day/month/year date understood", h.playedOn === "2026-09-21", h.playedOn);

console.log("players tab");
const players = ss.getSheetByName("Players");
players.getRange(11, 1).setValue(" adam ");             // duplicate, different case
players.getRange(12, 1).setValue("");                    // blank row
players.getRange(13, 1).setValue("New Mate");
led = clone(getLedger());
check("duplicates and blanks ignored, new names added", JSON.stringify(led.players.slice(-2)) === JSON.stringify(["Floyd", "New Mate"]) && led.players.length === 10, led.players);
__mockSheets.reset();
saveGame({ playedOn: "2026-09-21", seats: [{ player: "Adam" }, { player: "Ben" }], winner: 0, winType: "combo" });
check("an older spreadsheet has no Players tab yet", !__mockSheets.active().getSheetByName("Players"));
led = clone(getLedger());
check("first load adds it without touching games", !!__mockSheets.active().getSheetByName("Players") && led.players.length === 9 && led.games.length === 1 && led.games[0].seats[0].player === "Adam", led);

console.log("tonight's tables");
check("no saved tables to begin with", clone(getLedger()).tonight === null);
led = clone(saveTables({ tables: [
  { players: ["Adam", "Ben", "=Sneaky", "Philly"], host: "Ben" },
  { players: ["Grady", "Max", " Luke "], host: "Nobody here" },
  { players: [] },
] }));
check("saved tables come back with the ledger", led.tonight && led.tonight.tables.length === 2, led.tonight);
check("host kept when they're at the table", led.tonight.tables[0].host === "Ben");
check("host cleared when they aren't", led.tonight.tables[1].host === "");
check("names tidied and formula-looking text kept as text", led.tonight.tables[1].players[2] === "Luke" && led.tonight.tables[0].players[2] === "=Sneaky", led.tonight.tables);
check("saved time recorded", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(led.tonight.savedAt), led.tonight.savedAt);
throws("an empty draw is rejected", () => saveTables({ tables: [] }), /no groups/);

console.log("weekly backup");
__mockSheets.reset();
saveGame({ playedOn: "2026-09-21", seats: [{ player: "Adam" }, { player: "Ben" }], winner: 0, winType: "combo" });
const bss = __mockSheets.active();
let msg = weeklyBackup();
const backups = () => bss.getSheets().filter((x) => /^Backup /.test(x.name));
check("first backup made", /Backed up/.test(msg) && backups().length === 1, msg);
check("backup tab is hidden", backups()[0].hidden === true);
check("backup holds the games", backups()[0].getRange(2, 3).getValue() === "Adam", backups()[0].getRange(2, 3).getValue());
msg = weeklyBackup();
check("a second run within six days does nothing", /Skipped/.test(msg) && backups().length === 1, msg);
for (let d = 1; d <= 9; d++) bss.insertSheet("Backup 2026-01-0" + d);
PropertiesService.getScriptProperties().setProperty("lastBackup", "0");
weeklyBackup();
check("only the latest eight backups are kept", backups().length === 8, backups().map((x) => x.name));
check("the oldest ones go first", !bss.getSheetByName("Backup 2026-01-01") && !!bss.getSheetByName("Backup 2026-01-09"));
check("games still read normally", clone(getLedger()).games.length === 1);

console.log("knockouts and places");
__mockSheets.reset();
const ko = clone(game); // Alex (seat 1) wins
ko.seats[0].place = 2; ko.seats[0].outBy = "alex"; ko.seats[0].outHow = "combat";
ko.seats[2].place = 4; ko.seats[2].outBy = "Sam"; ko.seats[2].outHow = "drain";
ko.seats[3].place = 3; ko.seats[3].outBy = "Nobody Here"; ko.seats[3].outHow = "made-up";
ko.seats[1].place = 3; ko.seats[1].outBy = "Sam"; ko.seats[1].outHow = "poison";
res = clone(saveGame(ko));
const kg = res.ledger.games[0];
const ksheet = __mockSheets.active().getSheetByName("Games");
check("places round-trip", kg.seats[0].place === 2 && kg.seats[2].place === 4 && kg.seats[3].place === 3, kg.seats.map((x) => x.place));
check("the winner is 1st and wasn't knocked out", kg.seats[1].place === 1 && kg.seats[1].outBy === "" && kg.seats[1].outHow === "", kg.seats[1]);
check("knocked out by matches the name at the table", kg.seats[0].outBy === "Alex" && kg.seats[0].outHow === "combat", kg.seats[0]);
check("someone who wasn't playing is dropped", kg.seats[3].outBy === "", kg.seats[3]);
check("an unknown way of going out is dropped", kg.seats[3].outHow === "", kg.seats[3]);
check("how is stored as its label", ksheet.getRange(2, KO0 + 3).getValue() === "Combat damage", ksheet.getRange(2, KO0 + 3).getValue());
check("knockout headings written", ksheet.getRange(1, KO0 + 1).getValue() === "P1 place" && ksheet.getRange(1, KO0 + 2).getValue() === "P1 knocked out by" && ksheet.getRange(1, MUL0).getValue() === "P8 how");
const self = clone(game);
self.seats[0].outBy = "Sam"; self.seats[0].place = 1; self.seats[2].place = 9; self.seats[3].outHow = "concede";
res = clone(saveGame(self));
let sg = res.ledger.games.find((x) => x.id === res.id);
check("nobody knocks themselves out", sg.seats[0].outBy === "", sg.seats[0]);
check("only the winner can be 1st, and places fit the table", sg.seats[0].place === null && sg.seats[2].place === null, sg.seats.map((x) => x.place));
check("a game without places leaves the winner's place blank", sg.seats[1].place === null && ksheet.getRange(3, KO0 + 4).getValue() === "", sg.seats[1]);
check("going out with nobody to blame is kept (a concession)", sg.seats[3].outHow === "concede" && sg.seats[3].outBy === "", sg.seats[3]);
const drawKo = clone(game);
drawKo.winner = null; drawKo.seats[0].place = 2; drawKo.seats[0].outBy = "Alex"; drawKo.seats[0].outHow = "commander";
res = clone(saveGame(drawKo));
sg = res.ledger.games.find((x) => x.id === res.id);
check("a game with no winner has no places but keeps knockouts", sg.seats[0].place === null && sg.seats[0].outBy === "Alex" && sg.seats[0].outHow === "commander", sg.seats[0]);
ksheet.getRange(2, KO0 + 2).setValue("alex");            // typed by hand in lower case
ksheet.getRange(2, KO0 + 3).setValue("Table conceded");  // the win-type wording also works
ksheet.getRange(2, KO0 + 5).setValue("Jordan");          // not at the table, typed by hand
led = clone(getLedger());
sg = led.games.find((x) => x.id === kg.id);
check("hand-typed knockouts are matched and understood", sg.seats[0].outBy === "Alex" && sg.seats[0].outHow === "concede", sg.seats[0]);
check("a hand-typed name that isn't at the table is shown as typed", sg.seats[1].outBy === "" && sg.seats[1].place === 1, sg.seats[1]);

console.log("who went first and mulligans");
__mockSheets.reset();
const op = clone(game);
op.first = 2; op.seats[0].mulls = 0; op.seats[1].mulls = 2; op.seats[2].mulls = "1"; op.seats[3].mulls = 9;
res = clone(saveGame(op));
const og0 = res.ledger.games[0];
const msheet = __mockSheets.active().getSheetByName("Games");
check("who went first round-trips and is stored by name", og0.first === 2 && msheet.getRange(2, 8).getValue() === "=Hydra", [og0.first, msheet.getRange(2, 8).getValue()]);
check("mulligans round-trip, including none", og0.seats[0].mulls === 0 && og0.seats[1].mulls === 2 && og0.seats[2].mulls === 1, og0.seats.map((x) => x.mulls));
check("an impossible number of mulligans is dropped", og0.seats[3].mulls === null, og0.seats[3].mulls);
check("mulligan headings written", msheet.getRange(1, MUL0 + 1).getValue() === "P1 mulligans" && msheet.getRange(1, MUL0 + 8).getValue() === "P8 mulligans");
res = clone(saveGame(clone(game)));
check("a game without mulligans leaves them blank", res.ledger.games.find((x) => x.id === res.id).seats.every((x) => x.mulls === null));

console.log("a sheet from before knockouts");
__mockSheets.reset();
const oss = __mockSheets.active();
const old = oss.getSheets()[0].setName("Games");
old.insertColumnsAfter(26, 11); // the original 37 columns
oss.insertSheet("Players").getRange(1, 1, 3, 1).setValues([["Players"], ["Adam"], ["Ben"]]);
const oldHead = HEAD.slice();
for (let k = 1; k <= 8; k++) oldHead.push("P" + k + " player", "P" + k + " commander", "P" + k + " partner");
TAIL.forEach((t) => oldHead.push(t));
const oldRow = ["gold1", "2026-09-01", "Ben", "Combo", "Thoracle", 7, 60, "", "", "Old game"];
for (let k = 0; k < 8; k++) oldRow.push(k < 3 ? ["Adam", "Ben", "Max"][k] : "", k < 3 ? "Krenko, Mob Boss" : "", "");
oldRow.push("", "2026-09-01 20:00", "2026-09-01 20:00");
old.getRange(1, 1, 1, 37).setValues([oldHead]);
old.getRange(2, 1, 1, 37).setNumberFormats([oldRow.map(() => "@")]).setValues([oldRow.map(String)]);
led = clone(getLedger());
const og = led.games[0];
check("old games still read", led.games.length === 1 && og.winner === 1 && og.seats.length === 3 && og.endTurn === 7, og);
check("old games have no knockouts", og.seats.every((x) => x.place === null && x.outBy === "" && x.outHow === ""), og.seats);
check("reading doesn't change the old sheet", old.getMaxColumns() === 37);
saveGame({ playedOn: "2026-09-22", seats: [{ player: "Adam", place: 2, outBy: "Ben", outHow: "combat" }, { player: "Ben" }], winner: 1, winType: "combat" });
check("the next save widens the sheet", old.getMaxColumns() >= WIDTH, old.getMaxColumns());
check("and adds the knockout and mulligan headings", old.getRange(1, KO0 + 1).getValue() === "P1 place" && old.getRange(1, MUL0 + 1).getValue() === "P1 mulligans" && old.getRange(1, 37).getValue() === "Updated at");
led = clone(getLedger());
const og2 = led.games.find((x) => x.id === "gold1");
check("the old game is untouched", JSON.stringify(og2) === JSON.stringify(og), [og2, og]);
check("the new game has its knockout", led.games.some((x) => x.id !== "gold1" && x.seats[0].outBy === "Ben" && x.seats[0].place === 2 && x.seats[1].place === 1));

console.log("the page's requests (doPost)");
__mockSheets.reset();
const post = (body) => JSON.parse(doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
let pr = post({ fn: "getLedger", args: [] });
check("getLedger answers through doPost", pr.ok === true && Array.isArray(pr.result.games) && pr.result.players.length === 9, pr);
check("the reply is JSON", doPost({ postData: { contents: '{"fn":"getLedger"}' } }).mime === "application/json");
pr = post({ fn: "weeklyBackup", args: [] });
check("functions outside the list are refused", pr.ok === false && /did not understand/.test(pr.error), pr);
pr = post({ fn: "constructor" });
check("object built-ins are refused too", pr.ok === false, pr);
check("rubbish is refused politely", JSON.parse(doPost({ postData: { contents: "not json" } }).getContent()).ok === false);
pr = post({ fn: "saveGame", args: [{ playedOn: "2026-09-25", seats: [{ player: "A" }] }] });
check("a save that fails reports the reason", pr.ok === false && /at least two/.test(pr.error), pr);
check("the old link shows the moved page", typeof doGet().setTitle === "function");

console.log("board photos");
__mockSheets.reset();
const jpeg = btoa("pretend jpeg bytes");
pr = post({ fn: "saveGame", args: [{ playedOn: "2026-09-25", seats: [{ player: "Adam" }, { player: "Ben" }], winner: 0, winType: "combat", photo: { data: jpeg, type: "image/jpeg" } }] });
const dv = __mockSheets.drive();
const pg = pr.ok && pr.result.ledger.games[0];
check("a photo is saved to Drive in its own folder", pr.ok && dv.files.length === 2 && dv.files[0].resource.mimeType === "application/vnd.google-apps.folder" && dv.files[1].resource.parents[0] === dv.files[0].id, dv.files.map((f) => f.resource));
check("anyone with the link can view it", dv.perms.length === 1 && dv.perms[0].perm.type === "anyone" && dv.perms[0].perm.role === "reader");
check("the game remembers the photo", pg && pg.photo === dv.files[1].id, pg);
const psheet = __mockSheets.active().getSheetByName("Games");
check("the sheet holds the photo's link", String(psheet.getRange(2, WIDTH).getValue()).indexOf("https://drive.google.com/file/d/" + dv.files[1].id) === 0);
check("the photo heading is written", psheet.getRange(1, WIDTH).getValue() === "Board photo");
pr = post({ fn: "saveGame", args: [{ id: pg.id, playedOn: "2026-09-25", seats: [{ player: "Adam" }, { player: "Ben" }], winner: 1, winType: "combo" }] });
check("editing without touching the photo keeps it", pr.ok && pr.result.ledger.games[0].photo === pg.photo && pr.result.ledger.games[0].winner === 1, pr.result && pr.result.ledger.games[0]);
pr = post({ fn: "saveGame", args: [{ id: pg.id, playedOn: "2026-09-25", seats: [{ player: "Adam" }, { player: "Ben" }], winner: 1, winType: "combo", photo: { data: btoa("second"), type: "image/png" } }] });
check("a new photo replaces it, reusing the folder", pr.ok && dv.files.length === 3 && pr.result.ledger.games[0].photo === dv.files[2].id && /\.png$/.test(dv.files[2].resource.name), dv.files.map((f) => f.resource.name));
pr = post({ fn: "saveGame", args: [{ id: pg.id, playedOn: "2026-09-25", seats: [{ player: "Adam" }, { player: "Ben" }], winner: 1, winType: "combo", photo: null }] });
check("null takes the photo off the game", pr.ok && pr.result.ledger.games[0].photo === "", pr.result && pr.result.ledger.games[0]);
pr = post({ fn: "saveGame", args: [{ playedOn: "2026-09-25", seats: [{ player: "Adam" }, { player: "Ben" }], winner: 0, winType: "combat", photo: { data: jpeg, type: "text/html" } }] });
check("only pictures are accepted", pr.ok === false && /JPEG, PNG or WebP/.test(pr.error), pr);
psheet.getRange(2, WIDTH).setValue("1AbCdEfGhIjKlMnOpQrStUvWxYz0123456");
check("a photo id typed by hand is read", clone(getLedger()).games[0].photo === "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456");

console.log("many games");
const before = clone(getLedger()).games.length;
for (let i = 0; i < 1100; i++) saveGame({ playedOn: "2026-01-01", seats: [{ player: "A" }, { player: "B" }], winner: i % 2, winType: "combo" });
led = clone(getLedger());
check("rows added past the first 1000", led.games.length === before + 1100, led.games.length);
check("sheet grew", __mockSheets.active().getSheetByName("Games").maxRows > 1000, __mockSheets.active().getSheetByName("Games").maxRows);

console.log(failures ? "\n" + failures + " FAILED" : "\nall passed");
if (failures) Deno.exit(1);
