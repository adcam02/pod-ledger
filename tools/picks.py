#!/usr/bin/env python3
"""Build src/picks.json: what the page needs to suggest commanders a player would enjoy.

    python3 tools/edhrec.py         once (about 15 minutes): EDHREC's page for every commander
    python3 tools/combos.py         once (about 10 minutes): Commander Spellbook's best combos
    python3 tools/picks.py          about a minute: work out which commanders play alike, write src/picks.json
    python3 tools/picks.py --check  also print the closest commanders to some well-known ones

How alike two commanders are comes from four things, strongest first:
  - the cards their decks run on EDHREC, weighted by EDHREC's synergy score (how much more often a card shows up for
    this commander than in other decks of its colours) and by how rare that is across commanders;
  - the themes people tag their decks with on EDHREC (Tokens, Aristocrats, Spellslinger, Goblins...);
  - Scryfall Tagger's tags for what the commander card itself does (draw engine, repeatable tokens...);
  - the shape of the average deck (how many creatures, spells, artifacts and enchantments, and its mana curve).
The cards their decks share tie commanders to their own colours, so a second list ("across colours") leaves the cards
out to find commanders that do the same thing in other colours.

src/picks.json lines up with src/commanders.tsv (one entry per line, same order) and carries a hash of its names, so
the build can tell when the two have drifted apart. Everything is in short arrays to keep the file small; the page
reads it only when it needs to show picks.
"""
import collections
import gzip
import hashlib
import json
import math
import pathlib
import re
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import carddata  # noqa: E402
import edhrec  # noqa: E402

OUT = ROOT / "src" / "picks.json"
CARDS_OUT = ROOT / "src" / "cards.json"
NB, NX, SIG, TH = 20, 8, 10, 8  # neighbours, across-colour neighbours, signature cards, themes kept per commander

# EDHREC tags that say nothing about how a deck plays.
SKIP_TAGS = {"Good Stuff", "Budget", "Primer", "cEDH", "Pauper", "Keywords", "Midrange", "Toolbox", "Commander Matters",
             "Legends", "Historic"}
# Scryfall Tagger tags that are trivia rather than function.
SKIP_TAGGER = re.compile(r"^(cycle-|art-|flavor|alliteration|unique |intervening|drawback|multiple targets|activated ability"
                         r"|triggered ability|reprint|mirror|pun|rhyme|name |namesake|joke|frame|reference|unusual|eminence)")


def norm(s):
    return " ".join(s.split(" // ")[0].lower().split())


def load_commanders():
    rows = [ln.split("\t") for ln in (ROOT / "src" / "commanders.tsv").read_text(encoding="utf-8").splitlines() if ln]
    return [{"name": r[0], "ci": r[1], "tags": r[2] if len(r) > 2 else "", "cx": int(r[3]) if len(r) > 3 and r[3] else 2} for r in rows]


CREATURE_TYPES = set()  # every creature type, in the plural, so tribal themes ("Goblins") can be told apart


def scryfall_facts(cmds):
    """Per commander: oracle id, type line, keywords, first printing (date and set), Universes Beyond franchise."""
    from commanders import plural  # noqa: E402 (tools/ is on the path)
    by = {norm(c["name"]): c for c in cmds}
    for card in carddata.iter_bulk("oracle_cards"):
        for part in (card.get("type_line") or "").split(" // "):
            if "Creature" in part.split("—")[0] and "—" in part:
                CREATURE_TYPES.update(plural(t) for t in part.split("—", 1)[1].split())
        c = by.get(norm(card["name"]))
        if not c or (card.get("legalities") or {}).get("commander") != "legal":
            continue
        face = (card.get("card_faces") or [card])[0]
        c["oracle_id"] = card.get("oracle_id")
        c["type"] = face.get("type_line") or card.get("type_line") or ""
        c["kw"] = card.get("keywords") or []
        c["gc"] = bool(card.get("game_changer"))
        c["mv"] = card.get("cmc") or 0
    ids = {c.get("oracle_id"): c for c in cmds if c.get("oracle_id")}
    for card in carddata.iter_bulk("default_cards"):
        c = ids.get(card.get("oracle_id"))
        if not c or card.get("set_type") in ("token", "memorabilia", "funny", "minigame") or card.get("digital"):
            continue
        day = card.get("released_at") or "9999"
        if day < c.get("first", "9999"):
            ub = "universesbeyond" in (card.get("promo_types") or []) or card.get("security_stamp") == "triangle"
            c["first"], c["first_set"], c["first_ub"] = day, card.get("set_name") or "", ub
    for c in cmds:
        # A crossover card is one first printed in a Universes Beyond set (not a Magic card reprinted in one). Its
        # franchise is that set, give or take a "Commander" on the end; a Secret Lair just says Universes Beyond.
        if c.get("first_ub"):
            sn = c.get("first_set", "")
            c["ub"] = "Universes Beyond" if "Secret Lair" in sn or "Promo" in sn else re.sub(r"\s+(Commander|Eternal|Front Cards)$", "", sn)
    tagger = collections.defaultdict(list)
    for t in carddata.iter_bulk("oracle_tags"):
        label = t.get("label") or ""
        if t.get("type") != "oracle" or SKIP_TAGGER.search(label):
            continue
        for tg in t.get("taggings") or []:
            if tg.get("oracle_id") in ids:
                tagger[tg["oracle_id"]].append(label)
    for oid, c in ids.items():
        c["tagger"] = tagger.get(oid, [])


