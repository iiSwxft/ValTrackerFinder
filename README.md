# ValTrackerFinder

Browser extension for [tracker.gg](https://tracker.gg/valorant) Valorant profiles: find every match a profile shared with a specific player.

Open any Valorant profile on tracker.gg, type a `name#tag` into the panel, hit Scan. The extension walks the profile's match history through TRN's own internal API, pulls each match's full roster, and lists every game the two players shared — map, date, agents, who won, and whether they were teammates or opponents, with direct links to the match pages.

Built for the "CHEATER BANNED — RR refund" flow: Riot tells you someone you reported got banned, tracker.gg's Encounters tab doesn't tell you which game was yours. This does.

## Install

No build step. Load the folder as-is.

**Chrome / Edge / Brave / Opera / Arc** (Manifest V3)

1. Open `chrome://extensions` (or `edge://extensions`, etc.)
2. Enable **Developer mode**
3. **Load unpacked** → select this folder

**Firefox** (109+)

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on** → select `manifest.json` in this folder

For a permanent Firefox install, sign it once at [addons.mozilla.org](https://addons.mozilla.org/developers/) (self-hosted, unlisted) and install the signed `.xpi`.

Mobile browsers are not supported.

## Usage

1. Go to a Valorant profile on tracker.gg (e.g. `tracker.gg/valorant/profile/riot/someone%23tag/overview`)
2. Click the **MATCH FINDER** tab on the right edge of the page
3. Enter the target player's `name#tag`, pick a playlist, set scan depth
4. Scan. Each hit links straight to the match page.

**Scan depth**: matches are scanned 20 per page. Default 15 pages ≈ 300 matches back. If the shared game is older, raise the cap.

**Playlist**: Competitive, Premier, Unrated, Deathmatch, or All. Cheater-refund games are basically always Competitive.

## How it works

No scraping, no auth, no API keys. The extension calls the same two endpoints tracker.gg's own frontend uses:

- `GET api.tracker.gg/api/v2/valorant/standard/matches/riot/{owner}?type={playlist}&next={n}` — match list, paginated by `metadata.next`
- `GET api.tracker.gg/api/v2/valorant/standard/matches/{matchId}` — full match detail; rosters and teams are reconstructed from its segments

Concurrency is capped at 4 in-flight detail fetches with backoff on 429/5xx.

## Notes

- Match detail payloads are ~1.3 MB each; deep scans move real bandwidth.
- The target tag must be exact; names are case- and whitespace-insensitive.
- Scan runs entirely in your browser. Nothing is sent anywhere except tracker.gg's own API.
