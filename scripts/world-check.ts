import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FlightEvent } from "../src/public/types.js";
import { asHangarRoot } from "../src/public/types.js";
import {
  conditions,
  describe,
  launchOffset,
  LUNAR_GRAVITY,
  MAX_THRUST_ACCEL,
  MOVED_CONDITIONS,
  movedConditions,
} from "../src/world/physics.js";
import {
  buildFlyTool,
  CONTROLLER_PATH,
  createControllerRun,
  measureSource,
} from "../src/pilot/tools.js";
import { simulate } from "../src/world/simulate.js";

const BASELINE = path.resolve("fixtures/lander/stock.js");

const handFlown = (padX: number, gravity: number, wind: number): string => `
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const PAD = ${padX};
const G = ${gravity};
const WIND = ${wind};
const HOVER = G / ${MAX_THRUST_ACCEL};

export function control(s) {
  const dx = PAD - s.x;
  const cruise = clamp(Math.sign(dx) * Math.sqrt(2 * 0.4 * Math.abs(dx)), -12, 12);
  const cap = clamp(s.y / 14, 0.22, 1);
  const tilt = clamp(0.5 * (cruise - s.vx) - 1.5 * WIND, -cap, cap);

  const hold = Math.abs(dx) > 12 ? 0.16 : 0.3;
  const targetVy = -clamp(s.y * hold, 1.0, Math.abs(dx) > 8 ? 4.5 : 9);
  const thrust = clamp(HOVER + 0.4 * (targetVy - s.vy), 0, 1);

  return { thrust, tilt };
}
`;

const BASE = `export function control(s) {
  // a schedule with room to be simplified
  const thrust = s.y > 20 ? 0.5 : 0.4;
  return { thrust, tilt: 0 };
}`;
const SHORTER = `export function control(s) { return { thrust: 0.45, tilt: 0 }; }`;
const LONGER = `${BASE}\n// leftover tuning notes that make this longer`;

/**
 * The optimizer decides what lands on disk after the demo has already
 * succeeded, so its acceptance rule is checked directly rather than inferred
 * from a live run. A bug here silently replaces a controller that lands with
 * one that does not.
 */
function checkOptimization(): boolean {
  const failures: string[] = [];
  const expect = (label: string, held: boolean): void => {
    if (!held) failures.push(label);
  };

  const run = createControllerRun({
    maxSolvingAttempts: 3,
    optimizationAttempts: 4,
  });

  const crashed = run.record(BASE, "failed");
  expect("a crash keeps solving", crashed.snapshot.kind === "solving");
  expect("a crashed flight is still installed", crashed.shouldPersist);

  const first = run.record(BASE, "landed");
  expect("landing enters optimizing", first.snapshot.kind === "optimizing");
  expect("landing is persisted", first.shouldPersist);

  const same = run.record(BASE, "landed");
  expect("identical source is a no-op", same.result === "identical");
  expect("a no-op is not persisted", !same.shouldPersist);

  const brokeIt = run.record(SHORTER, "failed");
  expect("shorter but crashed is refused", brokeIt.result === "failed");
  expect("a losing simplification never reaches disk", !brokeIt.shouldPersist);

  const bloated = run.record(LONGER, "landed");
  expect("longer but landing is refused", bloated.result === "not_shorter");
  expect("a longer controller never reaches disk", !bloated.shouldPersist);

  const win = run.record(SHORTER, "landed");
  expect("shorter and landing is accepted", win.result === "accepted");
  expect("an accepted simplification is persisted", win.shouldPersist);
  expect("the budget ends the run", win.snapshot.kind === "done");
  expect(
    "the run keeps the shortest landing controller",
    win.snapshot.kind !== "solving" &&
      win.snapshot.best.measure.bytes === measureSource(SHORTER).bytes,
  );

  for (const failure of failures) console.log(`  FAILED: ${failure}`);
  return failures.length === 0;
}

/**
 * Drives the real tool against a scratch root. The acceptance rule above is
 * about decisions; this is about the file, which is what the audience opens
 * afterwards and what the next act flies.
 */
