/*
 * A small in-memory stand-in for the Google Apps Script services that Code.gs uses
 * (SpreadsheetApp, LockService, Utilities, HtmlService). It is strict where real
 * Sheets is strict: ranges outside the sheet throw, new sheets have 26 columns,
 * and a string starting with "=" is a formula (which Code.gs must never write).
 * Used by dev/test_code.js (Deno) and dev/preview.html (browser).
 */
(function (root) {
  "use strict";

  function Sheet(ss, name) {
    this.ss = ss;
    this.name = name;
    this.maxRows = 1000;
    this.maxCols = 26;
    this.cells = new Map();
    this.formats = new Map();
    this.frozen = 0;
  }
  Sheet.prototype.key = function (r, c) { return r + "," + c; };
  Sheet.prototype.getName = function () { return this.name; };
  Sheet.prototype.setName = function (n) { this.name = n; return this; };
  Sheet.prototype.getMaxRows = function () { return this.maxRows; };
  Sheet.prototype.getMaxColumns = function () { return this.maxCols; };
  Sheet.prototype.insertRowsAfter = function (after, n) { this.maxRows += n; return this; };
  Sheet.prototype.insertColumnsAfter = function (after, n) { this.maxCols += n; return this; };
  Sheet.prototype.setFrozenRows = function (n) { this.frozen = n; return this; };
  Sheet.prototype.getLastRow = function () {
    let last = 0;
    this.cells.forEach(function (v, k) { if (v !== "" && v != null) last = Math.max(last, +k.split(",")[0]); });
    return last;
  };
  Sheet.prototype.copyTo = function (ss) {
    const copy = new Sheet(ss, "Copy of " + this.name);
    copy.maxRows = this.maxRows; copy.maxCols = this.maxCols;
    this.cells.forEach((v, k) => copy.cells.set(k, v));
    this.formats.forEach((v, k) => copy.formats.set(k, v));
    ss.sheets.push(copy);
    return copy;
  };
  Sheet.prototype.hideSheet = function () { this.hidden = true; return this; };
  Sheet.prototype.isSheetHidden = function () { return !!this.hidden; };
  Sheet.prototype.getRange = function (row, col, numRows, numCols) {
    return new Range(this, row, col, numRows || 1, numCols || 1);
  };

  function Range(sheet, row, col, nr, nc) {
    if (!(row >= 1 && col >= 1 && nr >= 1 && nc >= 1)) throw new Error("The coordinates or dimensions of the range are invalid.");
    if (row + nr - 1 > sheet.maxRows || col + nc - 1 > sheet.maxCols) {
      throw new Error("The coordinates of the range are outside the dimensions of the sheet.");
    }
    this.s = sheet; this.r = row; this.c = col; this.nr = nr; this.nc = nc;
  }
  Range.prototype.check = function (grid, what) {
    if (!Array.isArray(grid) || grid.length !== this.nr || grid.some((row) => !Array.isArray(row) || row.length !== this.nc)) {
      throw new Error("The number of rows or columns in the " + what + " does not match the range.");
    }
  };
  Range.prototype.store = function (r, c, v) {
    const fmt = this.s.formats.get(this.s.key(r, c)) || "";
    if (typeof v === "string") {
      if (v.charAt(0) === "'") v = v.slice(1);                      // quote prefix: stored as text
      else if (v.charAt(0) === "=") throw new Error("Mock: a formula was written: " + v);
      else if (fmt !== "@" && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
      else if (fmt === "" && /^\d{4}-\d{2}-\d{2}$/.test(v)) v = new Date(v + "T00:00:00");
    }
    this.s.cells.set(this.s.key(r, c), v);
  };
  Range.prototype.setValues = function (grid) {
    this.check(grid, "data");
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.store(this.r + i, this.c + j, grid[i][j]);
    return this;
  };
  Range.prototype.setValue = function (v) {
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.store(this.r + i, this.c + j, v);
    return this;
  };
  Range.prototype.getValues = function () {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) {
        const v = this.s.cells.get(this.s.key(this.r + i, this.c + j));
        row.push(v == null ? "" : v);
      }
      out.push(row);
    }
    return out;
  };
  Range.prototype.getValue = function () { return this.getValues()[0][0]; };
  Range.prototype.getDisplayValue = function () { return String(this.getValue()); };
  Range.prototype.setNumberFormats = function (grid) {
    this.check(grid, "formats");
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.s.formats.set(this.s.key(this.r + i, this.c + j), grid[i][j]);
    return this;
  };
  Range.prototype.setNumberFormat = function (f) {
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.s.formats.set(this.s.key(this.r + i, this.c + j), f);
    return this;
  };
  Range.prototype.setFontWeight = function () { return this; };
  Range.prototype.setBackground = function () { return this; };

  function Spreadsheet() {
    this.sheets = [];
    this.sheets.push(new Sheet(this, "Sheet1"));
  }
  Spreadsheet.prototype.getSheets = function () { return this.sheets.slice(); };
  Spreadsheet.prototype.getSheetByName = function (n) { return this.sheets.find((s) => s.name === n) || null; };
  Spreadsheet.prototype.insertSheet = function (name, index) {
    if (this.getSheetByName(name)) throw new Error("A sheet with the name \"" + name + "\" already exists.");
    const sh = new Sheet(this, name);
    if (index == null) this.sheets.push(sh); else this.sheets.splice(index, 0, sh);
    return sh;
  };
  Spreadsheet.prototype.getSpreadsheetTimeZone = function () { return "Australia/Sydney"; };
  Spreadsheet.prototype.deleteSheet = function (sh) { this.sheets = this.sheets.filter((x) => x !== sh); };

  let active = new Spreadsheet();
  let props = new Map();
  let drive = { files: [], perms: [], n: 0 };
  const pad = (n) => String(n).padStart(2, "0");

  root.SpreadsheetApp = { getActiveSpreadsheet: () => active, flush: () => {} };
  root.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => { props.set(k, String(v)); },
    }),
  };
  root.LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) };
  root.Drive = {
    Files: {
      create: function (resource, blob) {
        const id = "mockfile" + (++drive.n) + "abcdefghijklmnopqrstuvw";
        drive.files.push({ id: id, resource: resource, blob: blob || null });
        return { id: id };
      },
    },
    Permissions: { create: function (perm, id) { drive.perms.push({ perm: perm, id: id }); return {}; } },
  };
  root.ContentService = {
    MimeType: { JSON: "application/json" },
    createTextOutput: function (text) {
      const out = { text: text, mime: "", setMimeType: (m) => { out.mime = m; return out; }, getContent: () => text };
      return out;
    },
  };
  root.Utilities = {
    base64Decode: function (s) { return Array.from(atob(s), (c) => c.charCodeAt(0)); },
    newBlob: function (bytes, type, name) { return { bytes: bytes, type: type, name: name }; },
    formatDate: function (d, tz, fmt) {
      const map = { yyyy: d.getFullYear(), MM: pad(d.getMonth() + 1), dd: pad(d.getDate()), HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()) };
      return fmt.replace(/yyyy|MM|dd|HH|mm|ss/g, (t) => map[t]);
    },
  };
  root.HtmlService = {
    createHtmlOutputFromFile: function () {
      const out = { setTitle: () => out, addMetaTag: () => out };
      return out;
    },
  };
  root.__mockSheets = {
    reset: function () { active = new Spreadsheet(); props = new Map(); drive = { files: [], perms: [], n: 0 }; },
    active: function () { return active; },
    drive: function () { return drive; },
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