def load_edhrec(cmds):
    for c in cmds:
        p = edhrec.DIR / (edhrec.slug(c["name"]) + ".json")
        d = json.loads(p.read_text()) if p.exists() else {}
        c["ed"] = None if not d or d.get("missing") else d
        p = carddata.CACHE / "combos" / (edhrec.slug(c["name"]) + ".json")
        c["combos"] = json.loads(p.read_text()).get("combos", []) if p.exists() else []


def unit_rows(rows, n, dim):
    m = np.zeros((n, dim), dtype=np.float32)
    for i, feats in enumerate(rows):
        for j, w in feats.items():
            m[i, j] = w
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    norms[norms == 0] = 1
    return m / norms


def idf_vectors(cmds, feats_of):
    """Each commander's features as a unit vector, each feature weighted by how unusual it is (inverse document frequency)."""
    raw = [feats_of(c) for c in cmds]
    df = collections.Counter(k for r in raw for k in r)
    vocab = {k: i for i, k in enumerate(k for k, v in df.items() if v >= 2)}
    n = sum(1 for r in raw if r) or 1
    rows = [{vocab[k]: w * math.log(n / df[k]) for k, w in r.items() if k in vocab} for r in raw]
    return unit_rows(rows, len(cmds), max(1, len(vocab))), raw


def card_feats(c):
    d = c["ed"]
    if not d or d["decks"] < 5:
        return {}
    own = norm(c["name"])
    return {name: syn for name, syn, inc, tag in d["cards"] if syn > 0.04 and norm(name) != own}


def theme_feats(c):
    d = c["ed"]
    if not d or not d["decks"]:
        return {}
    return {t: min(1.0, n / d["decks"]) for t, n in d["tags"]
            if t and t not in SKIP_TAGS and not t.endswith(" Companion") and n / d["decks"] >= 0.02}


def shape(c):
    """The average deck's make-up (shares of its spells) and mana curve, or None without EDHREC data."""
    d = c["ed"]
    if not d or d["decks"] < 5:
        return None
    t = d["types"]
    spells = sum(t[k] for k in ("creature", "instant", "sorcery", "artifact", "enchantment", "planeswalker", "battle")) or 1
    curve = {int(k): v for k, v in (d.get("curve") or {}).items() if str(k).isdigit()}
    mv = sum(k * v for k, v in curve.items()) / (sum(curve.values()) or 1)
    return np.array([t["creature"] / spells, (t["instant"] + t["sorcery"]) / spells, t["artifact"] / spells,
                     t["enchantment"] / spells, t["planeswalker"] / spells, mv / 6], dtype=np.float32)


def avg_bracket(d):
    b = {int(k): v for k, v in (d.get("brackets") or {}).items() if str(k).isdigit()}
    tot = sum(b.values())
    return round(10 * sum(k * v for k, v in b.items()) / tot) if tot >= 5 else 0


