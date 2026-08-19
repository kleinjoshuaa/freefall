declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type FlightId = Brand<string, "FlightId">;
export type AttemptNo = Brand<number, "AttemptNo">;
export type ApiKey = Brand<string, "ApiKey">;
export type HangarRoot = Brand<string, "HangarRoot">;

export type ConditionsName =
  | "calm"
  | "moved-east"
  | "moved-west"
  | "moved-crosswind";

/**
 * One simulation tick. Flat scalars rather than nested vectors: this shape is
 * handed to model-written controllers, and every level of nesting is another
 * thing for it to get wrong.
 */
export type LanderState = {
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angleDeg: number;
  readonly fuel: number;
};

export type Command = {
  readonly thrust: number;
  readonly tilt: number;
};

export type Conditions = {
  readonly name: ConditionsName;
  readonly gravity: number;
  readonly wind: number;
  readonly padX: number;
  readonly start: LanderState;
};

export type Outcome =
  | { readonly kind: "landed"; readonly score: number }
  | {
      readonly kind: "crashed";
      readonly reason: "impact_speed" | "tilt" | "off_pad" | "out_of_bounds";
    }
  | { readonly kind: "stranded"; readonly reason: "out_of_fuel" | "timeout" };

export type Telemetry = {
  readonly outcome: Outcome;
  readonly touchdownX: number;
  readonly missDistance: number;
  readonly impactSpeed: number;
  readonly tiltDeg: number;
  readonly fuelLeft: number;
  readonly fuelUsed: number;
  readonly durationS: number;
};

/** Fixed dimensions a renderer needs to lay out the scene. */
export type Arena = {
  readonly halfWidth: number;
  readonly ceiling: number;
  readonly padHalfWidth: number;
  readonly safeDescent: number;
};

export type Trajectory = {
  readonly attempt: AttemptNo;
  readonly conditions: ConditionsName;
  readonly frames: readonly LanderState[];
  readonly telemetry: Telemetry;
};

export type SourceMeasure = {
  readonly bytes: number;
  readonly lines: number;
};

export type OptimizationResult =
  | "accepted"
  | "failed"
  | "identical"
  | "not_shorter"
  | "rejected";

export type RunPhase = "solving" | "optimizing" | "done";

export type OptimizationNote = {
  readonly result: OptimizationResult;
  readonly candidate: SourceMeasure;
  readonly best: SourceMeasure;
  readonly bestSource: string;
  readonly attemptsRemaining: number;
};

/**
 * The exact tool return value, decomposed. `text` is byte-for-byte what the
 * model read; the parts beside it exist so the renderer can lay the same
 * information out spatially instead of printing a paragraph. Anything shown on
 * screen must come from this record, or the screen is telling a different story
 * than the one the agent is reacting to.
 */
export type AttemptReceipt = {
  readonly attempt: AttemptNo;
  readonly phase: RunPhase;
  readonly text: string;
  readonly outcomeLine: string;
  readonly profile: string;
  /** Size of the accepted landing controller; null until something lands. */
  readonly best: SourceMeasure | null;
  readonly optimization: OptimizationNote | null;
};

/**
 * The public wire. Deliberately contains no SDK concepts: no run ids, no
 * message types, no tool-call shapes. A renderer can consume this without
 * knowing an agent exists.
 */
export type FlightEvent =
  | {
      readonly kind: "hangar_open";
      readonly flightId: FlightId;
      readonly world: Conditions;
      readonly arena: Arena;
      readonly baseline: Trajectory;
      readonly source: string;
    }
  | { readonly kind: "thinking" }
  | {
      readonly kind: "attempt_flown";
      readonly trajectory: Trajectory;
      readonly source: string;
      readonly note: string;
      readonly receipt: AttemptReceipt;
    }
  | {
      readonly kind: "attempt_rejected";
      readonly attempt: AttemptNo;
      readonly error: string;
      readonly receipt: AttemptReceipt;
    }
  | {
      readonly kind: "conditions_changed";
      readonly world: Conditions;
      readonly baseline: Trajectory;
      readonly move: number;
    }
  | {
      readonly kind: "flight_over";
      readonly landed: boolean;
      readonly attempts: number;
      readonly phase: RunPhase;
      readonly best: SourceMeasure | null;
    }
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly retryable: boolean;
    };

export function parseApiKey(raw: string | undefined): ApiKey {
  const trimmed = raw?.trim();
  if (!trimmed) {
    const shadowed =
      raw !== undefined
        ? " CURSOR_API_KEY is set but empty in your shell, which overrides .env — run `unset CURSOR_API_KEY`."
        : "";
    throw new Error(
      `CURSOR_API_KEY is not set. Export it or copy .env.example to .env.${shadowed}`,
    );
  }
  return trimmed as ApiKey;
}

export function asHangarRoot(cwd: string): HangarRoot {
  return cwd as HangarRoot;
}

export function asFlightId(raw: string): FlightId {
  return raw as FlightId;
}

export function asAttemptNo(n: number): AttemptNo {
  return n as AttemptNo;
}
