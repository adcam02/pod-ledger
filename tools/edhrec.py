#!/usr/bin/env python3
"""Fetch what EDHREC knows about each commander in src/commanders.tsv, for tools/picks.py.

    python3 tools/edhrec.py            fetch every commander not already in the cache
    python3 tools/edhrec.py --refresh  fetch them all again

For each commander it keeps a small summary of its EDHREC page (how many decks, the deck themes people tag, similar
commanders, combos, the shape of the average deck, popularity by month, and the cards its decks run with EDHREC's
synergy score) in <cache>/edhrec/<slug>.json, where <cache> is tools/carddata.py's cache folder. It asks for at most
four pages a second, and a second run only fetches what's missing.
"""
import json
import pathlib
import sys
import threading
import time
import unicodedata
import urllib.error
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import carddata  # noqa: E402

DIR = carddata.CACHE / "edhrec"
PER_SECOND = 4


def slug(name):
    """EDHREC's address for a card: "Krenko, Mob Boss" → "krenko-mob-boss" (front face only for two-faced cards)."""
    name = name.split(" // ")[0].replace("Æ", "Ae").replace("æ", "ae")
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    out = "".join(ch if ch.isalnum() else " " if ch in " -" else "" for ch in name)
    return "-".join(out.split())


def summarise(d):
    """The parts of an EDHREC commander page that tools/picks.py uses."""
    jd = d.get("container", {}).get("json_dict", {})
    card = jd.get("card") or {}
    panels = d.get("panels") or {}
    cards, seen = [], set()
    for lst in jd.get("cardlists") or []:
        for cv in lst.get("cardviews") or []:
            n = cv.get("name")
            if not n or n in seen:
                continue
            seen.add(n)
            pot = cv.get("potential_decks") or card.get("num_decks") or 0
            inc = (cv.get("num_decks") or 0) / pot if pot else 0
            cards.append([n, round(cv.get("synergy") or 0, 3), round(inc, 3), lst.get("tag") or ""])
    trend = []
    for month, v in sorted((panels.get("rank_over_time") or {}).items()):
        if isinstance(v, dict):
            trend.append([month[:7], v.get("commander_count") or 0, v.get("perc_of_decks_overall") or 0])
    return {
        "name": card.get("name"),
        "decks": card.get("num_decks") or 0,
        "rank": card.get("rank"),
        "salt": round(card.get("salt") or 0, 2),
        "similar": [s for s in (d.get("similar") or []) if isinstance(s, str)],
        "tags": [[t.get("value"), t.get("count") or 0] for t in (panels.get("taglinks") or d.get("tag_counts") or [])[:40]],
        "combos": [c.get("value") for c in panels.get("combocounts") or [] if c.get("value") and not c["value"].startswith("See More")],
        "types": {k: d.get(k) or 0 for k in ("creature", "instant", "sorcery", "artifact", "enchantment", "planeswalker", "battle", "land")},
        "curve": panels.get("mana_curve") or {},
        "brackets": d.get("bracket_counts") or {},
        "budget": d.get("budget_counts") or {},
        "trend": trend,
        "cards": cards,
    }


_lock = threading.Lock()
_next = [0.0]


def _wait_turn():
    with _lock:
        now = time.monotonic()
        at = max(now, _next[0])
        _next[0] = at + 1 / PER_SECOND
    time.sleep(max(0, at - now))


def fetch(name, refresh=False):
    s = slug(name)
    path = DIR / (s + ".json")
    if path.exists() and not refresh:
        return "cached"
    url = "https://json.edhrec.com/pages/commanders/" + s + ".json"
    for _ in range(3):
        _wait_turn()
        try:
            d = json.loads(carddata.get(url))
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                path.write_text(json.dumps({"missing": True, "name": name}))
                return "missing"
            raise
        if isinstance(d, dict) and d.get("redirect"):  # renamed pages point at the new address
            url = "https://json.edhrec.com/pages" + d["redirect"] + ".json"
            continue
        out = summarise(d)
        out["for"] = name
        path.write_text(json.dumps(out, separators=(",", ":")))
        return "ok"
    return "missing"


def main():
    refresh = "--refresh" in sys.argv
    DIR.mkdir(parents=True, exist_ok=True)
    names = [ln.split("\t")[0] for ln in (ROOT / "src" / "commanders.tsv").read_text(encoding="utf-8").splitlines() if ln]
    counts = {"ok": 0, "cached": 0, "missing": 0, "error": 0}
    start = time.time()

    def one(n):
        try:
            return fetch(n, refresh)
        except Exception as e:  # keep going; a second run picks up what failed
            print(f"  {n}: {e}", flush=True)
            return "error"

    with ThreadPoolExecutor(max_workers=4) as pool:
        for i, result in enumerate(pool.map(one, names), 1):
            counts[result] += 1
            if i % 250 == 0 or i == len(names):
                print(f"{i}/{len(names)} {counts} {time.time() - start:.0f}s", flush=True)
    print("Done:", counts)


if __name__ == "__main__":
    main()
