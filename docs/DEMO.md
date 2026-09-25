# Presenting pixelguard

A walkthrough for showing pixelguard to an audience: what to set up, what to run, what to say, and what to do if something goes wrong. Ticket: P049.

**The story in one sentence:** a release changes two things on a shop. One is harmless (a date), one is a real bug (a broken pricing layout). A pixel diff flags both. pixelguard's AI judge tells them apart and explains why.

## Before you present

Do this the day before, on the machine you'll present from.

- [ ] `npm ci` and `npx playwright install --with-deps chromium`
- [ ] Put your Anthropic key in `.env`: `LLM_API_KEY=sk-ant-...`
- [ ] Do a full rehearsal: `npm run demo -- --step --dashboard`
- [ ] Check the offline backup works: `npm run demo -- --scripted-judge` (no internet or key needed; see [If something goes wrong](#if-something-goes-wrong))
- [ ] Make sure nothing else is using port 8100 (or pick another with `--port 9000`)
- [ ] Make the terminal font big, and use a light terminal theme if the room is bright
- [ ] Keep the README screenshots handy (`docs/images/`) in case the machine won't cooperate

**On the day:** put a terminal and a browser side by side. The demo prints every URL you need.

## The 5-minute version

Run everything with one command, pausing at each step so you can talk:

```bash
npm run demo -- --step --dashboard
```

| Step | Press Enter to…      | Say                                                                                                                                                                                                       | They see                                                                                                                    |
| ---- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 0    | —                    | "Visual regression tools compare screenshots before and after a change. Their problem is noise: every pixel that moves gets flagged, so people stop looking."                                             | The demo shop's URL, with links to version 1 and 2 of the pricing page                                                      |
| 1    | capture the baseline | "This is our shop as it is today: three pages, desktop and mobile."                                                                                                                                       | `✓ /  desktop, mobile` … `Saved 6 screenshot(s)`                                                                            |
| 2    | ship version 2       | "Now a developer ships a release. They meant to update a date on the home page. They also broke the pricing layout by accident with one CSS line. Nobody noticed."                                        | `Demo site switched to version 2…` and a second capture                                                                     |
| 3    | diff and judge       | "The pixel diff finds four changed screenshots. A normal tool stops here and makes you check all four. pixelguard asks a vision model about each one, and tells it what the release was meant to change." | The diff table, then `Judging 4 changed screenshot(s)`, then the verdicts                                                   |
| 3    | (point at the end)   | "The date change is **Acceptable**. The pricing page is a **Real Bug**, with confidence and reasons. The live clock at the top of every page was never flagged, because it's marked as dynamic content."  | `✗ pricing  FAIL  Real Bug…`, `✓ home  PASS  Acceptable changes…`, `✗ FAIL: 2 real bugs on 1 page, 2 acceptable changes`    |
| 4    | open the dashboard   | "Everything is saved. Here is the run."                                                                                                                                                                   | The dashboard URL. Open it: the run, pricing first, with the judge's explanation and baseline / current / diff side by side |

**Close with:** "In CI, this runs on every pull request, and only real bugs fail the build. Harmless changes are reported without blocking anyone."

## The 10-minute version

Do the 5-minute version, then show the dashboard in more depth.

1. **The evidence.** On the run page, scroll to _pricing → mobile_. Point out _"Page size: width 390px → 836px"_: the broken cards made the mobile page scroll sideways. Click the **Diff** image to open it full size. Magenta marks where the page grew.
2. **Compare the real pages.** Open the demo shop's pricing page with `?version=1` and `?version=2` side by side. The URLs are printed by the demo.
3. **Accept the intended change.** On the _home_ page, click **Accept this page** → **Yes, accept this page**. "The date change was intended, so it becomes the new baseline. Only for that page. The pricing bug stays flagged."
4. **Undo is always possible.** Open **Baselines**: version 1 is the original, version 2 is the accept you just did. Every version can be restored.
5. **Trend.** Open **Trend**: one run so far. "Over weeks, this shows whether quality is improving: failing pages, pages needing review and real bugs per day."
6. **Sharing it safely.** "The dashboard has no login, so for a team you run it read-only behind a password" (`--read-only`, see [DEPLOYMENT.md](DEPLOYMENT.md)).
7. **How it's built** (for technical audiences): TypeScript, Playwright, pixelmatch, the Anthropic API, SQLite and a small Express dashboard, with hundreds of unit, API, browser and end-to-end tests. The end-to-end test runs exactly this demo.

## Running the steps by hand

To type each command yourself (it looks more "real" to some audiences), serve the shop and point pixelguard at it:

```bash
npm run demo:site                              # terminal 1: http://localhost:3000
```

```bash
# terminal 2, with TARGET_BASE_URL=http://localhost:3000 and TARGET_PAGES=/,/pricing,/blog in .env
cp examples/demo-site/pixelguard.regions.json .
npm run pixelguard -- capture --tag baseline
# stop terminal 1 and restart it as version 2:  npm run demo:site -- --version 2
npm run pixelguard -- capture --tag current
npm run pixelguard -- diff --baseline baseline --current current --judge \
  --change "Updated the 'last updated' date on the homepage."
npm run pixelguard -- dashboard
```

## If something goes wrong

| Problem                                     | What to do                                                                                                                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No internet, or the API key doesn't work    | Run `npm run demo -- --step --dashboard --scripted-judge`. The demo uses a scripted judge with pre-written verdicts for this site and makes no API calls. **Say so**: it's labelled `scripted-demo-judge` in the output and the dashboard. |
| The judge's wording differs from this guide | That's expected. A real model phrases things its own way. The verdicts (Acceptable for home, Real Bug for pricing) are what matter.                                                                                                        |
| `Port 8100 is already in use`               | Add `--port 9000`.                                                                                                                                                                                                                         |
| A capture fails                             | Run `npx playwright install --with-deps chromium` again, then retry. The demo starts fresh each time.                                                                                                                                      |
| Nothing works                               | Show the screenshots in the README (`docs/images/`) and the [sample report](../examples/sample-report/report.md).                                                                                                                          |

## Questions people ask

**What does it cost?** Only screenshots that changed go to the model, cropped to the part of the page that changed. Unchanged pages cost nothing. The demo makes four calls.

**What if the AI is wrong?** Every verdict has a confidence score and an explanation you can check against the images. When the model isn't sure it says "Uncertain", and that page goes to _needs review_ rather than passing. If the model can't be reached, the page also goes to _review_. Nothing passes silently.

**Why not just ignore small changes?** Size says nothing about importance. In the demo the harmless date change is only 41 pixels, but plenty of real bugs are just as small: a misaligned button, a missing icon, a wrong price. A threshold high enough to hide the date would hide those too.

**What about content that always changes, like clocks, ads and carousels?** List them in `pixelguard.regions.json`. They're either masked out of the diff (the demo's live clock) or passed to the judge as "expected to change".

**Where does my data go?** Screenshots and history stay on your machine. Only the changed screenshots are sent to the Anthropic API, and only when you use `--judge`.

**How do I use it on my own site?** Set `TARGET_BASE_URL` and `TARGET_PAGES` in `.env` and follow the [README](../README.md#quick-start).
