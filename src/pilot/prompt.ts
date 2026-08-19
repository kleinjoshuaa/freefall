import type { Conditions, Trajectory } from "../public/types.js";
import {
  describe,
  FUEL_BURN_PER_S,
  MAX_FLIGHT_S,
  MAX_THRUST_ACCEL,
  MAX_TILT_DEG,
  PAD_HALF_WIDTH,
  profileOf,
  SAFE_DESCENT,
  SAFE_DRIFT,
  SAFE_TILT_DEG,
} from "../world/physics.js";

/**
 * Everything the model needs to fly is stated here rather than discoverable via
 * read/grep. A survey tool would cost a round trip per attempt, and attempts per
 * minute is the entire schedule budget for a three-minute demo.
 */
export const MISSION = `You are the autopilot engineer for a lander. You write the controller; the craft flies it.

THE WORLD
- Gravity pulls down. The exact value is given with each flight brief — do not hardcode it.
  Hover thrust is roughly gravity / ${MAX_THRUST_ACCEL}. Heavier gravity leaves less braking margin.
- Thrust gives up to ${MAX_THRUST_ACCEL} m/s^2 along the lander's own up-axis.
- tilt in [-1, 1] commands a lean of up to +/-${MAX_TILT_DEG} degrees; the lander slews there at 60 deg/s.
- Leaning vectors the thrust:
    ax = ${MAX_THRUST_ACCEL} * thrust * sin(angle) + wind
    ay = ${MAX_THRUST_ACCEL} * thrust * cos(angle) - gravity
- Fuel burns at ${FUEL_BURN_PER_S} units/s at full thrust. At zero fuel you get no thrust at all.
- The sim runs at 30 Hz and gives up after ${MAX_FLIGHT_S} s.

PHYSICS THAT WILL BITE YOU
- Upright at full throttle your NET braking is ${MAX_THRUST_ACCEL} - gravity.
  Falling at 12 m/s you still need tens of metres of altitude to slow to 2 m/s.
  So schedule descent rate against altitude. Do not fall fast and flare late — you will run out of sky.
- Leaning to steer steals vertical thrust (it scales by cos of the lean), so hard steering costs you braking.
- Hovering burns fuel for nothing, and the sim gives up at ${MAX_FLIGHT_S} s.

BUDGET — the most common way to fail is descending too slowly:
- A good descent reaches the ground in 15-25 s and spends 40-70 fuel.
- Hovering costs ~2.6 fuel/s and buys nothing. If you are still airborne at 30 s you are already losing.
- Do not put a tiny floor on your descent rate. Keep descending at 1 m/s or more all the way to contact,
  and arrive under the ${SAFE_DESCENT} m/s limit rather than creeping down at 0.3 m/s from 10 m up.

TO LAND, touch y=0 with ALL of:
- descent speed <= ${SAFE_DESCENT} m/s
- horizontal speed <= ${SAFE_DRIFT} m/s
- within ${PAD_HALF_WIDTH} m of the pad centre (the pad is NOT always at x=0 — you are told where it is)
- |tilt| <= ${SAFE_TILT_DEG} degrees

THE AUTOPILOT is a complete ES module, under 20 lines, no imports, not async:

export function control(s) {
  // s = { t, x, y, vx, vy, angleDeg, fuel }
  return { thrust: 0, tilt: 0 };  // thrust 0..1, tilt -1..1
}

HOW YOU WORK
You have exactly one tool: fly. It installs your autopilot, flies it, and returns telemetry.
Call fly IMMEDIATELY. Do not describe your plan first. Do not write prose.
Read the telemetry, change the controller, call fly again.
The simulator is deterministic, so every flight must differ from the one before it.
Resending source you have already flown is rejected as a no-op and still costs you a flight.

THE JOB HAS TWO STAGES, and fly tells you which one you are in.

STAGE 1 — LAND IT. Iterate until the telemetry says LANDED. Nothing else counts.

STAGE 2 — SIMPLIFY IT. Once you have landed, keep going. Send shorter controllers
that still land. The receipt reports the accepted controller's size in bytes and lines.
- A shorter controller is better ONLY if it still lands. If it crashes, the previous
  accepted controller is kept and you have burned a flight.
- Actually cut something: drop a gain schedule, collapse a branch ladder into
  arithmetic, delete dead tuning.
- Keep it a valid ES module exporting control(s).
Stop when fly says DONE, or when you are out of flights.`;

/** Derived from the world so the brief can never drift out of sync with physics. */
function startLine(world: Conditions): string {
  const s = world.start;
  const drift =
    s.vx === 0
      ? "not drifting sideways"
      : `moving ${s.vx > 0 ? "right" : "left"} at ${Math.abs(s.vx)} m/s`;
  const gap = Math.abs(s.x - world.padX);
  return (
    `You start at x=${s.x} m, y=${s.y} m altitude, ${drift}, descending at ${Math.abs(s.vy)} m/s, with ${s.fuel} fuel.` +
    ` The pad centre is at x=${world.padX}, so you begin ${gap} m ${s.x < world.padX ? "left of" : "right of"} it and must fly across.`
  );
}

function gravityLine(world: Conditions): string {
  const hover = (world.gravity / MAX_THRUST_ACCEL).toFixed(2);
  const net = (MAX_THRUST_ACCEL - world.gravity).toFixed(2);
  return (
    `Gravity is ${world.gravity} m/s^2 this flight ` +
    `(hover thrust ≈ ${hover}; net braking at full throttle ≈ ${net} m/s^2).`
  );
}

function windLine(world: Conditions): string {
  if (world.wind === 0) return "There is no wind.";
  const dir = world.wind > 0 ? "right" : "left";
  return `Wind pushes ${dir} at ${Math.abs(world.wind)} m/s^2 the whole flight — trim for it or you will drift off the pad.`;
}

function stages(budget: number, simplifications: number): string {
  return `You have ${budget} flights to land, then ${simplifications} more to make the landing controller shorter without breaking it.`;
}

export type BriefInput = {
  readonly world: Conditions;
  readonly budget: number;
  readonly simplifications: number;
};

export function firstFlight(input: BriefInput): string {
  const { world } = input;
  return `The stock autopilot holds a fixed 20% throttle and never steers, so the lander sails past the pad and hits at speed.

${startLine(world)} ${gravityLine(world)} ${windLine(world)}

${stages(input.budget, input.simplifications)}

Write a better autopilot and call fly now.`;
}

export type RelocatedInput = BriefInput & {
  readonly previousPadX: number;
  /** The installed autopilot, already flown against the moved pad. */
  readonly stale: Trajectory;
};

export function relocated(input: RelocatedInput): string {
  const { world } = input;
  return `The mission changed. The landing pad has MOVED to x=${world.padX} — your autopilot is still flying to x=${input.previousPadX}, which is now bare ground.

${startLine(world)} ${gravityLine(world)} ${windLine(world)}

Your installed autopilot has ALREADY been flown against the moved pad, and this is what it did:
${describe(input.stale.telemetry)}
flight profile: ${profileOf(input.stale.frames)}

The simulator is deterministic, so flying that same source again would return exactly the
line above and cost you a flight. Retarget it first, then call fly with the new controller.

${stages(input.budget, input.simplifications)}

Call fly now.`;
}
