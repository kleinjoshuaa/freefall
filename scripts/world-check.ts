import fs from "node:fs/promises";
import path from "node:path";
import { conditions, describe } from "../src/world/physics.js";
import { simulate } from "../src/world/simulate.js";

// Always the pristine stock file: the live controller is overwritten by runs.
const BASELINE = path.resolve("fixtures/lander/stock.js");

const HAND_FLOWN = `
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function control(s) {
  const targetVy = -clamp(s.y * 0.35, 1.2, 12);
  const thrust = clamp(0.324 + 0.30 * (targetVy - s.vy), 0, 1);

  const targetVx = clamp(-s.x * 0.25, -6, 6);
  const tilt = clamp(0.35 * (targetVx - s.vx), -1, 1);

  return { thrust, tilt };
}
`;

// Act two is the same controller retargeted at the moved pad. If this does not
// land, the second act is unwinnable and the demo ends on a failure.
const RETARGETED = `
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const PAD = 50;

export function control(s) {
  const dx = PAD - s.x;
  const cruise = Math.sign(dx) * Math.sqrt(2 * 0.8 * Math.abs(dx));
  const tilt = clamp(0.40 * (clamp(cruise, -12, 12) - s.vx), -1, 1);

  const hold = Math.abs(dx) > 12 ? 0.22 : 0.35;
  const targetVy = -clamp(s.y * hold, 1.0, 9);
  const thrust = clamp(0.36 + 0.32 * (targetVy - s.vy), 0, 1);

  return { thrust, tilt };
}
`;

const LOOPS_FOREVER = `
export function control(s) {
  while (true) {}
}
`;

const BROKEN = `export function control(s) { return "nope"; }`;

async function main(): Promise<void> {
  const baseline = await fs.readFile(BASELINE, "utf8");

  const stock = await simulate(baseline, conditions("calm"));
  console.log("stock      :", stock.kind === "ok" ? describe(stock.telemetry) : stock.error);

  const flown = await simulate(HAND_FLOWN, conditions("calm"));
  console.log("hand-flown :", flown.kind === "ok" ? describe(flown.telemetry) : flown.error);

  const stale = await simulate(HAND_FLOWN, conditions("shifted"));
  console.log("stale ctl  :", stale.kind === "ok" ? describe(stale.telemetry) : stale.error);

  const adapted = await simulate(RETARGETED, conditions("shifted"));
  console.log("retargeted :", adapted.kind === "ok" ? describe(adapted.telemetry) : adapted.error);

  const hung = await simulate(LOOPS_FOREVER, conditions("calm"), 1500);
  console.log("infinite   :", hung.kind === "rejected" ? `rejected: ${hung.error}` : "NOT REJECTED");

  const broken = await simulate(BROKEN, conditions("calm"));
  console.log("bad return :", broken.kind === "rejected" ? `rejected: ${broken.error}` : "NOT REJECTED");

  const stockFails = stock.kind === "ok" && stock.telemetry.outcome.kind !== "landed";
  const handLands = flown.kind === "ok" && flown.telemetry.outcome.kind === "landed";
  const windBreaksIt = stale.kind === "ok" && stale.telemetry.outcome.kind !== "landed";
  const windSolvable = adapted.kind === "ok" && adapted.telemetry.outcome.kind === "landed";
  const hungRejected = hung.kind === "rejected";
  const brokenRejected = broken.kind === "rejected";

  console.log("");
  console.log("act1 has a problem :", stockFails ? "yes" : "NO — nothing to solve");
  console.log("act1 is winnable   :", handLands ? "yes" : "NO — world may be unsolvable");
  console.log("act2 has a problem :", windBreaksIt ? "yes" : "NO — moving the pad changes nothing");
  console.log("act2 is winnable   :", windSolvable ? "yes" : "NO — act 2 is impossible");
  console.log("hang contained     :", hungRejected ? "yes" : "NO");
  console.log("bad code caught    :", brokenRejected ? "yes" : "NO");

  const ok =
    stockFails && handLands && windBreaksIt && windSolvable && hungRejected && brokenRejected;
  if (!ok) process.exit(1);
}

void main();
