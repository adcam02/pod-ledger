# Commander Pod Ledger

**Live link:** https://adcam02.github.io/pod-ledger/

A shared game log for the Commander group. Anyone with the link can log a game, and the page
shows standings, commander records, a history of games and a Stats tab for the group as a whole.
Every game is stored as one row in a Google Sheet that you own, so nobody else needs an account.

## How it fits together

- **The page** is a static site on GitHub Pages, published from the `docs/` folder of the
  [adcam02/pod-ledger](https://github.com/adcam02/pod-ledger) repository (public, because free
  GitHub Pages needs that; the page carries a `noindex` tag so search engines leave it alone).
- **The data** lives in the "Commander Pod Ledger" spreadsheet in the adcam02@gmail.com Google Drive.
  Its Apps Script project (Extensions → Apps Script) is the ledger's server: the page sends each
  request to the web app's `/exec` address (`API_URL` near the top of the page's script) as a small
  JSON message, and `doPost` in `Code.gs` answers it.
- **The old link** (`https://script.google.com/a/~/macros/s/AKfycbyy…/exec`, first shared 24 September
  2026) is the same Apps Script deployment. Its `doGet` now shows a "We've moved" page with the new link
  and a Copy link button, so old bookmarks and group chat links still lead people to the right place.
- **Board photos** go to a Drive folder called "Commander Pod Ledger photos", shared so that anyone with
  a photo's link can view it. The Games tab keeps each game's photo link in the "Board photo" column.

## Files

| Path | What it is |
|---|---|
| `src/index.template.html` | Source for the page; edit this, then run the build |
| `src/commanders.tsv` | Every card that can be a commander, with colour identity, theme tags and a complexity score (from `~/mtg-lab/data/cards.sqlite`, Scryfall data of 16 Aug 2026) |
| `src/moved.html` | Source for the "We've moved" page the old link shows |
| `src/site/` | The app icons and web app manifest, copied into `docs/` by the build |
| `src/icons/` | Versions of the icon for iPhones and Android; `sh tools/icons.sh` turns them into the PNGs in `src/site/` |
| `docs/` | The published site (built; don't edit by hand) |
| `apps-script/Code.gs` | The server: reads and writes the "Games" tab, stores photos, answers the page's requests |
| `apps-script/Index.html` | The moved page (built from `src/moved.html`) |
| `apps-script/appsscript.json` | The Apps Script manifest: time zone, web app settings, the Drive service and the two permissions the script asks for |
| `tools/commanders.py` | `python3 tools/commanders.py` rebuilds `src/commanders.tsv`; add `--check` to print the tags for some well-known commanders |
| `build.py` | `python3 build.py` rebuilds `docs/`, `apps-script/Index.html` and the local preview |
| `dev/` | Local testing: an in-memory pretend spreadsheet running the real `Code.gs` |

## Updating the page

1. Edit `src/index.template.html` and run `python3 build.py`.
2. On GitHub, open the repository's `docs` folder, choose **Add file → Upload files**, drop in the new
   `docs/index.html` (and any other changed files from `docs/`) and **Commit changes**. The site updates
   within a minute or two.

## Updating the server

Paste the new `Code.gs` (and `Index.html`, if the moved page changed) over the old ones in the Apps
Script editor, save, then choose **Deploy → Manage deployments → pencil icon → Version: New version →
Deploy**. Keep using that one deployment: both the page's `API_URL` and the old link point at it.

If a new server version misbehaves, go back to **Manage deployments**, edit the deployment and pick the
previous version number. Version 13 is the last one that served the whole app from the old link.

## Setting it up from scratch

This is how the original spreadsheet and web app were made; it is only needed to rebuild everything
in another Google account. After step 7, put that account's `/exec` address in `API_URL`, rebuild,
and publish `docs/` somewhere (GitHub Pages as above).

1. Open [sheets.new](https://sheets.new) while signed in to Google and name the spreadsheet "Commander Pod Ledger".
2. Choose **Extensions → Apps Script**. A project opens with a file called `Code.gs`.
3. Replace everything in `Code.gs` with `apps-script/Code.gs` (`pbcopy < apps-script/Code.gs` copies it).
4. Click **+** next to Files, choose **HTML**, and name it `Index`. Replace its contents with
   `apps-script/Index.html` (`pbcopy < apps-script/Index.html`). Save with Cmd+S.
   In **Project Settings**, tick "Show appsscript.json manifest file in editor" and replace that
   file with `apps-script/appsscript.json` (it turns on the Drive service for photos).
5. Choose **Deploy → New deployment**, click the gear next to "Select type" and pick **Web app**.
   Set **Execute as: Me** and **Who has access: Anyone**, then **Deploy**.
6. Authorise it. Google warns that it hasn't verified the app, which is normal for a script you
   wrote yourself: choose **Advanced → Go to … (unsafe) → Allow**. The script only asks for
   access to this one spreadsheet and to the Drive files it creates itself (the board photos).
7. Copy the **Web app URL** (it ends in `/exec`).

If "Anyone" is missing in step 5, the Google account is a work account whose admin blocks public
web apps. Use a personal Google account instead.

## Looking after the data

- The **Players** tab sets the names in the page's player dropdowns, one per row, in order. Add or remove
  someone there; no code change is needed. A game can seat up to 8 players. For anyone else, pick
  "Someone else…" and type their name. They show with a "guest" tag and aren't added to the tab.
- **Start of the game:** the log form's optional "Start of the game" section records who went first (the "Went first"
  column, stored by name) and each player's mulligans (0 to 4+). Mulligans live in 8 columns after the knockout columns
  ("P1 mulligans" to "P8 mulligans"), added on the first save after the feature arrived; blank means not logged, 0 means
  they kept their first seven. Stats has "Going first" and "Mulligans" panels, and player pages an "Openings" panel.
- **Group generator:** pick how many people, choose each person (or a guest), and it splits them into groups,
  favouring people who haven't played each other lately, rematches and evenly matched groups. "Save for
  everyone" stores the draw in the Settings tab (row 3) so the whole pod sees tonight's groups.
- **Sharing groups:** after a draw (and under saved groups) there's a "Share to the group chat" button. On a phone it
  opens the share sheet, so Messenger is one tap away; on a computer it copies the groups to paste instead. The message
  ends with the ledger link, which is the `LEDGER_LINK` constant near the top of the page's script. The build also
  puts that link on the moved page, so change it there if the site ever moves again.
- **Discover:** a random commander roller (filters for colours, theme and popularity), a five-question quiz, picks
  for each player based on the themes and colours of the decks they've played, and a shortlist of saved commanders.
  The quiz answers and the shortlist live in each person's browser, so nothing about them is stored in the sheet.
  The themes come from `tools/commanders.py`, which reads each card's rules text, so they're a good guess, not gospel.
- **Splash message:** the little yellow box by the pod name shows a random message on each visit, sometimes about the
  pod itself (the leader, a win streak, a commander suggestion). Tap it for another.
- **Player pages:** tap any player's name for their record, commanders, head-to-heads, form over time, knockouts and
  commanders to try.
- **Knockouts:** the log form has an optional Knockouts section: each player's finishing place, who knocked them out and
  how. They're stored in 24 columns at the far right of the Games tab ("P1 place", "P1 knocked out by", "P1 how" and so on
  for each seat), added the first time a game is saved after this feature arrived. Older games leave them blank. The
  winner's place is written as 1 only when someone else in the game has a place.
