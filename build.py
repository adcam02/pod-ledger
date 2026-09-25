#!/usr/bin/env python3
"""Build the site, the old link's page and the local preview.

    python3 build.py

Writes docs/, the site GitHub Pages serves: index.html from src/index.template.html
plus the commander list in src/commanders.tsv, and the icons and manifest from
src/site/. Writes apps-script/Index.html, the "we've moved" page the old Apps Script
link now shows (src/moved.html pointing at LEDGER_LINK). And writes dev/preview.html,
the app wired to an in-memory pretend spreadsheet (dev/mock-gas.js running the real
Code.gs) for testing locally.
"""
import hashlib
import json
import pathlib
import re
import shutil

ROOT = pathlib.Path(__file__).resolve().parent
MARKER = '/*__COMMANDERS__*/""'
APP_SCRIPT_START = "<script>\n(function () {"
LINK = re.compile(r'const LEDGER_LINK = "(https://[^"]+)";')
# Preview only: stand in a commander as the leader, to try the banner art and colours it brings.
SAMPLES = [
    ("", "The real leader"),
    ("Brudiclad, Telchor Engineer", "Brudiclad (blue, red)"),
    ("Krenko, Mob Boss", "Krenko (red)"),
    ("Talrand, Sky Summoner", "Talrand (blue)"),
    ("Heliod, Sun-Crowned", "Heliod (white)"),
    ("K'rrik, Son of Yawgmoth", "K'rrik (black)"),
    ("Meren of Clan Nel Toth", "Meren (black, green)"),
    ("Teysa Karlov", "Teysa (white, black)"),
    ("Kinnan, Bonder Prodigy", "Kinnan (green, blue)"),
    ("Tuvasa the Sunlit", "Tuvasa (Bant: green, white, blue)"),
    ("Edgar Markov", "Edgar Markov (Mardu: red, white, black)"),
    ("Atraxa, Praetors' Voice", "Atraxa (four colours: usual look)"),
]
SAMPLE_PICKER = (
    '<div id="samplePicker" style="position:fixed;left:12px;bottom:12px;z-index:9999;padding:8px 10px;border-radius:12px;'
    'background:rgba(20,16,40,.92);color:#fff;font:600 13px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.4)">'
    '<label>Preview leader <select id="sampleSel" style="font:inherit;margin-left:6px">'
    + "".join('<option value="%s">%s</option>' % (v.replace('"', "&quot;"), label) for v, label in SAMPLES)
    + '</select></label></div>\n'
    '<script>document.getElementById("sampleSel").addEventListener("change", function (e) {'
    ' window.__previewCommander = e.target.value;'
    ' var p = document.getElementById("period"); p.dispatchEvent(new Event("change", { bubbles: true })); });</script>\n'
)


def copy_site(dest):
    for f in sorted((ROOT / "src" / "site").iterdir()):
        if f.is_file() and not f.name.startswith("."):
            shutil.copyfile(f, dest / f.name)


def main():
    template = (ROOT / "src" / "index.template.html").read_text(encoding="utf-8")
    commanders = (ROOT / "src" / "commanders.tsv").read_text(encoding="utf-8")
    if template.count(MARKER) != 1:
        raise SystemExit("The template must contain the commander marker exactly once.")
    literal = (json.dumps(commanders, ensure_ascii=False)
               .replace("</", "<\\/")
               .replace(" ", "\\u2028")
               .replace(" ", "\\u2029"))
    page = template.replace(MARKER, literal)

    docs = ROOT / "docs"
    docs.mkdir(exist_ok=True)
    (docs / "index.html").write_text(page, encoding="utf-8")
    (docs / ".nojekyll").write_text("", encoding="utf-8")
    copy_site(docs)

    links = LINK.findall(template)
    if len(links) != 1:
        raise SystemExit("Could not find the LEDGER_LINK constant in the template.")
    moved = (ROOT / "src" / "moved.html").read_text(encoding="utf-8")
    if "__NEW_LINK__" not in moved:
        raise SystemExit("src/moved.html has lost its __NEW_LINK__ placeholders.")
    moved = moved.replace("__NEW_LINK__", links[0])
    (ROOT / "apps-script" / "Index.html").write_text(moved, encoding="utf-8")
    (ROOT / "dev" / "moved.html").write_text(moved, encoding="utf-8")

    if page.count(APP_SCRIPT_START) != 1:
        raise SystemExit("Could not find where the page script starts.")
    shutil.copyfile(ROOT / "apps-script" / "Code.gs", ROOT / "dev" / "code.js")
    # A version tag on each script, so the browser never runs a stale copy of the mocks.
    shim = "".join('<script src="%s?v=%s"></script>\n' % (name, hashlib.sha1((ROOT / "dev" / name).read_bytes()).hexdigest()[:8])
                   for name in ("mock-gas.js", "code.js", "mock-run.js"))
    preview = page.replace(APP_SCRIPT_START, shim + APP_SCRIPT_START, 1)
    preview = preview.replace("</body>", SAMPLE_PICKER + "</body>", 1)
    (ROOT / "dev" / "preview.html").write_text(preview, encoding="utf-8")
    copy_site(ROOT / "dev")

    size = (docs / "index.html").stat().st_size
    print(f"docs/index.html         {size / 1024:.0f} KB, plus {len(list((ROOT / 'src' / 'site').iterdir()))} icon and manifest files")
    print(f"apps-script/Index.html  the moved page, pointing at {links[0]}")
    print("dev/preview.html        built, and dev/moved.html to look at the moved page")


if __name__ == "__main__":
    main()
