import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

/**
 * The renderer (public/app.js) is the one FlightEvent consumer with no type
 * checking and no other coverage: world-check proves the server emits the right
 * shape, nothing proves the page handles it. Every renderer bug this session —
 * the receipt crash, the mid-flight scene cut, the spoiler trail colour — was
 * found by eye. This drives the real page with a synthetic event stream over the
 * real fetch/stream-parse path and asserts on real canvas pixels, so those three
 * behaviours plus the loud-fail banner are checked by a script a reviewer reruns.
 *
 * Run: npm run render-check
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// ---------------------------------------------------------------------------
// Synthetic flight data. Physically loose on purpose: the renderer only reads
// x/y to draw and outcome.kind to colour, so a clean descent is enough.
// ---------------------------------------------------------------------------

type Frame = {
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angleDeg: number;
  fuel: number;
};

function descent(
  n: number,
  landed: boolean,
  x0: number,
  xN: number,
): { frames: Frame[]; telemetry: unknown } {
  const y0 = 88;
  const frames: Frame[] = [];
  const dur = n / 30;
  for (let i = 0; i < n; i += 1) {
    const p = i / (n - 1);
    frames.push({
      t: i / 30,
      x: x0 + (xN - x0) * p,
      y: Math.max(0, y0 * (1 - p)),
      vx: (xN - x0) / dur,
      vy: -y0 / dur,
      angleDeg: 0,
      fuel: 120 * (1 - p),
    });
  }
  return {
    frames,
    telemetry: {
      outcome: landed ? { kind: "landed", score: "A" } : { kind: "crashed" },
      touchdownX: xN,
      missDistance: landed ? 1 : 34,
      impactSpeed: landed ? 1.4 : 12.5,
      tiltDeg: 3,
      fuelLeft: landed ? 40 : 0,
      fuelUsed: landed ? 80 : 120,
      durationS: Number(dur.toFixed(1)),
    },
  };
}

// The real receipt is wide: describe() emits one long line and profileOf() emits
// five fields for each of six waypoints. Both have to fit a 30rem panel, so the
// fixture uses the real shapes rather than a short stand-in.
const OUTCOME_LINE = "LANDED score=52 x=0 (miss=1) speed=1.4 tilt=3deg fuel=40 t=5.7s";
const PROFILE_FIELDS = ["t", "y", "vy", "x", "vx"] as const;
const PROFILE =
  "t=0 y=88 vy=-2 x=-45 vx=3 | t=1.1 y=70.7 vy=-8 x=-30 vx=4" +
  " | t=2.3 y=52.2 vy=-6.4 x=-18.9 vx=2.4 | t=3.4 y=32.9 vy=-5.1 x=-9.6 vx=1.2" +
  " | t=4.6 y=14.2 vy=-3.6 x=-3.3 vx=0.7 | t=5.7 y=0 vy=-1 x=0 vx=0.2";
const PROFILE_WAYPOINTS = PROFILE.split("|").length;

// A syntax error the sandbox threw is the longest unbroken string the panel ever
// shows, and it arrives with no telemetry at all.
const REJECT_LINE =
  "REJECTED: SyntaxError: Unexpected token '}' in fixtures/lander/controller.js:4:22" +
  " — control(s) must return { thrust, tilt } with thrust in 0..1";

const ACCEPTED_OPT = {
  result: "accepted",
  candidate: { bytes: 612, lines: 14 },
  best: { bytes: 842, lines: 20 },
  attemptsRemaining: 3,
  bestSource: "// BEST_SRC\n",
};

function receipt(attempt: number, phase: string, optimization: unknown = null): unknown {
  return {
    attempt,
    phase,
    text: `${OUTCOME_LINE}\nflight profile: ${PROFILE}`,
    outcomeLine: OUTCOME_LINE,
    profile: PROFILE,
    optimization,
    best: optimization === null ? null : ACCEPTED_OPT.best,
  };
}

const STOCK_SRC = "export function control(s) {\n  return { thrust: 0.2, tilt: 0 };\n}";
const ATT1_SRC =
  "export function control(s) {\n  // ATT1_MARKER\n  const up = s.vy < -3 ? 0.8 : 0.3;\n  return { thrust: up, tilt: 0 };\n}";
const ATT2_SRC = "// ATT2_MARKER\nexport function control(s) {\n  return { thrust: 0.6, tilt: 0 };\n}";
const GOOD_SRC = "// GOOD_MARKER\nexport function control(s) {\n  return { thrust: 0.7, tilt: 0 };\n}";

type Wire = { d: number; e: Record<string, unknown> };

const HANGAR = {
  kind: "hangar_open",
  flightId: "render-check",
  world: { name: "calm", gravity: 1.62, wind: 0, padX: 0 },
  arena: { halfWidth: 130, ceiling: 300, padHalfWidth: 6, safeDescent: 2.5 },
  arenaOk: true,
};

// Happy path: baseline crash, then two landing attempts sent while the baseline
// is still playing. A correct scene queue plays stock → attempt 1 → attempt 2 in
// order; the old bug swapped immediately and cut the baseline mid-air.
const HAPPY: Wire[] = [
  {
    d: 0,
    e: { ...HANGAR, baseline: descent(100, false, -45, 34), source: STOCK_SRC },
  },
  {
    d: 60,
    e: {
      kind: "attempt_flown",
      trajectory: descent(170, true, -45, 0),
      source: ATT1_SRC,
      note: "New autopilot installed.",
      receipt: receipt(1, "solving"),
    },
  },
  {
    d: 120,
    e: {
      kind: "attempt_flown",
      trajectory: descent(170, true, -20, 0),
      source: ATT2_SRC,
      note: "Tightened the gain.",
      receipt: receipt(2, "optimizing", ACCEPTED_OPT),
    },
  },
  { d: 180, e: { kind: "flight_over", landed: true, attempts: 2, phase: "done", best: { bytes: 842, lines: 20 } } },
];

// Malformed path: a good conditions_changed, then an attempt_flown with the
// receipt field deleted (exactly the stale-server shape), then a good one. The
// bad frame must drop and raise the loud banner; the good one must still render
// and clear it.
const MALFORMED: Wire[] = [
  {
    d: 0,
    e: {
      kind: "conditions_changed",
      world: { name: "moved-west", gravity: 1.9, wind: -0.12, padX: -46 },
      baseline: descent(120, false, -4, -46),
      move: 1,
    },
  },
  {
    d: 60,
    e: {
      kind: "attempt_flown",
      trajectory: descent(170, true, -4, -46),
      source: "// SHOULD_NOT_RENDER\n",
      note: "broken frame",
    },
  },
  {
    d: 1600,
    e: {
      kind: "attempt_flown",
      trajectory: descent(170, true, -4, -46),
      source: GOOD_SRC,
      note: "New autopilot installed.",
      receipt: receipt(1, "solving"),
    },
  },
  { d: 1700, e: { kind: "flight_over", landed: true, attempts: 1, phase: "done", best: { bytes: 700, lines: 16 } } },
  // Last, so the status assertions above still see flight_over's terminal line.
  // A rejected attempt has no telemetry and no profile: the receipt must drop
  // those blocks rather than leave two empty boxes behind.
  {
    d: 1750,
    e: {
      kind: "attempt_rejected",
      attempt: 2,
      error: "SyntaxError: Unexpected token '}'",
      receipt: {
        attempt: 2,
        phase: "solving",
        text: REJECT_LINE,
        outcomeLine: REJECT_LINE,
        profile: "",
        optimization: null,
        best: null,
      },
    },
  },
];

async function streamEvents(res: ServerResponse, events: Wire[]): Promise<void> {
  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-store",
  });
  let elapsed = 0;
  for (const { d, e } of events) {
    if (d > elapsed) {
      await new Promise((r) => setTimeout(r, d - elapsed));
      elapsed = d;
    }
    res.write(`${JSON.stringify(e)}\n`);
  }
  await new Promise((r) => setTimeout(r, 50));
  res.end();
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url === "/" ? "/index.html" : (req.url ?? "/index.html");
  const file = path.join(publicDir, path.normalize(url).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(publicDir) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  const body = await readFile(file);
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  res.end(body);
}

function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/launch") {
      void streamEvents(res, HAPPY);
      return;
    }
    if (req.method === "POST" && req.url === "/api/harden") {
      void streamEvents(res, MALFORMED);
      return;
    }
    void serveStatic(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Browser probing
// ---------------------------------------------------------------------------

type Sample = {
  yellow: number;
  green: number;
  red: number;
  bannerEdge: number;
  verdict: boolean;
  tag: string;
  status: string;
  code: string;
};

// Passed to page.evaluate as a string, not a function: tsx/esbuild rewrites
// passed functions with a __name helper that does not exist in the page. Steps
// by 2 to keep each full-canvas scan cheap enough to poll at ~10 Hz.
const READ_STAGE = `(() => {
  const cv = document.getElementById("sky");
  const g = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  const img = g.getImageData(0, 0, W, H).data;
  const bandLo = Math.floor(H * 0.44), bandHi = Math.ceil(H * 0.56);
  const edgeL = Math.floor(W * 0.04), edgeR = Math.ceil(W * 0.96);
  let yellow = 0, green = 0, red = 0, bannerEdge = 0;
  for (let y = 0; y < H; y += 2) {
    const inBand = y >= bandLo && y <= bandHi;
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      const r = img[i], gg = img[i + 1], b = img[i + 2];
      if (r > 200 && gg > 170 && b < 90) yellow++;
      else if (r < 130 && gg > 190 && b > 90 && b < 180) green++;
      else if (r > 220 && gg > 80 && gg < 150 && b > 80 && b < 150) red++;
      // Banner bars span the full width, so far-edge orange is the banner and
      // never the flight arc or the lander flame, which stay mid-stage.
      if (inBand && (x < edgeL || x > edgeR) && r > 230 && gg > 50 && gg < 110 && b < 45) bannerEdge++;
    }
  }
  const text = (id) => { const el = document.getElementById(id); return el ? el.textContent : ""; };
  return {
    yellow, green, red, bannerEdge,
    verdict: !document.getElementById("verdict").hidden,
    tag: text("attemptTag"),
    status: text("status"),
    code: text("code"),
  };
})()`;

async function sample(page: Page): Promise<Sample> {
  return page.evaluate(READ_STAGE) as Promise<Sample>;
}

type Cell = { label: string; value: string; stacked: boolean };
type Row = { head: boolean; cells: { text: string; right: number }[] };
type Receipt = {
  statsDisplay: string;
  profileDisplay: string;
  cells: Cell[];
  rows: Row[];
  outcomeLines: number;
  optWord: string;
  optSizes: string;
  scrollOverflow: number;
  worstRightPx: number;
};

/**
 * The receipt is the panel a presenter reads out loud, and the old version had
 * no styles at all: `miss` ran into `3.4 m` and a waypoint printed as
 * `t0y92vy-2x2vx3`. Nothing caught that, because every other assertion here
 * reads canvas pixels or the code panel. This measures the layout instead of
 * the text: label and value on separate lines, one element per profile field
 * with the columns aligned, and nothing reaching past the panel edge.
 */