- **Standings:** Won, Win %, **Outlasted** (opponents who went out before you; a win outlasts the whole table, and games
  without knockouts only count the winner's) and **vs average** (wins compared with an average player's at the same table
  sizes, which used to be called "vs par"). The page explains all four under the table.
- **Stats** also shows how people go out, kills, finishing places, the deadliest decks, and deck speed (fastest wins,
  shortest and longest games, from finishing turns and game lengths).
- **Scryfall:** every commander row and deck name links to the card on Scryfall (partner decks show both cards).
- **Light and dark:** the button next to "Log a game" cycles Auto, Light and Dark, remembered per browser.
- **The look** ("Arcade": gradient titles, frosted glass panels) is switched on by `data-look="arcade"` on the page's
  `<html>` tag, and its styles are grouped at the end of the page's CSS. The art behind the header is the main commander
  of whoever leads the standings for the chosen period.
- **Board photos:** the log form's Extras section takes one photo per game (camera or photo library). The page shrinks
  it to 1600 pixels on the long side before it uploads, so it goes up quickly over phone data. Photos show on the game
  cards and open full size in Drive. Replace or Remove works when editing a game; a removed photo stays in the Drive
  folder, so delete it there if it should go for good.
- **Home screen:** the site has an icon and a web app manifest, so "Add to Home Screen" (iPhone, from Safari's Share
  menu) or "Add to Home screen" (Android) gives it an app icon that opens without the browser bars.
- **Deleting a game** asks first in a pop-up that names the game. After deleting there's an Undo, and the row stays in
  the sheet marked `deleted`.
- **Weekly backups:** every Monday between midnight and 1am, a time-driven trigger runs `weeklyBackup`, which copies the
  Games tab to a hidden tab named "Backup yyyy-mm-dd" and keeps the latest eight. See them with **View → Hidden sheets**
  in the spreadsheet. To restore, unhide a backup and copy its rows back into Games. The trigger is on the Apps Script
  project's **Triggers** page (clock icon). A run within six days of the last backup does nothing, and each run leaves a
  line on the **Executions** page saying what it did.
- The **Games** tab has one row per game. Fix a typo in any cell and the page picks it up on its next refresh.
- Commander art is fetched from Scryfall by each visitor's browser and remembered there, so nothing about it is stored in the sheet.
- Deleting a game in the page only marks its row `deleted`; clear that cell to bring it back.
  **File → Version history** in the sheet can roll back anything else.
- Anyone with the link can add, edit or delete games, so keep the link within the group. The repository is public,
  so someone who went looking could find the link there too; the weekly backups and the sheet's version history are
  the safety net if that ever matters.

## Testing locally

- `deno run --allow-read dev/test_code.js` runs round-trip tests of `Code.gs` against the pretend spreadsheet.
- The `pod-ledger` entry in `~/.claude/launch.json` serves `dev/`. Open `preview.html` (empty spreadsheet),
  `preview.html?seed` (a dozen games already logged) or `preview.html?offline` (not connected), and `moved.html`
  for the moved page. The preview never talks to the real sheet; photos go to a pretend Drive, so they
  show as missing on the cards.
- `dev/preview.html`, `dev/moved.html`, `dev/code.js` and the icon files in `dev/` are build output.
