#!/usr/bin/env python3
"""Rebuild src/commanders.tsv from the MTG Lab card database.

    python3 tools/commanders.py            write src/commanders.tsv
    python3 tools/commanders.py --check    also print the tags for some well-known commanders

One line per card that can be a commander, most popular first (Scryfall's EDHREC rank):

    name <TAB> colour identity <TAB> tags <TAB> complexity

Colour identity is "WUBRG" letters or "C". Tags are single letters: lower case for how the
deck plays, upper case for its flavour (see STYLES and VIBES below; the page has the same
lists), and "#" marks a Background. Complexity is 1 (short and simple) to 3 (lots of text). The tags come from simple
patterns in the rules text, so they are a fair guess rather than a verdict.
"""
import gzip
import json
import pathlib
import re
import sqlite3
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DB = pathlib.Path.home() / "mtg-lab" / "data" / "cards.sqlite"
BULK = pathlib.Path.home() / "mtg-lab" / "data" / "cache" / "oracle_cards.jsonl.gz"
OUT = ROOT / "src" / "commanders.tsv"
WUBRG = "WUBRG"

# How the deck plays. Each pattern is matched against lower-cased rules text with reminder
# text removed and the card's own name replaced by "cardname".
STYLES = {
    "t": ("Tokens", [
        r"\bcreates?\b[^.]*?(\d+/\d+|x/x|creature)[^.]*?\btokens?\b", r"\bpopulate\b", r"\bamass\b",
        r"\bcreature tokens?\b", r"\btokens you control\b", r"\bincubate\b", r"\bfabricate\b", r"\bmyriad\b",
        r"\bcreatures you control get \+\d",
    ]),
    "c": ("+1/+1 counters", [
        r"\+1/\+1 counters?", r"\bproliferate\b", r"\bexperience counters?\b", r"\bmodular\b", r"\bevolve\b",
        r"\bgraft\b", r"\boutlast\b", r"\bbolster\b", r"\badapt\b", r"\bmentor\b", r"\bbackup\b",
    ]),
    "g": ("Graveyard", [
        r"\bfrom (your|a|any|their|an opponent's|target player's|each player's|a player's) graveyards?\b",
        r"\bin (your|a|any) graveyard\b", r"\bgraveyards? to the battlefield\b",
        r"\b(flashback|escape|unearth|dredge|embalm|eternalize|disturb|delve|retrace|jump-start|aftermath|scavenge|encore)\b",
        r"\byou mill\b", r"^mill \w+ cards?\b", r"[.:]\s*mill \w+ cards?\b", r"\bcards? leave your graveyard\b",
        r"\bcreature cards? in your graveyard\b", r"\bsurveil\b",
    ]),
    "s": ("Spells", [
        r"\binstants? (and|or) sorcer(y|ies)\b", r"\bnoncreature spells?\b", r"\bmagecraft\b", r"\bprowess\b",
        r"\bwhenever you cast (an?|your first|your second) (instant|sorcery|noncreature)\b",
        r"\bcopy (target|that) (instant|sorcery|spell)\b", r"\bstorm\b", r"\bsorcery spells?\b", r"\binstant spells?\b",
    ]),
    "a": ("Artifacts", [
        r"\bartifact (spells?|creatures? you control|you control|enters|cards?)\b", r"\bartifacts you control\b",
        r"\b(treasure|clue|food|blood|map|powerstone|gold|junk) tokens?\b", r"\bvehicles?\b", r"\bcrew\b",
        r"\bimprovise\b", r"\baffinity for artifacts\b", r"\bmetalcraft\b", r"\bnoncreature artifacts?\b",
    ]),
    "e": ("Enchantments", [
        r"\benchantment (spells?|you control|enters|cards?)\b", r"\benchantments you control\b", r"\bconstellation\b",
        r"\bauras?\b", r"\bsagas?\b", r"\bshrines?\b", r"\brole tokens?\b", r"\bnonaura enchantments?\b",
    ]),
    "v": ("Voltron", [
        r"\bequip\b", r"\bequipment\b", r"\bequipped\b", r"\benchanted creature\b", r"\battach(ed)?\b",
        r"\bcommander damage\b", r"\bdouble strike\b",
        r"\breconfigure\b", r"\bbestow\b",
    ]),
    "l": ("Lifegain", [
        r"\bgains? (\d+|x|that much|one|two|three|four|five|six|seven|ten)\b[^.]*?\blife\b", r"\bwhenever you gain life\b",
        r"\byou gain life\b", r"\blife you gained\b", r"\bgain life\b",
    ]),
    "x": ("Sacrifice", [
        r"\bsacrifices? (a|an|another|one or more|x|any number of|two|three)\b", r"\bwhenever you sacrifice\b",
        r"\bwhenever (a|another|one or more|a nontoken)\b[^.]*?\b(creatures?|permanents?|artifacts?|tokens?)\b[^.]*?\b(dies|die)\b",
        r"\bexploit\b", r"\bcasualty\b", r"\bemerge\b", r"\bdevour\b",
    ]),
    "k": ("Attacking", [
        r"\bwhenever (cardname|a creature|one or more creatures|another creature|one or more \w+)\b[^.]*?\battacks?\b",
        r"\battacking creatures?\b", r"\badditional combat\b", r"\bextra combat\b", r"\bcombat damage to (a|that) player\b",
        r"\bmyriad\b", r"\bmelee\b", r"\bbattalion\b", r"\braid\b", r"\bexert\b", r"\bdash\b", r"\bwhenever you attack\b",
    ]),
    "b": ("Big creatures", [
        r"\bpower (4|5|6|7|8|9|10) or greater\b", r"\bgreatest power\b", r"\btrample\b", r"\bfights?\b",
        r"\bmana value (5|6|7|8|9|10) or greater\b", r"\bdouble (its|the|that creature's) power\b",
        r"\bformidable\b", r"\bferocious\b", r"\bcreature spells? (you cast )?cost\b",
    ]),
    "d": ("Lands and ramp", [
        r"\blandfall\b", r"\bwhenever a land\b[^.]*?\benters\b", r"\bplay an additional land\b", r"\badditional land\b",
        r"\bplay lands? from\b", r"\blands you control\b", r"\bsearch your library for[^.]*?\blands?\b", r"\bland cards?\b",
        r"\bput (a|up to \w+|x|that) lands?\b[^.]*?\bonto the battlefield\b", r"\bbasic lands?\b",
    ]),
    "r": ("Card draw", [
        r"\bdraws? (a|an additional|two|three|four|five|seven|x|that many|cards equal to)\b", r"\bwhenever you draw\b",
        r"\bdraw cards\b",
    ]),
    "n": ("Control", [
        r"\bcounter target\b", r"\btap target\b", r"\bcan't (attack|block|cast|be cast|untap|activate|draw|search)\b",
        r"\bdestroy (target|all|each)\b", r"\bexile (target|all|each) (nonland |creature|permanent|artifact|enchantment|nontoken)",
        r"\breturn target (nonland )?(permanent|creature)[^.]*?to its owner's hand\b", r"\bdoesn't untap\b",
        r"\bcosts? \{\d\} more\b", r"\beach opponent sacrifices\b", r"\bplayers can't\b", r"\bskips?\b",
    ]),
    "f": ("Blink", [
        r"\bexile\b[^.]*?\bthen return (it|that card|them|those cards|that creature)\b",
        r"\breturn (it|that card|those cards|them) to the battlefield under (its|their) owner's control\b",
        r"\benters or leaves\b",
        r"\bwhenever one or more other creatures (you control )?enter\b", r"\btriggers? an additional time\b",
    ]),
    "h": ("Group hug and politics", [
        r"\beach player (draws|may|gains|creates|puts|searches|adds|returns)\b", r"\beach opponent may\b", r"\bgoad\b",
        r"\bthe monarch\b", r"\bvote\b", r"\bcouncil's dilemma\b", r"\bthe initiative\b",
        r"\btarget (opponent|player) gains control\b", r"\bfor each opponent who\b", r"\bany player may\b",
        r"\b(target|an|that) opponent (draws|creates|gains|may)\b", r"\bgift\b",
    ]),
    "z": ("Chaos", [
        r"\bflip (a|\w+) coins?\b", r"\broll (a|\w+|one or more) (d\d+|dice|die|six-sided|twenty-sided|four-sided)\b",
        r"\bat random\b", r"\brandom(?! order)\b", r"\bcascade\b", r"\bdiscover \d\b", r"\bplanar die\b", r"\bchaos\b",
    ]),
    "m": ("Mill", [
        r"\b(target|each) (player|opponent)s? mills?\b", r"\b(that player|each opponent|target opponent) mills\b",
        r"\bputs? the top[^.]*?cards? of (his or her|their|target player's|each opponent's) library into\b",
        r"\bare milled\b", r"\bcards? milled\b", r"\brad counters?\b",
    ]),
    "p": ("Drain and burn", [
        r"\beach opponent loses (\d+|x|that much|one|two|three|four|five|half)\b",
        r"\bdeals? (\d+|x|that much) damage to each (opponent|player)\b", r"\bloses? life equal\b",
        r"\btarget (opponent|player) loses (\d+|x|one|two|three) life\b",
        r"\bdeals? damage equal to[^.]*?\bto (any target|each opponent|target (player|opponent)|each player)\b",
        r"\bdeals? (\d+|x) damage to any target\b", r"\bextort\b", r"\bafflict\b",
    ]),
    "i": ("Poison", [r"\binfect\b", r"\btoxic\b", r"\bpoison counters?\b", r"\bpoisonous\b", r"\bcorrupted\b"]),
    "o": ("Stealing", [
        r"\bgain control of\b", r"\b(cards|spells|permanents) (your )?opponents? own\b", r"\byou don't own\b",
        r"\bfrom (an opponent's|each opponent's|target opponent's|that player's) (library|hand|graveyard)\b",
        r"\bexile the top card of (each|target) (player's|opponent's) library\b",
    ]),
    "q": ("Copies", [r"\bcopy of\b", r"\bcopy (target|that|it|each)\b", r"\bbecomes? a copy\b", r"\bcopies\b"]),
}
TRIBAL_WORDS = [
    r"\bchoose a creature type\b", r"\bcreature type of your choice\b", r"\bshares? a creature type\b", r"\bchangeling\b",
    r"\bchosen type\b", r"\bof the chosen creature type\b",
]