const READ_RECEIPT = `(() => {
  const receipt = document.getElementById("receipt");
  const stats = document.getElementById("receiptStats");
  const profile = document.getElementById("receiptProfile");
  const outcome = document.getElementById("receiptOutcome");
  const opt = document.getElementById("receiptOpt");
  const box = (n) => n.getBoundingClientRect();
  const panelRight = box(document.querySelector(".panel")).right;
  const text = (n) => (n ? n.textContent : "");

  const cells = [...stats.children].map((cell) => {
    const k = cell.querySelector(".k");
    const v = cell.querySelector(".v");
    return {
      label: text(k),
      value: text(v),
      stacked: !!k && !!v && box(v).top >= box(k).bottom - 1,
    };
  });

  const rows = [...profile.children].map((row) => ({
    head: row.classList.contains("head"),
    cells: [...row.children].map((c) => ({ text: c.textContent, right: box(c).right })),
  }));

  // line-height computes to "normal" when unset, which parses to NaN and would
  // report a wrapped-line count of one per pixel.
  const style = getComputedStyle(outcome);
  const lh = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
  let worstRightPx = -Infinity;
  for (const n of receipt.querySelectorAll("*")) {
    worstRightPx = Math.max(worstRightPx, box(n).right - panelRight);
  }

  return {
    statsDisplay: getComputedStyle(stats).display,
    profileDisplay: getComputedStyle(profile).display,
    cells,
    rows,
    outcomeLines: Math.round(box(outcome).height / lh),
    optWord: text(opt.querySelector(".word")),
    optSizes: text(opt.querySelector(".sizes")),
    scrollOverflow: receipt.scrollWidth - receipt.clientWidth,
    worstRightPx,
  };
})()`;

