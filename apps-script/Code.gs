/** @OnlyCurrentDoc */

/*
 * Commander Pod Ledger
 *
 * Keeps every game in this spreadsheet's "Games" tab, one row per game. The page
 * itself lives on GitHub Pages (https://adcam02.github.io/pod-ledger/) and talks to
 * this script through doPost; the old link (doGet) shows a "we've moved" page. The tab can be read and edited
 * by hand: fix a typo in any cell and the page picks it up on its next refresh.
 * The "Players" tab lists the names offered in the page's player dropdowns,
 * one per row, in the order they should appear.
 *
 * Knockouts and mulligans came later, so their columns sit at the far right of the
 * Games tab: for each seat, the place they finished, who knocked them out and how,
 * then each seat's mulligans. Games logged before then simply have those cells blank.
 *
 * The "Settings" tab holds the pod name (row 1) and the latest groups drawn
 * by the group generator and saved for everyone (row 3).
 *
 * Once a week weeklyBackup copies the Games tab to a hidden "Backup yyyy-mm-dd"
 * tab and keeps the latest eight (View > Hidden sheets to see them).
 *
 * Board photos are saved to a "Commander Pod Ledger photos" folder in Drive, shared
 * so anyone with the link can view them, and the game's row keeps the photo's link.
 *
 * Functions ending in an underscore are private. The page can only call the
 * functions listed in API; weeklyBackup is run by a weekly trigger.
 */

const GAMES_SHEET = 'Games';
const SETTINGS_SHEET = 'Settings';
const PLAYERS_SHEET = 'Players';
const DEFAULT_PLAYERS = ['Adam', 'Chantel', 'Ben', 'Grady', 'Max', 'McCutcheon', 'Philly', 'Luke', 'Floyd'];
const BACKUP_KEEP = 8;
const MAX_SEATS = 8;
const WIN_TYPES = {
  combat: 'Combat damage',
  commander: 'Commander damage',
  combo: 'Combo',
  alt: 'Alt-win card',
  drain: 'Burn or drain',
  poison: 'Poison',
  mill: 'Mill',
  concede: 'Table conceded',
  other: 'Something else',
};
/* How a player was knocked out: the same kinds as a win, worded for the player going out. */
const KO_TYPES = {
  combat: 'Combat damage',
  commander: 'Commander damage',
  combo: 'Combo',
  alt: 'Alt-win card',
  drain: 'Burn or drain',
  poison: 'Poison',
  mill: 'Milled out',
  concede: 'Conceded',
  other: 'Something else',
};
const HEAD = ['ID', 'Date', 'Winner', 'Win type', 'What won it', 'Ended on turn', 'Minutes', 'Went first', 'Card of the game', 'Summary'];
const TAIL = ['Deleted', 'Logged at', 'Updated at'];
const SEAT0 = HEAD.length;               // 0-based column of "P1 player"
const DELETED = SEAT0 + MAX_SEATS * 3;   // 0-based column of "Deleted"
const LOGGED = DELETED + 1;
const UPDATED = DELETED + 2;
const KO0 = UPDATED + 1;                 // 0-based column of "P1 place", the first knockout column
const MUL0 = KO0 + MAX_SEATS * 3;        // 0-based column of "P1 mulligans"
const PHOTO = MUL0 + MAX_SEATS;          // 0-based column of "Board photo"
const WIDTH = PHOTO + 1;
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const PHOTO_MAX_BYTES = 6 * 1024 * 1024;

/* The old link: a page pointing people to the new address. */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Commander Pod Ledger has moved')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/* What the page on GitHub Pages may ask for. */
const API = {
  getLedger: function () { return getLedger(); },
  saveGame: function (g) { return saveGame(g); },
  deleteGame: function (id) { return deleteGame(id); },
  restoreGame: function (id) { return restoreGame(id); },
  setPodName: function (name) { return setPodName(name); },
  saveTables: function (t) { return saveTables(t); },
};

/*
 * The page's requests arrive here as {"fn": "saveGame", "args": [...]} sent as plain text,
 * which keeps browsers from needing a CORS preflight that Apps Script can't answer.
 * The reply is {"ok": true, "result": ...} or {"ok": false, "error": "..."}.
 */
function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = String(req && req.fn || '');
    if (!Object.prototype.hasOwnProperty.call(API, fn)) throw new Error('The ledger did not understand that request.');
    out = { ok: true, result: API[fn].apply(null, Array.isArray(req.args) ? req.args : []) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- called by the page ---------- */

function getLedger() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(GAMES_SHEET) || !ss.getSheetByName(PLAYERS_SHEET)) {
    withLock_(function () {
      gamesSheet_();
      playersSheet_();
    });
  }
  return readLedger_();
}

