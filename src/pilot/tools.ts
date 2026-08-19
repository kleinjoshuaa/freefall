import fs from "node:fs/promises";
import path from "node:path";
import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import type {
  Conditions,
  FlightEvent,
  HangarRoot,
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
  emit(event: FlightEvent): void;
  onLanded(): void;
  readonly maxAttempts: number;
};

const asString = (v: SDKJsonValue | undefined): string =>
  typeof v === "string" ? v : "";

/** Captions ride next to the flight path on screen, so they must stay short. */
const asNote = (v: SDKJsonValue | undefined): string =>
  asString(v).split(/\s+/).filter(Boolean).slice(0, 6).join(" ");

export function buildFlyTool(deps: FlyDeps): Record<string, SDKCustomTool> {
  let attempts = 0;

  const fly: SDKCustomTool = {
    description:
      "Install an autopilot and fly it. Returns telemetry from the flight. " +
      "This is the only way to affect anything.",
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
      if (attempts >= deps.maxAttempts) {
        return `NO FLIGHTS LEFT — you have used all ${deps.maxAttempts} attempts. Stop now.`;
      }

      const source = asString(args.source);
      if (!source.includes("control")) {
        return "REJECTED: source must export `function control(s)`.";
      }

      attempts += 1;
      const attempt = asAttemptNo(attempts);
      const world = deps.conditions();

      const result = await simulate(source, world);

      if (result.kind === "rejected") {
        deps.emit({ kind: "attempt_rejected", attempt, error: result.error });
        return `REJECTED: ${result.error}. The previous autopilot is still installed. Fix it and call fly again.`;
      }

      // Persist only after the controller proves it runs, so the file on disk is
      // always something that actually flew.
      await fs.writeFile(
        path.resolve(deps.root, CONTROLLER_PATH),
        source.endsWith("\n") ? source : `${source}\n`,
        "utf8",
      );

      const trajectory: Trajectory = {
        attempt,
        conditions: world.name,
        frames: result.frames,
        telemetry: result.telemetry,
      };

      deps.emit({
        kind: "attempt_flown",
        trajectory,
        source,
        note: asNote(args.note),
      });

      if (result.telemetry.outcome.kind === "landed") deps.onLanded();

      const left = deps.maxAttempts - attempts;
      return [
        describe(result.telemetry),
        `flight profile: ${profileOf(result.frames)}`,
        `attempts left: ${left}`,
      ].join("\n");
    },
  };

  return { fly };
}