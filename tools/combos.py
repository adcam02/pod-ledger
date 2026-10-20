#!/usr/bin/env python3
"""Fetch the best-known combos for each commander from Commander Spellbook, for tools/picks.py.

    python3 tools/combos.py            fetch every commander not already in the cache
    python3 tools/combos.py --refresh  fetch them all again

Only commanders whose EDHREC page lists a combo are asked about (run tools/edhrec.py first). For each, the two most
popular combos that use the commander and are legal in Commander go in <cache>/combos/<slug>.json: the other cards and
what the combo makes. At most two requests a second.
"""
import json
import pathlib
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import carddata  # noqa: E402
import edhrec  # noqa: E402

DIR = carddata.CACHE / "combos"
edhrec.PER_SECOND = 2


def fetch(name, refresh=False):
    s = edhrec.slug(name)
    path = DIR / (s + ".json")
    if path.exists() and not refresh:
        return "cached"
    q = 'card="' + name.split(" // ")[0].replace('"', "") + '" legal:commander'
    url = "https://backend.commanderspellbook.com/variants/?" + urllib.parse.urlencode({"q": q, "ordering": "-popularity", "limit": 2})
    edhrec._wait_turn()
    d = json.loads(carddata.get(url))
    out = []
    for v in d.get("results") or []:
        uses = [u["card"]["name"] for u in v.get("uses") or []]
        out.append({
            "with": [u for u in uses if u.split(" // ")[0] != name.split(" // ")[0]],
            "makes": [p["feature"]["name"] for p in v.get("produces") or []],
            "popularity": v.get("popularity") or 0,
        })
    path.write_text(json.dumps({"for": name, "combos": out, "more": bool(d.get("next"))}, separators=(",", ":")))
    return "ok" if out else "none"


def main():
    refresh = "--refresh" in sys.argv
    DIR.mkdir(parents=True, exist_ok=True)
    names = []
    for ln in (ROOT / "src" / "commanders.tsv").read_text(encoding="utf-8").splitlines():
        n = ln.split("\t")[0]
        p = edhrec.DIR / (edhrec.slug(n) + ".json")
        if n and p.exists() and json.loads(p.read_text()).get("combos"):
            names.append(n)
    print(f"{len(names)} commanders have combos on EDHREC")
    counts = {"ok": 0, "none": 0, "cached": 0, "error": 0}

    def one(n):
        try:
            return fetch(n, refresh)
        except Exception as e:
            print(f"  {n}: {e}", flush=True)
            return "error"

    with ThreadPoolExecutor(max_workers=2) as pool:
        for i, r in enumerate(pool.map(one, names), 1):
            counts[r] += 1
            if i % 250 == 0 or i == len(names):
                print(f"{i}/{len(names)} {counts}", flush=True)
    print("Done:", counts)


if __name__ == "__main__":
    main()