function saveGame(input) {
  const game = sanitiseGame_(input);
  // A new photo goes to Drive before taking the lock, since the upload can take a moment.
  const photo = input && input.photo;
  const uploaded = photo && typeof photo === 'object' && photo.data ? storePhoto_(photo, game) : '';
  return withLock_(function () {
    const sh = gamesSheet_();
    const now = stamp_();
    let row = findRow_(sh, game.id);
    let loggedAt = now;
    let kept = '';
    if (row) {
      loggedAt = String(sh.getRange(row, LOGGED + 1).getValue() || now);
      kept = String(sh.getRange(row, PHOTO + 1).getValue() || '');
    } else {
      row = Math.max(sh.getLastRow(), 1) + 1;
      if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
      game.id = newId_();
    }
    // No photo field keeps the one already there; null takes it off the game (the file stays in Drive).
    game.photo = uploaded || (photo === null ? '' : kept);
    writeRow_(sh, row, rowFromGame_(game, loggedAt, now));
    return { id: game.id, ledger: readLedger_() };
  });
}

function deleteGame(id) {
  return setDeleted_(id, true);
}

function restoreGame(id) {
  return setDeleted_(id, false);
}

function setPodName(name) {
  const clean = clean_(name, 40);
  return withLock_(function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SETTINGS_SHEET) || ss.insertSheet(SETTINGS_SHEET);
    sh.getRange(1, 1, 1, 2).setNumberFormats([['@', '@']]).setValues([['Pod name', text_(clean)]]);
    return readLedger_();
  });
}

function saveTables(input) {
  const draw = sanitiseTables_(input);
  return withLock_(function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SETTINGS_SHEET) || ss.insertSheet(SETTINGS_SHEET);
    sh.getRange(3, 1, 1, 2).setNumberFormats([['@', '@']]).setValues([["Tonight's groups", text_(JSON.stringify(draw))]]);
    return readLedger_();
  });
}

function weeklyBackup() {
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty('lastBackup') || 0);
  let note;
  if (Date.now() - last < 6 * 864e5) {
    note = 'Skipped: the last backup is less than six days old.';
  } else {
    const name = withLock_(backupGames_);
    props.setProperty('lastBackup', String(Date.now()));
    note = 'Backed up to the hidden tab "' + name + '".';
  }
  console.log(note); // shows in the editor's execution log and on the Executions page
  return note;
}

/* ---------- reading ---------- */

function readLedger_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(GAMES_SHEET);
  const games = [];
  if (sh && sh.getLastRow() >= 2) {
    const cols = Math.min(WIDTH, sh.getMaxColumns());
    const rows = sh.getRange(2, 1, sh.getLastRow() - 1, cols).getValues();
    rows.forEach(function (r, i) {
      while (r.length < WIDTH) r.push('');
      if (!String(r[0]).trim() || String(r[DELETED]).trim()) return;
      const g = gameFromRow_(r, i + 2);
      if (g) games.push(g);
    });
  }
  const settings = ss.getSheetByName(SETTINGS_SHEET);
  return {
    games: games,
    podName: settings ? clean_(settings.getRange(1, 2).getValue(), 40) : '',
    players: readPlayers_(ss),
    tonight: readTonight_(settings),
  };
}

function readTonight_(settings) {
  if (!settings || settings.getLastRow() < 3) return null;
  try {
    const draw = JSON.parse(String(settings.getRange(3, 2).getValue() || ''));
    return draw && Array.isArray(draw.tables) ? draw : null;
  } catch (e) {
    return null;
  }
}

