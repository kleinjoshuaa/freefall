import fs from "node:fs/promises";
import path from "node:path";
import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import type {
  AttemptNo,
  AttemptReceipt,
  Conditions,
  FlightEvent,
  HangarRoot,
  OptimizationNote,
  OptimizationResult,
  SourceMeasure,
  Trajectory,
} from "../public/types.js";
import { asAttemptNo } from "../public/types.js";
import { describe, profileOf } from "../world/physics.js";
import { simulate } from "../world/simulate.js";

export const CONTROLLER_PATH = "fixtures/lander/controller.js";
export const STOCK_PATH = "fixtures/lander/stock.js";

export type FlyDeps = {
  readonly root: HangarRoot;
  conditions(): Conditions;
  run(): ControllerRun;
  emit(event: FlightEvent): void;
};

type AcceptedController = {
  readonly source: string;
  readonly measure: SourceMeasure;
};

export type ControllerRunSnapshot =
  | {
      readonly kind: "solving";
      readonly attempts: number;
      readonly solvingAttemptsRemaining: number;
    }
  | {
      readonly kind: "optimizing";
      readonly attempts: number;
      readonly attemptsRemaining: number;
      readonly best: AcceptedController;
    }
  | {
      readonly kind: "done";
      readonly attempts: number;
      readonly best: AcceptedController;
    };

type CandidateOutcome = "landed" | "failed" | "rejected";

type ControllerDecision = {
  readonly result: "solving_failed" | "first_success" | OptimizationResult;
  readonly candidate: SourceMeasure;
  readonly shouldPersist: boolean;
  readonly snapshot: ControllerRunSnapshot;
};

export type ControllerRun = {
  snapshot(): ControllerRunSnapshot;
  /** Normalized source of the most recent attempt, in any phase. */
  lastFlown(): string | null;
  record(source: string, outcome: CandidateOutcome): ControllerDecision;
};

function normalizeSource(source: string): string {
  return `${source.replaceAll("\r\n", "\n").trimEnd()}\n`;
}

export function measureSource(source: string): SourceMeasure {
  const normalized = normalizeSource(source);
  return {
    bytes: Buffer.byteLength(normalized, "utf8"),
    lines: normalized.trimEnd().split("\n").length,
  };
}

export function createControllerRun(options: {
  readonly maxSolvingAttempts: number;
  readonly optimizationAttempts: number;
  /**
   * Source the harness already flew and showed before the agent was prompted.
   * Seeding it makes the first submission subject to the same no-op rule as
   * every later one; without it the opening flight of an act is the one repeat
   * that can still get through.
   */
  readonly previouslyFlown?: string;
}): ControllerRun {
  let state: ControllerRunSnapshot = {
    kind: "solving",
    attempts: 0,
    solvingAttemptsRemaining: options.maxSolvingAttempts,
  };
  let last: string | null = options.previouslyFlown
    ? normalizeSource(options.previouslyFlown)
    : null;

  return {
    snapshot: () => state,
    lastFlown: () => last,

    record(source, outcome) {
      const normalized = normalizeSource(source);
      const candidate = measureSource(normalized);
      last = normalized;

      if (state.kind === "done") {
        throw new Error("controller run is already done");
      }

      if (state.kind === "solving") {
        if (state.solvingAttemptsRemaining <= 0) {
          throw new Error("no solving attempts remain");
        }
        const attempts = state.attempts + 1;
        const solvingAttemptsRemaining = state.solvingAttemptsRemaining - 1;
        if (outcome !== "landed") {
          state = { kind: "solving", attempts, solvingAttemptsRemaining };
          return {
            result: "solving_failed",
            candidate,
            shouldPersist: outcome === "failed",
            snapshot: state,
          };
        }

        const best = { source: normalized, measure: candidate };
        state =
          options.optimizationAttempts > 0
            ? {
                kind: "optimizing",
                attempts,
                attemptsRemaining: options.optimizationAttempts,
                best,
              }
            : { kind: "done", attempts, best };
        return {
          result: "first_success",
          candidate,
          shouldPersist: true,
          snapshot: state,
        };
      }

      const attempts = state.attempts + 1;
      const attemptsRemaining = state.attemptsRemaining - 1;
      let result: OptimizationResult;
      let best = state.best;

      if (normalized === state.best.source) {
        result = "identical";
      } else if (outcome === "rejected") {
        result = "rejected";
      } else if (outcome === "failed") {
        result = "failed";
      } else if (candidate.bytes >= state.best.measure.bytes) {
        result = "not_shorter";
      } else {
        result = "accepted";
        best = { source: normalized, measure: candidate };
      }

      state =
        attemptsRemaining > 0
          ? { kind: "optimizing", attempts, attemptsRemaining, best }
          : { kind: "done", attempts, best };
      return {
        result,
        candidate,
        shouldPersist: result === "accepted",
        snapshot: state,
      };
    },
  };
}

const asString = (v: SDKJsonValue | undefined): string =>
  typeof v === "string" ? v : "";

/** Captions ride next to the flight path on screen, so they must stay short. */
const asNote = (v: SDKJsonValue | undefined): string =>
  asString(v).split(/\s+/).filter(Boolean).slice(0, 6).join(" ");