# Flavour, from the creature types on the card (and "Artifact Creature" for robots).
VIBES = {
    "C": ("Cute critters", "Cat Dog Rabbit Mouse Otter Frog Squirrel Bat Raccoon Hamster Fox Bird Lizard Weasel Badger Mole "
                           "Hedgehog Turtle Possum Monkey Ferret Owl Bear Goat Sheep Unicorn Horse Porcupine Beaver Skunk "
                           "Armadillo Capybara Sloth Penguin Hare Hamster Kitten Puppy Elk Deer Boar"),
    "S": ("Spooky", "Zombie Vampire Spirit Horror Demon Skeleton Werewolf Wraith Specter Nightmare Shade Devil Imp Lich Ghost"),
    "D": ("Dragons and dinosaurs", "Dragon Dinosaur Hydra Leviathan Kraken Wurm Giant Eldrazi Behemoth Titan Elder Kaiju"),
    "W": ("Wizards", "Wizard Warlock Sorcerer Bard Sphinx"),
    "N": ("Nature and elves", "Elf Druid Treefolk Dryad Fungus Saproling Plant Satyr Centaur Nymph"),
    "P": ("Pirates and the sea", "Pirate Merfolk Octopus Kraken Serpent Crab Fish Whale Shark Siren Leviathan Jellyfish "
                                 "Starfish Squid Turtle"),
    "K": ("Knights and angels", "Knight Samurai Angel Archon"),
    "R": ("Robots and gadgets", "Construct Golem Thopter Myr Robot Servo Gnome Cyborg Drone Vehicle"),
    "U": ("Crossovers", ""),  # Universes Beyond: Final Fantasy, Marvel, Doctor Who, Fallout and friends
}

