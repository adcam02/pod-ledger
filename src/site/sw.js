/*
 * Keeps the ledger on the phone so it opens without signal.
 *
 * The page itself comes from the network whenever there is a connection (so an update shows straight away) and falls
 * back to the saved copy when there isn't, or after a few seconds of waiting. Icons, fonts, mana symbols and card art
 * are kept once seen and served from the phone after that. The ledger's own requests to the sheet, Scryfall lookups
 * and board photos are never touched: they always go to the network.
 *
 * Raise VERSION to drop everything saved by an older copy. The page's ?nosw takes the worker off a phone entirely.
 */
const VERSION = "v1";
const PAGE_CACHE = "ledger-page-" + VERSION;
const ASSET_CACHE = "ledger-assets-" + VERSION;
const ART_CACHE = "ledger-art-" + VERSION;
const ART_MAX = 250;
const PAGE_WAIT = 4000;
const CORE = ["./", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"];
const ASSET_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "svgs.scryfall.io", "cdn.jsdelivr.net"];
const ART_HOSTS = ["cards.scryfall.io"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(PAGE_CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.indexOf("ledger-") === 0 && !k.endsWith("-" + VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (req.mode === "navigate") e.respondWith(page(req, url));
    else if (url.pathname !== new URL("sw.js", self.location).pathname) e.respondWith(kept(req, ASSET_CACHE, false));
    return;
  }
  if (ASSET_HOSTS.indexOf(url.hostname) >= 0) e.respondWith(kept(req, ASSET_CACHE, true));
  else if (ART_HOSTS.indexOf(url.hostname) >= 0) e.respondWith(kept(req, ART_CACHE, true, ART_MAX));
});

/* The page: the network's copy if it arrives in time (saved for next time), otherwise the saved one. */
async function page(req, url) {
  const cache = await caches.open(PAGE_CACHE);
  const key = url.origin + url.pathname; // the same page whatever ?query it was opened with
  const fresh = fetch(req).then((res) => {
    if (res && res.ok && res.type === "basic" && !res.redirected) cache.put(key, res.clone());
    return res;
  });
  fresh.catch(() => {}); // a late failure after the saved copy was served isn't an error
  const saved = () => cache.match(key).then((hit) => hit || cache.match("./"));
  try {
    const res = await Promise.race([fresh, new Promise((resolve) => setTimeout(() => resolve(null), PAGE_WAIT))]);
    if (res) return res;
    const hit = await saved();
    return hit || fresh; // nothing saved yet: keep waiting for the network
  } catch (err) {
    const hit = await saved();
    if (hit) return hit;
    throw err;
  }
}

/* Anything else worth keeping: the saved copy if there is one, otherwise fetched and saved. Cross-site files are fetched
   with CORS so a readable copy can be kept; a host that refuses is simply loaded the normal way, unsaved. */
async function kept(req, name, crossSite, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  let res;
  try {
    res = await fetch(crossSite ? new Request(req.url, { mode: "cors", credentials: "omit" }) : req);
  } catch (err) {
    return fetch(req);
  }
  if (res.ok && res.type !== "opaque") {
    cache.put(req, res.clone()).then(() => (max ? trim(cache, max) : null)).catch(() => {});
  }
  return res;
}

async function trim(cache, max) {
  const keys = await cache.keys();
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
}
