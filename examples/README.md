# Examples

- `baseline/` — placeholder folder for sample baseline screenshots.
- `demo-site/` — a small demo shop with two versions (a harmless date change and a real layout bug), used by `npm run demo` and the end-to-end test.
- `sample-report/report.md` — an example of the AI-judged Markdown report (see [docs/REPORT_TEMPLATE.md](../docs/REPORT_TEMPLATE.md)), using the sample screenshots in `tests/fixtures/diff/`.

Sample before/after image pairs for testing the diff engine without a live target live in [`tests/fixtures/diff/`](../tests/fixtures/diff/) — each case folder has a `baseline.png` and `current.png`, and `cases.json` describes the expected result. Regenerate them with `npm run fixtures:diff`.

For an end-to-end local test target, run a simple demo site or your own project (e.g., [mmfc.org.za](https://mmfc.org.za) or [nyiemaessence.co.za](https://nyiemaessence.co.za) locally) and point `TARGET_BASE_URL` at it in `.env`.

```bash
npm run pixelguard -- capture --tag baseline
# make a visible change to a page
npm run pixelguard -- capture --tag current
npm run pixelguard -- diff --baseline baseline --current current
```