def trend(d):
    """How the commander's share of new decks has moved: the last three full months against the three before, as a
    percentage change (0 when there's too little to go on)."""
    t = [x for x in d.get("trend") or [] if x[1] >= 1]
    if len(t) < 7:
        return 0
    t = t[:-1]  # the current month is only partly counted
    recent = sum(x[2] for x in t[-3:]) / 3
    before = sum(x[2] for x in t[-6:-3]) / 3
    if before <= 0:
        return 0
    return max(-99, min(999, round(100 * (recent / before - 1))))


PRIORITY = [r"win the game", r"lose the game", r"damage", r"life loss", r"lifegain|gain life", r"tokens?", r"mill",
            r"\+1/\+1 counters", r"card draw|draw", r"mana", r"storm", r"."]


def combo_line(c):
    """The commander's best-known combo, as "Card + Card|what it makes"."""
    for v in c["combos"]:
        if not v["with"] or len(v["with"]) > 3:
            continue
        makes = v["makes"]
        for pat in PRIORITY:
            hit = [m for m in makes if re.search(pat, m, re.I) and not re.search(r"\b(ETB|LTB|triggers?|casts?)\b", m)]
            if hit:
                return " + ".join(w.split(" // ")[0] for w in v["with"]) + "|" + hit[0][0].lower() + hit[0][1:]
    return ""


DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"
B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"


def link(j, s):
    """A neighbour in three characters: 13 bits of index, 5 of similarity (out of 31)."""
    v = (int(j) << 5) | max(0, min(31, round(s * 31 / 100)))
    return B64[v >> 12 & 63] + B64[v >> 6 & 63] + B64[v & 63]


def b36(n, width):
    n = max(0, min(36 ** width - 1, int(n)))
    out = ""
    for _ in range(width):
        n, r = divmod(n, 36)
        out = DIGITS[r] + out
    return out


def write_card_index(cmds, n):
    """src/cards.json: for cards that matter to some commander's decks, the commanders whose decks run them most, so the
    page can turn the cards named in a player's games ("Card of the game", "What won it?") into picks. Each card keeps
    its top 8 commanders by EDHREC synergy, as link() strings (similarity there is the synergy out of 100). Only cards
    that are on three or more commanders' lists, with a synergy of 0.2 or more for at least one, are kept, and of those
    the 6,000 that the most decks run (the cards people name are mostly the well-known ones)."""
    by_card = collections.defaultdict(list)
    decks_running = collections.Counter()
    for i, c in enumerate(cmds):
        d = c["ed"]
        if not d or d["decks"] < 20 or "#" in c["tags"]:
            continue
        own = norm(c["name"])
        for name, syn, inc, tag in d["cards"]:
            if syn >= 0.08 and inc >= 0.08 and norm(name) != own:
                by_card[name].append((syn * (0.5 + inc), i, syn))
                decks_running[name] += inc * d["decks"]
    keep = [k for k, e in by_card.items() if len(e) >= 3 and max(x[2] for x in e) >= 0.2]
    keep = set(sorted(keep, key=lambda k: -decks_running[k])[:6000])
    names, lists = [], []
    for name, entries in sorted(by_card.items()):
        if name not in keep:
            continue
        top = sorted(entries, reverse=True)[:8]
        names.append(name)
        lists.append("".join(link(i, min(100, round(100 * syn))) for _, i, syn in top))
    meta = json.loads(OUT.read_text(encoding="utf-8"))
    text = json.dumps({"count": n, "names": meta["names"], "cards": names, "by": lists}, separators=(",", ":"), ensure_ascii=False)
    CARDS_OUT.write_text(text, encoding="utf-8")
    print(f"Wrote {CARDS_OUT.relative_to(ROOT)}: {len(names)} cards, {len(text) / 1024:.0f} KB ({len(gzip.compress(text.encode())) / 1024:.0f} KB gzipped)")


