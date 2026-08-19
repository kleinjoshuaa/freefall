import type {
  Command,
  Conditions,
  ConditionsName,
  LanderState,
  Outcome,
  Telemetry,
} from "../public/types.js";

export const DT = 1 / 30;
export const MAX_FLIGHT_S = 45;
export const MAX_THRUST_ACCEL = 5.0;
export const MAX_TILT_DEG = 30;
export const TILT_SLEW_DEG_PER_S = 60;
export const FUEL_BURN_PER_S = 8;

export const PAD_HALF_WIDTH = 6;
export const SAFE_DESCENT = 2.5;
export const SAFE_DRIFT = 1.5;
// Generous on purpose. Station-keeping in wind needs a standing lean of ~16 deg
// at hover throttle, so a tight limit makes the crosswind act unwinnable and
// fails on an attitude number nobody in the room can see.
export const SAFE_TILT_DEG = 20;

export const WORLD_HALF_WIDTH = 130;
export const WORLD_CEILING = 300;

/** Landing gear length: contact happens here, not at y=0 exactly. */
export const GEAR = 0.5;

/** Lunar baseline. Kept as the calm act so the first controller is learned there. */
export const LUNAR_GRAVITY = 1.62;

const CONDITIONS: Record<ConditionsName, Conditions> = {
  calm: {
    name: "calm",
    gravity: LUNAR_GRAVITY,
    wind: 0,
    padX: 0,
    start: { t: 0, x: -45, y: 80, vx: 6, vy: -2, angleDeg: 0, fuel: 120 },
  },
  // Every moved scenario starts the lander tens of metres to one side of the
  // pad. A launch point above the pad makes the relocation invisible: the stale
  // autopilot would fly a plausible-looking approach and the audience would have
  // to read the miss number to know anything changed.
  //
  // Gravity and wind both shift so "Move the pad" changes more than one number.
  // Values stay under MAX_THRUST_ACCEL so a retargeted controller can still hover.
  "moved-east": {
    name: "moved-east",
    gravity: 1.35,
    wind: 0.12,
    padX: 44,
    start: { t: 0, x: 2, y: 92, vx: 3, vy: -2, angleDeg: 0, fuel: 130 },
  },
  "moved-west": {
    name: "moved-west",
    gravity: 1.9,
    wind: -0.12,
    padX: -46,
    start: { t: 0, x: -4, y: 88, vx: -3, vy: -2, angleDeg: 0, fuel: 130 },
  },
  "moved-crosswind": {
    name: "moved-crosswind",
    gravity: 2.1,
    wind: 0.22,
    padX: 18,
    start: { t: 0, x: -34, y: 96, vx: 2, vy: -2, angleDeg: 0, fuel: 140 },
  },
};

export function conditions(name: ConditionsName): Conditions {
  return CONDITIONS[name];
}

/**
 * Cycled in order rather than sampled at random. "Move the pad" has to look
 * different every press *and* be winnable every press; unbounded randomness
 * buys the first at the cost of the second, and the failure only shows up live.
 */
export const MOVED_CONDITIONS = [
  "moved-east",
  "moved-west",
  "moved-crosswind",
] as const satisfies readonly ConditionsName[];

/** `moveIndex` is 0-based: the first press of "Move the pad" is 0. */
export function movedConditions(moveIndex: number): Conditions {
  const n = MOVED_CONDITIONS.length;
  return conditions(MOVED_CONDITIONS[((moveIndex % n) + n) % n]);
}

/** Horizontal gap between launch point and pad centre, in metres. */
export function launchOffset(world: Conditions): number {
  return Math.abs(world.start.x - world.padX);
}

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

const finite = (v: number, fallback: number): number =>
  Number.isFinite(v) ? v : fallback;

export function step(
  state: LanderState,
  raw: Command,
  world: Conditions,
): LanderState {
  const hasFuel = state.fuel > 0;
  const thrust = hasFuel ? clamp(finite(raw.thrust, 0), 0, 1) : 0;
  const tilt = clamp(finite(raw.tilt, 0), -1, 1);

  const targetAngle = tilt * MAX_TILT_DEG;
  const maxSlew = TILT_SLEW_DEG_PER_S * DT;
  const angleDeg =
    state.angleDeg + clamp(targetAngle - state.angleDeg, -maxSlew, maxSlew);

  const rad = (angleDeg * Math.PI) / 180;
  const accel = thrust * MAX_THRUST_ACCEL;

  const ax = accel * Math.sin(rad) + world.wind;
  const ay = accel * Math.cos(rad) - world.gravity;

  const vx = state.vx + ax * DT;
  const vy = state.vy + ay * DT;

  return {
    t: state.t + DT,
    x: state.x + vx * DT,
    y: state.y + vy * DT,
    vx,
    vy,
    angleDeg,
    fuel: Math.max(0, state.fuel - thrust * FUEL_BURN_PER_S * DT),
  };
}

