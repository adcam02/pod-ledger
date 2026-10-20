"""Card data for the tools: Scryfall's bulk files, downloaded once and kept in a cache folder.

The cache is ~/.cache/pod-ledger, or the folder named by POD_LEDGER_CACHE. Files older than a week
are fetched again; pass fresh=True (or delete the folder) to force it.
"""
import gzip
import json
import os
import pathlib
import time
import urllib.error
import urllib.request

CACHE = pathlib.Path(os.environ.get("POD_LEDGER_CACHE") or pathlib.Path.home() / ".cache" / "pod-ledger")
# Scryfall and EDHREC both ask for a User-Agent that says who is asking.
UA = "pod-ledger/1.0 (+https://github.com/adcam02/pod-ledger)"
WEEK = 7 * 86400


def get(url, accept="application/json", tries=4):
    """The body of url, retrying a few times on a network hiccup or a 429."""
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):  # EDHREC's storage answers 403 for a page that doesn't exist
                raise
            if attempt == tries - 1:
                raise
            time.sleep(2 + attempt * 3 if e.code != 429 else 30)
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == tries - 1:
                raise
            time.sleep(2 + attempt * 3)


def bulk(kind, fresh=False):
    """Path to Scryfall's bulk file of this type ("oracle_cards", "oracle_tags", "default_cards"), as .jsonl.gz."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / (kind.replace("_", "-") + ".jsonl.gz")
    if path.exists() and not fresh and time.time() - path.stat().st_mtime < WEEK:
        return path
    index = json.loads(get("https://api.scryfall.com/bulk-data"))
    entry = next(d for d in index["data"] if d["type"] == kind)
    url = entry.get("jsonl_download_uri") or entry["download_uri"]
    print(f"Downloading Scryfall's {kind} ({entry.get('compressed_size', 0) / 1e6:.0f} MB)…", flush=True)
    tmp = path.with_suffix(".part")
    tmp.write_bytes(get(url, accept="*/*"))
    tmp.replace(path)
    return path


def iter_bulk(kind):
    """Each card (or tag) in a bulk file, as a dict."""
    with gzip.open(bulk(kind), "rt", encoding="utf-8") as f:
        for line in f:
            line = line.strip().rstrip(",")
            if line and line not in ("[", "]"):
                yield json.loads(line)