# Subtypes that can sit on a kindred card but aren't creature types.
NOT_CREATURE_TYPES = set("""— Equipment Aura Vehicle Saga Shrine Class Case Room Background Curse Cartouche Rune Role Food
    Treasure Clue Blood Gold Map Powerstone Junk Incubator Fortification Contraption Attraction Lesson Adventure Arcane Trap
    Omen Spacecraft Planet Siege Plan""".split())

IRREGULAR = {"Elf": "Elves", "Dwarf": "Dwarves", "Wolf": "Wolves", "Werewolf": "Werewolves", "Mouse": "Mice",
             "Fungus": "Fungi", "Octopus": "Octopuses", "Homunculus": "Homunculi", "Pegasus": "Pegasi",
             "Cyclops": "Cyclopes", "Ox": "Oxen", "Sphinx": "Sphinxes", "Fox": "Foxes", "Faerie": "Faeries",
             "Ally": "Allies", "Fish": "Fish", "Sheep": "Sheep", "Djinn": "Djinn", "Treefolk": "Treefolk",
             "Merfolk": "Merfolk", "Kithkin": "Kithkin", "Moonfolk": "Moonfolk", "Samurai": "Samurai",
             "Ninja": "Ninja", "Thrull": "Thrulls", "Leech": "Leeches", "Lich": "Liches", "Witch": "Witches"}