function readPlayers_(ss) {
  const sh = ss.getSheetByName(PLAYERS_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  const seen = {};
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
    .map(function (r) { return clean_(r[0], 40); })
    .filter(function (name) {
      const k = key_(name);
      if (!k || seen[k]) return false;
      seen[k] = true;
      return true;
    });
}

function gameFromRow_(r, rowNumber) {
  const seats = [];
  for (let k = 0; k < MAX_SEATS; k++) {
    const c = SEAT0 + k * 3;
    const o = KO0 + k * 3;
    const player = clean_(r[c], 40);
    if (!player) continue;
    const how = clean_(r[o + 2], 40);
    seats.push({
      player: player, commander: clean_(r[c + 1], 120), partner: clean_(r[c + 2], 120),
      place: int_(r[o], 1, MAX_SEATS), outBy: clean_(r[o + 1], 40), outHow: how ? koKey_(how) : '',
      mulls: int_(r[MUL0 + k], 0, 7),
    });
  }
  if (!seats.length) return null;
  const seatOf = function (name) {
    const n = key_(name);
    if (!n) return null;
    for (let i = 0; i < seats.length; i++) if (key_(seats[i].player) === n) return i;
    return null;
  };
  const winner = seatOf(r[2]);
  tidyKnockouts_(seats, winner, false);
  return {
    id: String(r[0]).trim(),
    playedOn: date_(r[1]),
    createdAt: rowNumber,
    seats: seats,
    winner: winner,
    first: seatOf(r[7]),
    winType: winner === null ? null : typeKey_(r[3]),
    winDetail: clean_(r[4], 160),
    endTurn: int_(r[5], 1, 60),
    minutes: int_(r[6], 1, 1440),
    keyCard: clean_(r[8], 80),
    notes: String(r[9] == null ? '' : r[9]).replace(/\r\n?/g, '\n').trim().slice(0, 1200),
    photo: photoId_(r[PHOTO]),
  };
}

/* ---------- writing ---------- */

function sanitiseGame_(g) {
  if (!g || typeof g !== 'object') throw new Error('There was nothing to save.');
  const playedOn = date_(g.playedOn);
  if (!playedOn) throw new Error('Pick the date you played.');
  const seats = (Array.isArray(g.seats) ? g.seats : []).slice(0, MAX_SEATS).map(function (s) {
    s = s && typeof s === 'object' ? s : {};
    const how = String(s.outHow || '');
    return {
      player: clean_(s.player, 40), commander: clean_(s.commander, 120), partner: clean_(s.partner, 120),
      place: int_(s.place, 1, MAX_SEATS), outBy: clean_(s.outBy, 40),
      outHow: Object.prototype.hasOwnProperty.call(KO_TYPES, how) ? how : '',
      mulls: int_(s.mulls, 0, 7),
    };
  });
  // Keep seat positions intact so winner and first still point at the right player.
  const named = seats.filter(function (s) { return s.player; });
  if (named.length !== seats.length) throw new Error('Every player row needs a name.');
  if (seats.length < 2) throw new Error('A game needs at least two players.');
  const seen = {};
  seats.forEach(function (s) {
    const k = key_(s.player);
    if (!k) throw new Error('Player names need at least one letter or number.');
    if (seen[k]) throw new Error(s.player + ' is listed twice.');
    seen[k] = true;
  });
  const idx = function (v) {
    return typeof v === 'number' && v % 1 === 0 && v >= 0 && v < seats.length ? v : null;
  };
  const winner = idx(g.winner);
  const type = String(g.winType || '');
  tidyKnockouts_(seats, winner, true);
  return {
    id: clean_(g.id, 40),
    playedOn: playedOn,
    seats: seats,
    winner: winner,
    first: idx(g.first),
    winType: winner === null ? '' : (Object.prototype.hasOwnProperty.call(WIN_TYPES, type) ? type : 'other'),
    winDetail: clean_(g.winDetail, 160),
    endTurn: int_(g.endTurn, 1, 60),
    minutes: int_(g.minutes, 1, 1440),
    keyCard: clean_(g.keyCard, 80),
    notes: String(g.notes == null ? '' : g.notes).replace(/\r\n?/g, '\n').trim().slice(0, 1200),
  };
}

function sanitiseTables_(input) {
  const list = Array.isArray(input && input.tables) ? input.tables.slice(0, 6) : [];
  const tables = list.map(function (t) {
    const players = (Array.isArray(t && t.players) ? t.players : []).slice(0, MAX_SEATS)
      .map(function (p) { return clean_(p, 40); })
      .filter(Boolean);
    const host = clean_(t && t.host, 40);
    return { players: players, host: players.indexOf(host) >= 0 ? host : '' };
  }).filter(function (t) { return t.players.length; });
  if (!tables.length) throw new Error('There were no groups to save.');
  return { savedAt: stamp_(), tables: tables };
}

function rowFromGame_(g, loggedAt, updatedAt) {
  const row = [];
  for (let i = 0; i < WIDTH; i++) row.push('');
  row[0] = g.id;
  row[1] = g.playedOn;
  row[2] = g.winner === null ? '' : g.seats[g.winner].player;
  row[3] = g.winner === null ? '' : WIN_TYPES[g.winType];
  row[4] = g.winDetail;
  row[5] = g.endTurn === null ? '' : g.endTurn;
  row[6] = g.minutes === null ? '' : g.minutes;
  row[7] = g.first === null ? '' : g.seats[g.first].player;
  row[8] = g.keyCard;
  row[9] = g.notes;
  g.seats.forEach(function (s, k) {
    const c = SEAT0 + k * 3;
    const o = KO0 + k * 3;
    row[c] = s.player;
    row[c + 1] = s.commander;
    row[c + 2] = s.partner;
    row[o] = s.place === null ? '' : s.place;
    row[o + 1] = s.outBy;
    row[o + 2] = s.outHow ? KO_TYPES[s.outHow] : '';
    row[MUL0 + k] = s.mulls === null ? '' : s.mulls;
  });
  row[LOGGED] = loggedAt;
  row[UPDATED] = updatedAt;
  row[PHOTO] = g.photo || '';
  return row.map(text_);
}

function writeRow_(sh, row, values) {
  sh.getRange(row, 1, 1, WIDTH).setNumberFormats([formats_()]).setValues([values]);
}

function setDeleted_(id, deleted) {
  return withLock_(function () {
    const sh = gamesSheet_();
    const row = findRow_(sh, clean_(id, 40));
    if (!row) throw new Error('That game could not be found. It may have been removed from the spreadsheet.');
    sh.getRange(row, DELETED + 1).setValue(deleted ? 'deleted' : '');
    sh.getRange(row, UPDATED + 1).setValue(stamp_());
    return readLedger_();
  });
}

/* ---------- sheet set-up ---------- */

function gamesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(GAMES_SHEET);
  if (sh) {
    ensureWidth_(sh);
    ensureLaterHeaders_(sh);
    return sh;
  }
  const sheets = ss.getSheets();
  // A brand-new spreadsheet has one empty "Sheet1": reuse it rather than leave it lying around.
  sh = sheets.length === 1 && sheets[0].getLastRow() === 0 ? sheets[0].setName(GAMES_SHEET) : ss.insertSheet(GAMES_SHEET, 0);
  ensureWidth_(sh);
  const headers = HEAD.slice();
  for (let k = 1; k <= MAX_SEATS; k++) headers.push('P' + k + ' player', 'P' + k + ' commander', 'P' + k + ' partner');
  TAIL.forEach(function (h) { headers.push(h); });
  laterHeaders_().forEach(function (h) { headers.push(h); });
  sh.getRange(1, 1, 1, WIDTH).setValues([headers]).setFontWeight('bold').setBackground('#e8ecf0');
  sh.setFrozenRows(1);
  const rows = sh.getMaxRows() - 1;
  if (rows > 0) {
    const f = formats_();
    const grid = [];
    for (let i = 0; i < rows; i++) grid.push(f);
    sh.getRange(2, 1, rows, WIDTH).setNumberFormats(grid);
  }
  return sh;
}

function playersSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(PLAYERS_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(PLAYERS_SHEET);
  const rows = [['Players']].concat(DEFAULT_PLAYERS.map(function (name) { return [name]; }));
  sh.getRange(1, 1, rows.length, 1).setNumberFormat('@').setValues(rows);
  sh.getRange(1, 1).setFontWeight('bold').setBackground('#e8ecf0');
  sh.setFrozenRows(1);
  return sh;
}

/* Headings for the columns added after the first version: knockouts, then mulligans. */
function laterHeaders_() {
  const h = [];
  for (let k = 1; k <= MAX_SEATS; k++) h.push('P' + k + ' place', 'P' + k + ' knocked out by', 'P' + k + ' how');
  for (let k = 1; k <= MAX_SEATS; k++) h.push('P' + k + ' mulligans');
  h.push('Board photo');
  return h;
}

function ensureLaterHeaders_(sh) {
  // Older sheets get these headings the first time a game is written.
  const want = laterHeaders_();
  const range = sh.getRange(1, KO0 + 1, 1, want.length);
  const have = range.getValues()[0];
  if (have.some(function (v, i) { return String(v) !== want[i]; })) {
    range.setValues([want]).setFontWeight('bold').setBackground('#e8ecf0');
  }
}

function ensureWidth_(sh) {
  // New sheets have 26 columns (A to Z); the ledger needs more.
  const cols = sh.getMaxColumns();
  if (cols < WIDTH) sh.insertColumnsAfter(cols, WIDTH - cols);
}

