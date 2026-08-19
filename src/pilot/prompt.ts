import type { Conditions } from "../public/types.js";
import {
  FUEL_BURN_PER_S,
  MAX_FLIGHT_S,
  MAX_THRUST_ACCEL,
  MAX_TILT_DEG,
  PAD_HALF_WIDTH,
  SAFE_DESCENT,
  SAFE_DRIFT,
  SAFE_TILT_DEG,
} from "../world/physics.js";

/**
 * Everything the model needs to fly is stated here rather than discoverable via
 * read/grep. A survey tool would cost a round trip per attempt, and attempts per
 * minute is the entire schedule budget for a three-minute demo.
 */
export const MISSION = `You are the autopilot engineer for a lunar lander. You write the controller; the lander flies it.

THE WORLD
- Gravity pulls down at 1.62 m/s^2.
- Thrust gives up to ${MAX_THRUST_ACCEL} m/s^2 along the lander's own up-axis.
- tilt in [-1, 1] commands a lean of up to +/-${MAX_TILT_DEG} degrees; the lander slews there at 60 deg/s.
- Leaning vectors the thrust:
    ax = ${MAX_THRUST_ACCEL} * thrust * sin(angle) + wind
    ay = ${MAX_THRUST_ACCEL} * thrust * cos(angle) - 1.62
- Fuel burns at ${FUEL_BURN_PER_S} units/s at full thrust. At zero fuel you get no thrust at all.
- The sim runs at 30 Hz and gives up after ${MAX_FLIGHT_S} s.

PHYSICS THAT WILL BITE YOU
- Upright at full throttle your NET braking is only ${MAX_THRUST_ACCEL} - 1.62 = ${(MAX_THRUST_ACCEL - 1.62).toFixed(2)} m/s^2.
  Falling at 12 m/s you need roughly 3.6 s and 25 m of altitude to slow to 2 m/s.
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
Read the telemetry, change the controller, call fly again. Keep iterating.
Stop as soon as it lands.`;

/** Derived from the world so the brief can never drift out of sync with physics. */
function startLine(world: Conditions): string {
  const s = world.start;
  return `You start at x=${s.x} m, y=${s.y} m altitude, moving right at ${s.vx} m/s, descending at ${Math.abs(s.vy)} m/s, with ${s.fuel} fuel. The pad centre is at x=${world.padX}.`;
}

export function firstFlight(world: Conditions): string {
  return `The stock autopilot holds a fixed 20% throttle and never steers, so the lander sails past the pad and hits at speed.

${startLine(world)} No wind.

Write a better autopilot and call fly now.`;
}

export function relocated(world: Conditions): string {
  return `The mission changed. The landing pad has MOVED to x=${world.padX} — your autopilot is still flying to x=0, which is now bare ground.

${startLine(world)} There is also a light breeze pushing right at ${world.wind} m/s^2, and you have less fuel than last time.

Your current autopilot is still installed. Fly it once so we can see it miss, then retarget it and land on the new pad.

Call fly now.`;
}