async function checkPersistence(): Promise<boolean> {
  const failures: string[] = [];
  const root = asHangarRoot(
    await fs.mkdtemp(path.join(os.tmpdir(), "freefall-check-")),
  );
  await fs.mkdir(path.dirname(path.resolve(root, CONTROLLER_PATH)), {
    recursive: true,
  });

  const calm = conditions("calm");
  const run = createControllerRun({ maxSolvingAttempts: 3, optimizationAttempts: 2 });
  const events: FlightEvent[] = [];
  const { fly } = buildFlyTool({
    root,
    conditions: () => calm,
    run: () => run,
    emit: (event) => events.push(event),
  });

  const winner = handFlown(calm.padX, calm.gravity, calm.wind);
  const call = (source: string) => fly.execute({ source }, {});

  const landing = String(await call(winner));
  if (!landing.includes("LANDED")) failures.push(`expected a landing, got: ${landing}`);
  if (!landing.includes("now simplify")) failures.push("receipt never asks for a simplification");

  const shorterButBroken = `export function control(s) { return { thrust: 0.2, tilt: 0 }; }`;
  const refused = String(await call(shorterButBroken));
  if (!refused.includes("NOT ACCEPTED")) failures.push(`expected a refusal, got: ${refused}`);

  const onDisk = await fs.readFile(path.resolve(root, CONTROLLER_PATH), "utf8");
  if (onDisk.trim() !== winner.trim()) {
    failures.push("a losing simplification overwrote the landing controller");
  }

  const receipts = events.filter((e) => e.kind === "attempt_flown");
  if (receipts.length !== 2) failures.push(`expected 2 flight events, saw ${receipts.length}`);
  const last = receipts.at(-1);
  if (last?.kind === "attempt_flown" && last.receipt.optimization?.bestSource.trim() !== winner.trim()) {
    failures.push("the receipt does not carry the accepted source");
  }

  await fs.rm(root, { recursive: true, force: true });
  for (const failure of failures) console.log(`  FAILED: ${failure}`);
  return failures.length === 0;
}

const LOOPS_FOREVER = `
export function control(s) {
  while (true) {}
}
`;

const BROKEN = `export function control(s) { return "nope"; }`;

async function main(): Promise<void> {
  const baseline = await fs.readFile(BASELINE, "utf8");
  const calm = conditions("calm");

  const stock = await simulate(baseline, calm);
  console.log("stock      :", stock.kind === "ok" ? describe(stock.telemetry) : stock.error);

  const flown = await simulate(
    handFlown(calm.padX, calm.gravity, calm.wind),
    calm,
  );
  console.log("hand-flown :", flown.kind === "ok" ? describe(flown.telemetry) : flown.error);

  const hung = await simulate(LOOPS_FOREVER, calm, 1500);
  console.log("infinite   :", hung.kind === "rejected" ? `rejected: ${hung.error}` : "NOT REJECTED");

  const broken = await simulate(BROKEN, calm);
  console.log("bad return :", broken.kind === "rejected" ? `rejected: ${broken.error}` : "NOT REJECTED");

  console.log("");
  console.log("moved presets (stale calm controller must miss; gravity-aware must land):");

  let allSeparated = true;
  let allStaleMiss = true;
  let allWinnable = true;
  let gravityVaries = false;

  for (let i = 0; i < MOVED_CONDITIONS.length; i += 1) {
    const world = movedConditions(i);
    const gap = launchOffset(world);
    const stale = await simulate(
      handFlown(calm.padX, calm.gravity, calm.wind),
      world,
    );
    const adapted = await simulate(
      handFlown(world.padX, world.gravity, world.wind),
      world,
    );

    const staleOk = stale.kind === "ok" && stale.telemetry.outcome.kind !== "landed";
    const adaptedOk =
      adapted.kind === "ok" && adapted.telemetry.outcome.kind === "landed";
    const separated = gap >= 20;
    if (!separated) allSeparated = false;
    if (!staleOk) allStaleMiss = false;
    if (!adaptedOk) allWinnable = false;
    if (world.gravity !== LUNAR_GRAVITY) gravityVaries = true;

    console.log(
      `  ${world.name.padEnd(16)} g=${world.gravity} wind=${world.wind} gap=${gap}` +
        `  stale=${stale.kind === "ok" ? stale.telemetry.outcome.kind : "rejected"}` +
        `  adapted=${adapted.kind === "ok" ? adapted.telemetry.outcome.kind : "rejected"}`,
    );
  }

  const stockFails = stock.kind === "ok" && stock.telemetry.outcome.kind !== "landed";
  const handLands = flown.kind === "ok" && flown.telemetry.outcome.kind === "landed";
  const hungRejected = hung.kind === "rejected";
  const brokenRejected = broken.kind === "rejected";
  const optimizationHolds = checkOptimization();
  const diskHolds = await checkPersistence();

  console.log("");
  console.log("act1 has a problem :", stockFails ? "yes" : "NO — nothing to solve");
  console.log("act1 is winnable   :", handLands ? "yes" : "NO — world may be unsolvable");
  console.log("moved are separated :", allSeparated ? "yes" : "NO — launch over pad");
  console.log("stale misses moved :", allStaleMiss ? "yes" : "NO — stale still lands");
  console.log("moved are winnable :", allWinnable ? "yes" : "NO — a preset is impossible");
  console.log("gravity varies     :", gravityVaries ? "yes" : "NO — still fixed at lunar");
  console.log("hang contained     :", hungRejected ? "yes" : "NO");
  console.log("bad code caught    :", brokenRejected ? "yes" : "NO");
  console.log("optimizer is safe  :", optimizationHolds ? "yes" : "NO — see failures above");
  console.log("best kept on disk  :", diskHolds ? "yes" : "NO — see failures above");

  const ok =
    stockFails &&
    handLands &&
    allSeparated &&
    allStaleMiss &&
    allWinnable &&
    gravityVaries &&
    hungRejected &&
    brokenRejected &&
    optimizationHolds &&
    diskHolds;
  if (!ok) process.exit(1);
}

void main();
