/**
 * Generates the sample image pairs used by the diff engine tests (P014).
 *
 * Writes tests/fixtures/diff/<case>/baseline.png and current.png, plus
 * tests/fixtures/diff/cases.json describing what each pair should produce.
 * The PNGs are committed, so you only need to run this if you change a case:
 *
 *   npm run fixtures:diff
 *
 * Synthetic cases are drawn pixel by pixel, so their expected counts are
 * exact. The "real-heading-change" case is a real Chromium screenshot pair.
 *
 * Ticket: P014
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { closePage, newPage, withBrowser } from "../src/capture/browser.js";
import { savePng } from "../src/diff/imageCompare.js";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "tests",
  "fixtures",
  "diff"
);

type RGB = [number, number, number];

export interface FixtureCase {
  name: string;
  description: string;
  options?: { threshold?: number; includeAntiAliasing?: boolean };
  expected: {
    changed: boolean;
    sizeChanged: boolean;
    pixelDiffCount?: number;
    percentChanged?: number;
  };
  /** All changed pixels must fall inside this box (for the real screenshot case). */
  changedRegion?: { x: number; y: number; width: number; height: number };
}

// ---------- drawing helpers ----------

function canvas(width: number, height: number, colour: RGB): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([...colour, 255], i);
  return png;
}

function rect(png: PNG, x: number, y: number, w: number, h: number, colour: RGB): PNG {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      png.data.set([...colour, 255], (row * png.width + col) * 4);
    }
  }
  return png;
}

const WHITE: RGB = [255, 255, 255];
const DARK: RGB = [40, 40, 40];
const GREY: RGB = [180, 180, 180];
const BLUE: RGB = [30, 90, 220];
const GREEN: RGB = [30, 170, 80];

/** A tiny 200x120 "web page": header bar, button, text lines. */
function mockPage(options: { buttonX?: number; buttonColour?: RGB; height?: number } = {}): PNG {
  const { buttonX = 20, buttonColour = BLUE, height = 120 } = options;
  const png = canvas(200, height, WHITE);
  rect(png, 0, 0, 200, 20, DARK); // header
  rect(png, 20, 30, 160, 4, GREY); // text line
  rect(png, 20, 40, 120, 4, GREY); // text line
  rect(png, buttonX, 60, 60, 20, buttonColour); // button
  rect(png, 20, 95, 160, 4, GREY); // text line
  return png;
}

/** Hard black|white edge with a single grey column between them (an anti-aliased edge). */
function edge(grey: number): PNG {
  const png = canvas(20, 20, WHITE);
  rect(png, 0, 0, 10, 20, [0, 0, 0]);
  rect(png, 10, 0, 1, 20, [grey, grey, grey]);
  return png;
}

// ---------- cases ----------

async function main(): Promise<void> {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  const cases: FixtureCase[] = [];

  async function add(c: FixtureCase, baseline: PNG, current: PNG): Promise<void> {
    await savePng(baseline, join(FIXTURE_DIR, c.name, "baseline.png"));
    await savePng(current, join(FIXTURE_DIR, c.name, "current.png"));
    cases.push(c);
  }

  await add(
    {
      name: "identical",
      description: "Same page twice: nothing should be flagged.",
      expected: { changed: false, sizeChanged: false, pixelDiffCount: 0, percentChanged: 0 },
    },
    mockPage(),
    mockPage()
  );

  await add(
    {
      name: "button-colour",
      description: "Button changes from blue to green (60x20 = 1200 of 24000 pixels).",
      expected: { changed: true, sizeChanged: false, pixelDiffCount: 1200, percentChanged: 5 },
    },
    mockPage(),
    mockPage({ buttonColour: GREEN })
  );

  await add(
    {
      name: "element-shift",
      description:
        "Button moves 5px right: a 5px strip uncovered on the left, 5px added on the right.",
      expected: {
        changed: true,
        sizeChanged: false,
        pixelDiffCount: 200,
        percentChanged: 0.8333,
      },
    },
    mockPage(),
    mockPage({ buttonX: 25 })
  );

  await add(
    {
      name: "page-taller",
      description: "Page grows by 30px at the bottom: the extra 30x200 area counts as changed.",
      expected: { changed: true, sizeChanged: true, pixelDiffCount: 6000, percentChanged: 20 },
    },
    mockPage(),
    mockPage({ height: 150 })
  );

  await add(
    {
      name: "antialiased-edge",
      description: "Only the anti-aliased edge pixels differ: ignored by default.",
      expected: { changed: false, sizeChanged: false, pixelDiffCount: 0, percentChanged: 0 },
    },
    edge(128),
    edge(90)
  );

  cases.push({
    name: "antialiased-edge",
    description: "Same pair with includeAntiAliasing: the 20 edge pixels are counted.",
    options: { includeAntiAliasing: true },
    expected: { changed: true, sizeChanged: false, pixelDiffCount: 20, percentChanged: 5 },
  });

  await add(
    {
      name: "subtle-shade",
      description: "Whole page 2 shades darker: below the default threshold, so ignored.",
      expected: { changed: false, sizeChanged: false, pixelDiffCount: 0, percentChanged: 0 },
    },
    canvas(50, 50, [200, 200, 200]),
    canvas(50, 50, [198, 198, 198])
  );

  cases.push({
    name: "subtle-shade",
    description: "Same pair with threshold 0: every pixel counts.",
    options: { threshold: 0 },
    expected: { changed: true, sizeChanged: false, pixelDiffCount: 2500, percentChanged: 100 },
  });

  // Real browser screenshots: only the heading text changes.
  const page = (heading: string) => `<!doctype html><html><head><style>
    body { margin: 0; padding: 24px; font-family: Arial, sans-serif; background: #fff; }
    h1 { margin: 0 0 16px; font-size: 28px; color: #222; }
    p { margin: 0 0 12px; color: #555; font-size: 16px; }
    button { padding: 8px 16px; background: #1e5adc; color: #fff; border: 0; font-size: 16px; }
  </style></head><body>
    <h1 id="heading">${heading}</h1>
    <p>pixelguard sample page used to test the diff engine.</p>
    <p>Only the heading above changes between the two screenshots.</p>
    <button>Get started</button>
  </body></html>`;

  await withBrowser(async (browser) => {
    const shots: Buffer[] = [];
    let box = { x: 0, y: 0, width: 0, height: 0 };
    for (const heading of ["Welcome to our store", "Welcome to our shop!"]) {
      const p = await newPage(browser, { width: 400, height: 240 });
      await p.setContent(page(heading), { waitUntil: "load" });
      const b = await p.locator("#heading").boundingBox();
      if (!b) throw new Error("heading not found");
      box = {
        x: Math.floor(b.x),
        y: Math.floor(b.y),
        width: Math.max(box.width, Math.ceil(b.width) + 1),
        height: Math.ceil(b.height) + 1,
      };
      shots.push(await p.screenshot({ animations: "disabled", caret: "hide" }));
      await closePage(p);
    }
    const dir = join(FIXTURE_DIR, "real-heading-change");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "baseline.png"), shots[0]);
    await writeFile(join(dir, "current.png"), shots[1]);
    cases.push({
      name: "real-heading-change",
      description: "Real Chromium screenshots where only the <h1> text changes.",
      expected: { changed: true, sizeChanged: false },
      changedRegion: { ...box, width: 400 - box.x },
    });
  });

  await writeFile(join(FIXTURE_DIR, "cases.json"), JSON.stringify(cases, null, 2) + "\n");
  console.log(`Wrote ${cases.length} cases to ${FIXTURE_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