/* Board photos: saved to a Drive folder this script makes, viewable by anyone with the link. */
function storePhoto_(photo, game) {
  const type = String(photo.type || '');
  if (!Object.prototype.hasOwnProperty.call(PHOTO_TYPES, type)) throw new Error('The photo needs to be a JPEG, PNG or WebP picture.');
  const bytes = Utilities.base64Decode(String(photo.data));
  if (!bytes.length || bytes.length > PHOTO_MAX_BYTES) throw new Error('That photo is too big to save. Try a smaller one.');
  const name = 'Game ' + game.playedOn + ' ' + Utilities.formatDate(new Date(), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'HHmmss') + '.' + PHOTO_TYPES[type];
  const file = Drive.Files.create({ name: name, parents: [photoFolder_()] }, Utilities.newBlob(bytes, type, name));
  Drive.Permissions.create({ role: 'reader', type: 'anyone' }, file.id);
  return 'https://drive.google.com/file/d/' + file.id + '/view';
}

function photoFolder_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('photoFolder');
  if (!id) {
    id = Drive.Files.create({ name: 'Commander Pod Ledger photos', mimeType: 'application/vnd.google-apps.folder' }).id;
    props.setProperty('photoFolder', id);
  }
  return id;
}

/* A Drive file id from a photo cell, which holds its link (or, typed by hand, just the id). */
function photoId_(v) {
  const m = /[-\w]{25,}/.exec(String(v == null ? '' : v));
  return m ? m[0] : '';
}

function backupGames_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = 'Backup ' + Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  const same = ss.getSheetByName(name);
  if (same) ss.deleteSheet(same);
  gamesSheet_().copyTo(ss).setName(name).hideSheet();
  ss.getSheets()
    .filter(function (sh) { return /^Backup \d{4}-\d{2}-\d{2}$/.test(sh.getName()); })
    .sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; })
    .slice(BACKUP_KEEP)
    .forEach(function (sh) { ss.deleteSheet(sh); });
  return name;
}

function formats_() {
  // Plain text everywhere, so names like "1/2" or "=Hydra" are never turned into dates or formulas.
  const f = [];
  for (let i = 0; i < WIDTH; i++) f.push('@');
  f[5] = '0';
  f[6] = '0';
  return f;
}

/* ---------- helpers ---------- */

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('The ledger is busy. Try again in a moment.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function findRow_(sh, id) {
  if (!id) return 0;
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]).trim() === id) return i + 2;
  return 0;
}

function newId_() {
  return 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36);
}

function stamp_() {
  return Utilities.formatDate(new Date(), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
}

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function key_(v) {
  return String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function int_(v, lo, hi) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return isFinite(n) && n >= lo && n <= hi ? Math.round(n) : null;
}

function pad_(n) {
  return ('0' + n).slice(-2);
}

function date_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  }
  const s = String(v == null ? '' : v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return m[1] + '-' + pad_(m[2]) + '-' + pad_(m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // day/month/year, as typed in Australia
  if (m) return m[3] + '-' + pad_(m[2]) + '-' + pad_(m[1]);
  return '';
}

/*
 * Places and knockouts, made consistent: the winner is 1st (only written when someone else
 * has a place, so a game without places stays without them), nobody else can be 1st or
 * finish lower than the table allows, a game with no winner has no places, the winner
 * wasn't knocked out, and nobody knocks themselves out. "Knocked out by" is matched to
 * the name at the table; a name that isn't there is kept when reading (it was typed in
 * the sheet) and dropped when saving from the page.
 */
function tidyKnockouts_(seats, winner, dropUnknown) {
  const seatOf = function (name) {
    const n = key_(name);
    if (!n) return null;
    for (let i = 0; i < seats.length; i++) if (key_(seats[i].player) === n) return i;
    return null;
  };
  const placed = seats.some(function (s, i) { return i !== winner && s.place !== null && s.place > 1 && s.place <= seats.length; });
  seats.forEach(function (s, i) {
    if (winner === null) s.place = null;
    else if (i === winner) s.place = placed ? 1 : null;
    else if (s.place !== null && (s.place < 2 || s.place > seats.length)) s.place = null;
    if (i === winner) { s.outBy = ''; s.outHow = ''; return; }
    const by = seatOf(s.outBy);
    if (by === i) s.outBy = '';
    else if (by !== null) s.outBy = seats[by].player;
    else if (dropUnknown) s.outBy = '';
  });
}

/* A "how" cell: either set of labels, or the key itself. */
function koKey_(label) {
  const s = key_(label);
  for (const k in KO_TYPES) {
    if (key_(k) === s || key_(KO_TYPES[k]) === s || key_(WIN_TYPES[k]) === s) return k;
  }
  return 'other';
}

function typeKey_(label) {
  const s = key_(label);
  for (const k in WIN_TYPES) {
    if (key_(k) === s || key_(WIN_TYPES[k]) === s) return k;
  }
  return 'other';
}

function text_(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v);
  // A leading apostrophe makes Sheets store the value as text instead of reading it as a formula.
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