async function readReceipt(page: Page): Promise<Receipt> {
  return page.evaluate(READ_RECEIPT) as Promise<Receipt>;
}

async function collect(page: Page, ms: number, every: number): Promise<Sample[]> {
  const out: Sample[] = [];
  const start = Date.now();
  while (Date.now() - start < ms) {
    out.push(await sample(page));
    await page.waitForTimeout(every);
  }
  return out;
}

class Timeout extends Error {
  constructor(
    readonly label: string,
    readonly last: Sample | undefined,
  ) {
    super(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
  }
}

async function until(
  page: Page,
  pred: (s: Sample) => boolean,
  label: string,
  timeout = 8000,
): Promise<Sample> {
  const start = Date.now();
  let last: Sample | undefined;
  while (Date.now() - start < timeout) {
    last = await sample(page);
    if (pred(last)) return last;
    await page.waitForTimeout(80);
  }
  throw new Timeout(label, last);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name} — ${detail}`);
}

function chromeExecutable(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  // The sandbox Playwright cache holds an x64 shell on this arm64 machine, which
  // can segfault; the system browser is native, so prefer it when present.
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  return candidates.find((p) => existsSync(p));
}

async function main(): Promise<void> {
  const { port, close } = await startServer();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: chromeExecutable(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });

    // ---- Happy path -----------------------------------------------------
    console.log("happy path:");
    await page.click("#launch");

    // Scene queue: the baseline must own the stage before attempt 1 appears.
    const early = await collect(page, 400, 80);
    const sawStockEarly = early.filter((s) => s.tag === "stock").length;
    check(
      "scene queue holds baseline",
      sawStockEarly >= 3,
      `tag="stock" in ${sawStockEarly}/${early.length} early samples (attempt 1 did not cut in)`,
    );

    const timeline = [...early, ...(await collect(page, 8600, 100))];
    const firstTag = (t: string) => timeline.findIndex((s) => s.tag === t);
    const iStock = firstTag("stock");
    const iA1 = firstTag("attempt 1");
    const iA2 = firstTag("attempt 2");
    check(
      "scenes render in order",
      iStock === 0 && iA1 > iStock && iA2 > iA1,
      `stock@${iStock} < attempt1@${iA1} < attempt2@${iA2}`,
    );

    // The neutral-in-flight property is measured on the baseline flight only:
    // it is the first scene after a cut, so ghosts=[] and the only trail on the
    // stage is the live one. Later attempts carry green/red ghost trails from
    // prior flights, which are finished and correctly coloured.
    const baseline = timeline.slice(0, iA1 >= 0 ? iA1 : timeline.length);
    const baseFlight = baseline.filter((s) => !s.verdict && s.yellow > 60);
    const baseSettled = baseline.filter((s) => s.verdict);
    const flyMaxYellow = Math.max(0, ...baseFlight.map((s) => s.yellow));
    const flyMaxGreen = Math.max(0, ...baseFlight.map((s) => s.green));
    const flyMaxRed = Math.max(0, ...baseFlight.map((s) => s.red));
    check(
      "live trail is neutral in flight",
      flyMaxYellow > 100 && flyMaxGreen < 40 && flyMaxRed < 40,
      `baseline in-flight yellow=${flyMaxYellow} green=${flyMaxGreen} red=${flyMaxRed} (outcome not leaked)`,
    );

    // The baseline is a crash and every attempt lands, so a correct touchdown
    // resolves to red on the baseline and green somewhere in the run.
    const settledMaxRed = Math.max(0, ...baseSettled.map((s) => s.red));
    const settledMaxGreen = Math.max(0, ...timeline.filter((s) => s.verdict).map((s) => s.green));
    check(
      "trail resolves at touchdown",
      settledMaxRed > 100 && settledMaxGreen > 100,
      `settled crash red=${settledMaxRed}, landing green=${settledMaxGreen}`,
    );

    const landed = await until(page, (s) => /^landed ·/.test(s.status), "landed status", 6000);
    check("code panel shows installed controller", landed.code.includes("ATT2_MARKER") || timeline.some((s) => s.code.includes("ATT1_MARKER")), `final status "${landed.status}"`);
    check("no page errors during happy path", pageErrors.length === 0, pageErrors.join(" | ") || "clean");

    // ---- Receipt readability --------------------------------------------
    console.log("receipt panel:");
    const r = await readReceipt(page);
    const firstCell = r.cells[0];
    check(
      "stats separate label from value",
      r.statsDisplay === "grid" &&
        r.cells.length === 5 &&
        r.cells.every((c) => c.stacked && c.label !== "" && c.value !== ""),
      `${r.cells.length} grid cells, e.g. "${firstCell?.label}" above "${firstCell?.value}"`,
    );

    const head = r.rows.find((row) => row.head);
    const waypoints = r.rows.filter((row) => !row.head);
    const names = head?.cells.map((c) => c.text) ?? [];
    check(
      "profile fields are labelled columns, one element each",
      r.profileDisplay === "grid" &&
        names.join(" ") === PROFILE_FIELDS.join(" ") &&
        waypoints.length === PROFILE_WAYPOINTS &&
        waypoints.every((row) => row.cells.length === PROFILE_FIELDS.length),
      `[${names.join(" ")}] over ${waypoints.length} rows × ${waypoints[0]?.cells.length ?? 0} cells`,
    );

    const firstRow = waypoints[0];
    const drift = firstRow
      ? Math.max(
          0,
          ...waypoints.flatMap((row) =>
            row.cells.map((c, i) => Math.abs(c.right - (firstRow.cells[i]?.right ?? c.right))),
          ),
        )
      : Number.POSITIVE_INFINITY;
    check("profile columns stay aligned down the list", drift <= 1.5, `worst edge drift ${drift.toFixed(2)}px`);

    check(
      "optimization note splits verdict from sizes",
      r.optWord === "ACCEPTED" && /candidate 612 B \/ 14 lines/.test(r.optSizes),
      `"${r.optWord}" then "${r.optSizes}"`,
    );

    check(
      "outcome line wraps rather than clipping",
      r.outcomeLines >= 2,
      `${r.outcomeLines} wrapped lines at panel width`,
    );

    check(
      "receipt fits the panel width",
      r.scrollOverflow === 0 && r.worstRightPx <= 0,
      `scroll overflow ${r.scrollOverflow}px, widest child ${r.worstRightPx.toFixed(1)}px vs panel edge`,
    );

    // ---- Malformed path -------------------------------------------------
    console.log("malformed path:");
    await until(page, (s) => !s.verdict || true, "harden enabled", 3000);
    await page.waitForFunction(`!document.getElementById("harden").disabled`, undefined, {
      timeout: 5000,
    });
    await page.click("#harden");

    const dropped = await until(
      page,
      (s) => /dropped an event/.test(s.status),
      "dropped-event status",
      4000,
    );
    check(
      "bad frame is dropped, not fatal",
      /dropped an event/.test(dropped.status),
      `status "${dropped.status}"`,
    );

    const banner = await until(page, (s) => s.bannerEdge > 30, "loud banner on canvas", 4000);
    check(
      "loud fault banner painted on canvas",
      banner.bannerEdge > 30,
      `full-width banner edge pixels=${banner.bannerEdge}`,
    );

    const recovered = await until(
      page,
      (s) => s.code.includes("GOOD_MARKER"),
      "good frame renders",
      6000,
    );
    check(
      "next good frame still renders",
      recovered.code.includes("GOOD_MARKER") && !recovered.code.includes("SHOULD_NOT_RENDER"),
      "code panel shows the recovered controller",
    );

    const cleared = await until(page, (s) => s.bannerEdge < 12, "banner cleared", 4000);
    check("banner clears once shape agrees again", cleared.bannerEdge < 12, `banner edge pixels=${cleared.bannerEdge}`);

    check(
      "malformed source never reached the panel",
      !recovered.code.includes("SHOULD_NOT_RENDER"),
      "dropped frame's source absent from code panel",
    );

    await page.waitForFunction(
      `/^REJECTED/.test(document.getElementById("receiptOutcome").textContent)`,
      undefined,
      { timeout: 8000 },
    );
    const rejected = await readReceipt(page);
    check(
      "rejected receipt drops its empty telemetry blocks",
      rejected.statsDisplay === "none" &&
        rejected.profileDisplay === "none" &&
        rejected.cells.length === 0 &&
        rejected.rows.length === 0,
      `stats=${rejected.statsDisplay} profile=${rejected.profileDisplay}`,
    );
    check(
      "long rejection reason wraps inside the panel",
      rejected.outcomeLines >= 2 &&
        rejected.scrollOverflow === 0 &&
        rejected.worstRightPx <= 0,
      `${rejected.outcomeLines} lines, overflow ${rejected.scrollOverflow}px`,
    );

    await page.close();
  } catch (err) {
    // A timed-out wait is a failed assertion, not a harness crash: record it and
    // still print the summary so the reviewer sees exactly which stage regressed.
    if (err instanceof Timeout) check(err.label, false, err.message);
    else throw err;
  } finally {
    await browser?.close();
    await close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(`render-check: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