def plural(t):
    if t in IRREGULAR:
        return IRREGULAR[t]
    if t.endswith(("s", "x", "ch", "sh")):
        return t + "es"
    if t.endswith("y") and t[-2:-1] not in "aeiou":
        return t[:-1] + "ies"
    return t + "s"


def clean_text(name, text):
    text = re.sub(r"\([^)]*\)", "", text)  # reminder text
    names = {name}
    for part in name.split(" // "):
        names.add(part)
        names.add(part.split(",")[0])
    for n in sorted(names, key=len, reverse=True):
        if len(n) > 2:
            text = text.replace(n, "cardname")
    return text


def creature_types(type_line):
    front = type_line.split(" // ")[0]
    if "—" not in front:
        return []
    return front.split("—", 1)[1].split()


def load_ub_names():
    """Names of Universes Beyond cards, from Scryfall's bulk file (skipped if it isn't there)."""
    if not BULK.exists():
        return set()
    out = set()
    with gzip.open(BULK, "rt", encoding="utf-8") as f:
        for line in f:
            c = json.loads(line)
            if "universesbeyond" in (c.get("promo_types") or []):
                out.add(c["name"])
    return out


def main():
    check = "--check" in sys.argv
    con = sqlite3.connect(DB)
    rows = con.execute("""SELECT name, color_identity, type_line, oracle_text, layout, edhrec_rank, faces, power
                          FROM cards WHERE legal_commander = 1""").fetchall()
    all_types = set()
    for (tl,) in con.execute("SELECT type_line FROM cards WHERE type_line LIKE '%Creature%' OR type_line LIKE '%Tribal%' OR type_line LIKE '%Kindred%'"):
        for part in tl.split(" // "):
            if re.search(r"\b(Creature|Tribal|Kindred)\b", part.split("—")[0]):
                all_types.update(creature_types(part))
    all_types = {t for t in all_types - NOT_CREATURE_TYPES if re.fullmatch(r"[A-Z][a-z'-]+", t) and (len(t) > 2 or t == "Ox")}
    type_alt = "|".join(sorted({re.escape(t) for t in all_types} | {re.escape(plural(t)) for t in all_types}, key=len, reverse=True))
    tribal_re = re.compile(
        r"\b(?:other|each|number of|non)[- ](?:" + type_alt + r")\b|\b(?:" + type_alt + r")(?: (?:spells?|cards?|creatures? you control|you control|permanents?))\b"
        r"|\b(?:" + type_alt + r") (?:you control )?(?:get|gets|have|has)\b")
    style_res = {k: [re.compile(p) for p in pats] for k, (_, pats) in STYLES.items()}
    tribal_extra = [re.compile(p) for p in TRIBAL_WORDS]
    vibe_sets = {k: set(words.split()) for k, (_, words) in VIBES.items()}
    ub = load_ub_names()

    out = []
    for name, ci, tl, text, layout, rank, faces, power in rows:
        front_tl = tl.split(" // ")[0]
        texts = text or ""
        if faces:
            try:
                fs = json.loads(faces)
                if fs:
                    front_tl = fs[0].get("type_line", front_tl) or front_tl
                    texts = "\n".join((f.get("oracle_text") or "") for f in fs) or texts
            except ValueError:
                pass
        is_cmd = ("Legendary" in front_tl and "Creature" in front_tl) or "can be your commander" in texts \
            or ("Background" in front_tl and "Legendary" in front_tl)
        if not is_cmd:
            continue
        cis = json.loads(ci)
        cistr = "".join(c for c in WUBRG if c in cis) or "C"
        disp = name.split(" // ")[0] if layout in ("transform", "modal_dfc", "flip", "adventure", "split", "meld", "reversible_card") else name

        body = clean_text(name, texts)
        low = body.lower()
        tags = [k for k, res in style_res.items() if any(r.search(low) for r in res)]
        # Case matters for creature types ("Elves you control"), so the tribal check reads the original text.
        if tribal_re.search(body.replace("cardname", "")) or any(r.search(low) for r in tribal_extra):
            tags.append("y")
        try:
            if power and float(power) >= 6 and "b" not in tags:
                tags.append("b")
        except ValueError:
            pass
        types = set(creature_types(front_tl))
        for k, words in vibe_sets.items():
            if types & words:
                tags.append(k)
        if front_tl.startswith("Legendary Artifact Creature") and "R" not in tags:
            tags.append("R")
        if name in ub or disp in ub:
            tags.append("U")
        if "Background" in front_tl:
            tags.append("#")  # a Background needs a commander that chooses one, so it's never suggested on its own

        lines = [ln for ln in body.split("\n") if ln.strip()]
        size = len(body)
        cx = 1 if size < 140 and len(lines) <= 2 else 3 if size > 270 or len(lines) >= 4 else 2
        out.append((rank if rank is not None else 10 ** 9, disp, cistr, "".join(tags), cx))

    out.sort()
    seen, final = set(), []
    for r, n, c, t, x in out:
        if n.lower() in seen:
            continue
        seen.add(n.lower())
        final.append((n, c, t, x))
    OUT.write_text("\n".join(f"{n}\t{c}\t{t}\t{x}" for n, c, t, x in final), encoding="utf-8")
    print(f"{len(final)} commanders written to {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.0f} KB)")

    if check:
        from collections import Counter
        freq = Counter(ch for _, _, t, _ in final for ch in t)
        labels = {k: v[0] for k, v in STYLES.items()} | {k: v[0] for k, v in VIBES.items()} | {"y": "Tribal"}
        print("\nHow many commanders carry each tag:")
        for k, v in sorted(freq.items(), key=lambda kv: -kv[1]):
            print(f"  {k}  {labels.get(k, k):24} {v}")
        print("\nComplexity:", Counter(x for *_, x in final))
        by_name = {n: (c, t, x) for n, c, t, x in final}
        for n in ["Krenko, Mob Boss", "Edgar Markov", "Atraxa, Praetors' Voice", "Meren of Clan Nel Toth", "Talrand, Sky Summoner",
                  "Lathril, Blade of the Elves", "Tuvasa the Sunlit", "The Wise Mothman", "Doctor Doom, King of Latveria",
                  "Cloud, Ex-SOLDIER", "Juri, Master of the Revue", "Tom Bombadil", "Samut, Vizier of Naktamun", "Pramikon, Sky Rampart",
                  "Selvala, Heart of the Wilds", "Ms. Bumbleflower", "Zurzoth, Chaos Rider", "Octavia, Living Thesis",
                  "Extus, Oriq Overlord", "Zndrsplt, Eye of Wisdom", "Korvold, Fae-Cursed King", "Muldrotha, the Gravetide",
                  "The Ur-Dragon", "Yuriko, the Tiger's Shadow", "Kenrith, the Returned King", "Brago, King Eternal",
                  "Karlach, Fury of Avernus", "Arcades, the Strategist", "Lord Windgrace", "Syr Konrad, the Grim",
                  "Hinata, Dawn-Crowned", "Ygra, Eater of All", "Zur the Enchanter", "Etali, Primal Storm", "Wilson, Refined Grizzly"]:
            c, t, x = by_name.get(n, ("?", "?", "?"))
            print(f"  {n:34} {c:6} cx{x}  " + ", ".join(labels.get(ch, ch) for ch in t))


if __name__ == "__main__":
    main()