export function buildFlyTool(deps: FlyDeps): Record<string, SDKCustomTool> {
  const fly: SDKCustomTool = {
    description:
      "Install an autopilot and fly it. First land, then submit shorter controllers " +
      "that still land. This is the only way to affect anything.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description:
            "Complete ES module source. Must export `function control(s)` returning { thrust, tilt }.",
        },
        note: {
          type: "string",
          description: "Six words or fewer: what you changed and why.",
        },
      },
      required: ["source"],
    },

    execute: async (args) => {
      const run = deps.run();
      const before = run.snapshot();
      if (before.kind === "done") {
        return "DONE — the shortest landing controller is installed. Stop now.";
      }
      if (before.kind === "solving" && before.solvingAttemptsRemaining <= 0) {
        return "NO FLIGHTS LEFT — you never landed. Stop now.";
      }

      const source = asString(args.source);
      const attempt = asAttemptNo(before.attempts + 1);

      const rejectWith = (error: string): string => {
        const decision = run.record(source, "rejected");
        const receipt = receiptOf({
          attempt,
          decision,
          outcomeLine: `REJECTED: ${error}`,
          profile: "",
        });
        deps.emit({ kind: "attempt_rejected", attempt, error, receipt });
        return receipt.text;
      };

      if (!source.includes("control")) {
        return rejectWith("source must export `function control(s)`");
      }

      // The simulator is a pure function of source and world, so a repeat can
      // only return the line the model already has. Flying it would also replay
      // a visually identical arc on screen.
      if (normalizeSource(source) === run.lastFlown()) {
        return rejectWith(
          "identical to your last flight — the simulator is deterministic, so this " +
            "returns the same telemetry. Change the controller before flying again.",
        );
      }

      const world = deps.conditions();
      const result = await simulate(source, world);
      if (result.kind === "rejected") return rejectWith(result.error);

      const landed = result.telemetry.outcome.kind === "landed";
      const decision = run.record(source, landed ? "landed" : "failed");

      // Persist only what is both runnable and worth keeping: during solving
      // that is every flight, during optimization only an accepted shortening.
      // Writing a losing simplification here would replace a controller that
      // lands with one that does not.
      if (decision.shouldPersist) {
        await fs.writeFile(
          path.resolve(deps.root, CONTROLLER_PATH),
          normalizeSource(source),
          "utf8",
        );
      }

      const trajectory: Trajectory = {
        attempt,
        conditions: world.name,
        frames: result.frames,
        telemetry: result.telemetry,
      };

      const receipt = receiptOf({
        attempt,
        decision,
        outcomeLine: describe(result.telemetry),
        profile: profileOf(result.frames),
      });

      deps.emit({
        kind: "attempt_flown",
        trajectory,
        source,
        note: asNote(args.note),
        receipt,
      });

      return receipt.text;
    },
  };

  return { fly };
}

function optimizationNoteOf(decision: ControllerDecision): OptimizationNote | null {
  const { snapshot, result } = decision;
  if (snapshot.kind === "solving") return null;
  if (result === "solving_failed" || result === "first_success") return null;
  return {
    result,
    candidate: decision.candidate,
    best: snapshot.best.measure,
    bestSource: snapshot.best.source,
    attemptsRemaining:
      snapshot.kind === "optimizing" ? snapshot.attemptsRemaining : 0,
  };
}

const OPTIMIZATION_VERDICT: Record<OptimizationResult, string> = {
  accepted: "ACCEPTED — new shortest controller that still lands.",
  failed: "NOT ACCEPTED — shorter, but it did not land. Previous best kept.",
  identical: "NOT ACCEPTED — identical source. Actually simplify it.",
  not_shorter: "NOT ACCEPTED — it landed but was no shorter.",
  rejected: "NOT ACCEPTED — it would not run. Previous best kept.",
};

const sizeOf = (m: SourceMeasure): string => `${m.bytes} bytes / ${m.lines} lines`;

/**
 * One string, built once, and handed to both the model and the screen. Deriving
 * the on-screen version separately is how a demo ends up showing telemetry the
 * agent never actually read.
 */
function receiptOf(input: {
  readonly attempt: AttemptNo;
  readonly decision: ControllerDecision;
  readonly outcomeLine: string;
  readonly profile: string;
}): AttemptReceipt {
  const { decision, outcomeLine, profile } = input;
  const snapshot = decision.snapshot;
  const optimization = optimizationNoteOf(decision);

  const lines = [outcomeLine];
  if (profile) lines.push(`flight profile: ${profile}`);

  if (snapshot.kind === "solving") {
    lines.push(`flights left to land: ${snapshot.solvingAttemptsRemaining}`);
  } else if (decision.result === "first_success") {
    lines.push(
      `LANDED — now simplify. Accepted controller is ${sizeOf(snapshot.best.measure)}.`,
      "Send a SHORTER controller that still lands. Shorter only counts if it lands.",
    );
  } else if (optimization) {
    lines.push(
      `candidate ${sizeOf(optimization.candidate)} vs best ${sizeOf(optimization.best)}`,
      OPTIMIZATION_VERDICT[optimization.result],
    );
  }

  if (snapshot.kind === "optimizing") {
    lines.push(`simplification flights left: ${snapshot.attemptsRemaining}`);
  } else if (snapshot.kind === "done") {
    lines.push(
      `DONE — shortest landing controller is ${sizeOf(snapshot.best.measure)} and is installed. Stop now.`,
    );
  }

  return {
    attempt: input.attempt,
    phase: snapshot.kind,
    text: lines.join("\n"),
    outcomeLine,
    profile,
    best: snapshot.kind === "solving" ? null : snapshot.best.measure,
    optimization,
  };
}
