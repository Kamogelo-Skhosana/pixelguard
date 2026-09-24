# Examples

- `baseline/` — placeholder folder for sample baseline screenshots, useful for testing the diff engine (P012-P014) without needing a live target running.

For an end-to-end local test target, run a simple demo site or your own project (e.g., [mmfc.org.za](https://mmfc.org.za) or [nyiemaessence.co.za](https://nyiemaessence.co.za) locally) and point `TARGET_BASE_URL` at it in `.env`.

```bash
npm run pixelguard -- capture --tag baseline
# make a visible change to a page
npm run pixelguard -- capture --tag current
npm run pixelguard -- diff --baseline baseline --current current
```