export type Termination =
  | { readonly kind: "flying" }
  | { readonly kind: "touchdown" }
  | { readonly kind: "out_of_bounds" }
  | { readonly kind: "timeout" };

export function terminationOf(state: LanderState): Termination {
  if (state.y <= GEAR) return { kind: "touchdown" };
  if (Math.abs(state.x) > WORLD_HALF_WIDTH || state.y > WORLD_CEILING) {
    return { kind: "out_of_bounds" };
  }
  if (state.t >= MAX_FLIGHT_S) return { kind: "timeout" };
  return { kind: "flying" };
}

function outcomeOf(
  state: LanderState,
  end: Termination,
  world: Conditions,
): Outcome {
  if (end.kind === "out_of_bounds") {
    return { kind: "crashed", reason: "out_of_bounds" };
  }
  if (end.kind === "timeout") {
    return { kind: "stranded", reason: state.fuel <= 0 ? "out_of_fuel" : "timeout" };
  }

  const descent = Math.abs(state.vy);
  const drift = Math.abs(state.vx);
  const tilt = Math.abs(state.angleDeg);
  const missDistance = Math.abs(state.x - world.padX);

  if (missDistance > PAD_HALF_WIDTH) return { kind: "crashed", reason: "off_pad" };
  if (tilt > SAFE_TILT_DEG) return { kind: "crashed", reason: "tilt" };
  if (descent > SAFE_DESCENT || drift > SAFE_DRIFT) {
    return { kind: "crashed", reason: "impact_speed" };
  }

  const gentleness = 1 - descent / SAFE_DESCENT;
  const centering = 1 - missDistance / PAD_HALF_WIDTH;
  const thrift = state.fuel / world.start.fuel;
  const score = Math.round(
    100 * (0.45 * gentleness + 0.3 * centering + 0.25 * thrift),
  );
  return { kind: "landed", score };
}

export function telemetryOf(
  state: LanderState,
  end: Termination,
  world: Conditions,
): Telemetry {
  return {
    outcome: outcomeOf(state, end, world),
    touchdownX: round(state.x),
    missDistance: round(state.x - world.padX),
    impactSpeed: round(Math.hypot(state.vx, state.vy)),
    tiltDeg: round(state.angleDeg),
    fuelLeft: round(state.fuel),
    fuelUsed: round(world.start.fuel - state.fuel),
    durationS: round(state.t),
  };
}

const round = (v: number): number => Math.round(v * 10) / 10;

/**
 * A handful of waypoints from the flight. Terminal telemetry alone tells the
 * model that it arrived too fast but not where the descent went wrong, which
 * leaves it tuning a profile blind and resubmitting near-identical controllers.
 */
export function profileOf(frames: readonly LanderState[], samples = 6): string {
  if (frames.length === 0) return "";
  const step = Math.max(1, Math.floor((frames.length - 1) / (samples - 1)));
  const picks: LanderState[] = [];
  for (let i = 0; i < frames.length; i += step) picks.push(frames[i] as LanderState);
  const last = frames[frames.length - 1] as LanderState;
  if (picks[picks.length - 1] !== last) picks.push(last);

  return picks
    .map(
      (s) =>
        `t=${round(s.t)} y=${round(s.y)} vy=${round(s.vy)} x=${round(s.x)} vx=${round(s.vx)}`,
    )
    .join(" | ");
}

/**
 * Terse on purpose. This string is the model's entire feedback channel, and
 * verbose tool receipts invite verbose replies instead of another attempt.
 */
export function describe(t: Telemetry): string {
  const where = `x=${t.touchdownX} (miss=${t.missDistance}) speed=${t.impactSpeed} tilt=${t.tiltDeg}deg fuel=${t.fuelLeft} t=${t.durationS}s`;
  const idle =
    t.fuelUsed < 1
      ? " | WARNING: you burned no fuel — control() never commanded thrust, so this was a free fall"
      : "";
  switch (t.outcome.kind) {
    case "landed":
      return `LANDED score=${t.outcome.score} ${where}`;
    case "crashed":
      return `CRASHED (${t.outcome.reason}) ${where} | limits: speed<=${SAFE_DESCENT} drift<=${SAFE_DRIFT} |x|<=${PAD_HALF_WIDTH} tilt<=${SAFE_TILT_DEG}${idle}`;
    case "stranded":
      return (
        `STRANDED (${t.outcome.reason}) ${where}${idle}` +
        ` | you were still airborne at ${MAX_FLIGHT_S}s. A good descent reaches the ground in 15-25 s and uses 40-70 fuel.` +
        ` Hovering near the pad burns the tank without landing — commit to a descent.`
      );
  }
}