def main():
    check = "--check" in sys.argv
    cmds = load_commanders()
    n = len(cmds)
    print(f"{n} commanders; reading Scryfall…", flush=True)
    scryfall_facts(cmds)
    load_edhrec(cmds)
    have = sum(1 for c in cmds if c["ed"])
    print(f"EDHREC pages for {have}; combos for {sum(1 for c in cmds if c['combos'])}", flush=True)
    lead = np.array([0 if "#" in c["tags"] else 1 for c in cmds], dtype=bool)  # Backgrounds can't lead a deck

    cards_v, card_raw = idf_vectors(cmds, card_feats)
    theme_v, theme_raw = idf_vectors(cmds, theme_feats)
    tagger_v, _ = idf_vectors(cmds, lambda c: {t: 1.0 for t in c.get("tagger", [])})
    shapes = [shape(c) for c in cmds]
    has_shape = np.array([s is not None for s in shapes])
    sh = np.stack([s if s is not None else np.zeros(6, dtype=np.float32) for s in shapes])

    print("Comparing every pair…", flush=True)
    card_s = cards_v @ cards_v.T
    theme_s = theme_v @ theme_v.T
    tag_s = tagger_v @ tagger_v.T
    sq = (sh * sh).sum(1)
    d2 = np.maximum(0, sq[:, None] + sq[None, :] - 2 * (sh @ sh.T))
    shape_s = np.exp(-d2 / 0.08) * (has_shape[:, None] & has_shape[None, :])
    # EDHREC's own "similar commanders" (from its deck data) count for a little extra.
    idx = {norm(c["name"]): i for i, c in enumerate(cmds)}
    edh_sim = np.zeros((n, n), dtype=np.float32)
    for i, c in enumerate(cmds):
        for s in (c["ed"] or {}).get("similar", []):
            j = idx.get(norm(s))
            if j is not None:
                edh_sim[i, j] = edh_sim[j, i] = 1
    same = 0.5 * card_s + 0.28 * theme_s + 0.1 * tag_s + 0.12 * shape_s + 0.08 * edh_sim
    across = 0.62 * theme_s + 0.22 * tag_s + 0.16 * shape_s
    np.fill_diagonal(same, -1)
    np.fill_diagonal(across, -1)
    same[:, ~lead] = -1
    across[:, ~lead] = -1
    bits = np.array([sum(1 << "WUBRG".index(x) for x in c["ci"] if x in "WUBRG") for c in cmds])

    # Names, tags and sets as short lists the entries point into.
    tag_names = sorted({t for r in theme_raw for t in r})
    tag_ix = {t: i for i, t in enumerate(tag_names)}
    card_idf = collections.Counter(k for r in card_raw for k in r)
    used_cards, sets = {}, {}

    def card_id(name):
        return used_cards.setdefault(name, len(used_cards))

    def set_id(name):
        return sets.setdefault(name, len(sets)) if name else -1

    out = {"dk": [], "th": [], "nb": [], "nx": [], "sg": [], "br": [], "rl": [], "st": [], "ub": [], "tr": [], "fl": [], "cb": {}, "sh": [], "sa": []}
    for i, c in enumerate(cmds):
        d = c["ed"] or {}
        out["dk"].append(d.get("decks", 0))
        th = sorted(theme_raw[i].items(), key=lambda kv: -kv[1])[:TH]
        out["th"].append([[tag_ix[t], round(100 * s, 1)] for t, s in th])
        order = np.argsort(-same[i])[:NB]
        out["nb"].append([[int(j), round(100 * float(same[i, j]))] for j in order if same[i, j] > 0.15])
        mask = (bits & ~bits[i]) != 0  # brings at least one colour this one doesn't have
        xs = np.where(mask & lead, across[i], -1)
        order = np.argsort(-xs)[:NX]
        out["nx"].append([[int(j), round(100 * float(xs[j]))] for j in order if xs[j] > 0.25])
        top = sorted(card_raw[i].items(), key=lambda kv: -kv[1] * math.log(have / card_idf[kv[0]]))[:SIG]
        out["sg"].append([name for name, _ in top])
        out["br"].append(avg_bracket(d) if d else 0)
        first = c.get("first", "")
        out["rl"].append(int(first[:4] + first[5:7]) if len(first) >= 7 else 0)
        out["st"].append(set_id(c.get("first_set", "")))
        out["ub"].append(set_id(c.get("ub", "")))
        out["tr"].append(trend(d) if d.get("decks", 0) >= 50 else 0)
        out["fl"].append((1 if c.get("gc") else 0) | (2 if not lead[i] else 0))
        # The average deck's shape (shares of creatures, instants and sorceries, artifacts, enchantments and
        # planeswalkers, then average mana value over 6), as six base-36 characters; empty without EDHREC data.
        out["sh"].append("".join(b36(round(min(1, float(v)) * 35), 1) for v in shapes[i]) if shapes[i] is not None else "")
        out["sa"].append(round(10 * d.get("salt", 0)) if d else 0)  # EDHREC's salt score times ten
        cb = combo_line(c)
        if cb:
            out["cb"][str(i)] = cb
    # Signature cards: each commander's top two (the page names them), and any card on two or more lists (the page
    # names the ones a pick shares with a player's deck). The rest would never be shown.
    on = collections.Counter(name for lst in out["sg"] for name in lst)
    out["sg"] = [[card_id(name) for k, name in enumerate(lst) if k < 2 or on[name] >= 2] for lst in out["sg"]]
    out["tags"] = tag_names
    # Themes that are a creature type (and a few groupings like them), so the quiz can judge play style without them.
    groups = {"Sea Creatures", "Outlaws", "Party", "Villains", "Heroes", "Time Lords"}
    mechanics = {"Clues", "Sagas", "Shrines", "Mounts", "Eggs"}  # creature types somewhere, but here they're how a deck plays
    out["tribal"] = [i for i, t in enumerate(tag_names) if (t in CREATURE_TYPES or t in groups) and t not in mechanics]
    out["cards"] = [k for k, _ in sorted(used_cards.items(), key=lambda kv: kv[1])]
    out["sets"] = [k for k, _ in sorted(sets.items(), key=lambda kv: kv[1])]
    out["count"] = n
    out["names"] = hashlib.sha1("\n".join(c["name"] for c in cmds).encode()).hexdigest()[:12]
    plain = {k: out[k] for k in ("nb", "nx", "th", "sg")}
    # The long lists go as fixed-width strings. Being alike goes both ways, so each pair of neighbours is written once,
    # under the one that comes first in the list (the page puts it back on both). Neighbours are three characters each
    # (see link), themes 2 base-36 characters of tag and 2 of share (tenths of a per cent), signature cards 3 of index.
    edges = {}
    for a, lst in enumerate(plain["nb"]):
        for b, sim in lst:
            k = (min(a, b), max(a, b))
            edges[k] = max(edges.get(k, 0), sim)
    mine = collections.defaultdict(list)
    for (a, b), sim in edges.items():
        mine[a].append((b, sim))
    out["nb"] = ["".join(link(b, sim) for b, sim in sorted(mine[a])) for a in range(n)]
    out["nx"] = ["".join(link(j, sim) for j, sim in lst) for lst in plain["nx"]]
    out["th"] = ["".join(b36(t, 2) + b36(s * 10, 2) for t, s in lst) for lst in plain["th"]]
    out["sg"] = ["".join(b36(k, 3) for k in lst) for lst in plain["sg"]]
    text = json.dumps(out, separators=(",", ":"), ensure_ascii=False)
    OUT.write_text(text, encoding="utf-8")
    write_card_index(cmds, n)
    print(f"Wrote {OUT.relative_to(ROOT)}: {len(text) / 1024:.0f} KB ({len(gzip.compress(text.encode())) / 1024:.0f} KB gzipped)")

    if check:
        names = [c["name"] for c in cmds]
        for q in ["Krenko, Mob Boss", "Tuvasa the Sunlit", "Talrand, Sky Summoner", "Edgar Markov", "The Wise Mothman",
                  "Ms. Bumbleflower", "Meren of Clan Nel Toth", "Brudiclad, Telchor Engineer", "Lathril, Blade of the Elves",
                  "Atraxa, Praetors' Voice", "Doctor Doom, King of Latveria", "Cloud, Ex-SOLDIER"]:
            i = idx.get(norm(q))
            if i is None:
                continue
            nb = ", ".join(f"{names[j]} {s}" for j, s in plain["nb"][i][:8])
            nx = ", ".join(f"{names[j]} ({cmds[j]['ci']}) {s}" for j, s in plain["nx"][i][:4])
            themes = ", ".join(f"{tag_names[t]} {s}%" for t, s in plain["th"][i][:5])
            print(f"\n{q} [{cmds[i]['ci']}] {out['dk'][i]} decks · {themes}\n  alike: {nb}\n  across colours: {nx}"
                  f"\n  signature: {', '.join(out['cards'][k] for k in plain['sg'][i][:6])}\n  combo: {out['cb'].get(str(i), '-')}")


if __name__ == "__main__":
    main()
