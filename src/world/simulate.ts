import { Worker } from "node:worker_threads";
import type { Conditions, LanderState, Telemetry } from "../public/types.js";

export type SimResult =
  | {
      readonly kind: "ok";
      readonly frames: readonly LanderState[];
      readonly telemetry: Telemetry;
    }
  | { readonly kind: "rejected"; readonly error: string };

const WORKER = new URL("./run-worker.ts", import.meta.url);

/** Full float precision triples the payload for a trail nobody measures. */
function compact(frames: readonly LanderState[]): LanderState[] {
  const r = (v: number) => Math.round(v * 100) / 100;
  return frames.map((f) => ({
    t: r(f.t),
    x: r(f.x),
    y: r(f.y),
    vx: r(f.vx),
    vy: r(f.vy),
    angleDeg: r(f.angleDeg),
    fuel: r(f.fuel),
  }));
}

/**
 * Model-written controllers run in a worker with a hard timeout. A `while(true)`
 * in a controller would otherwise wedge the event loop and take the demo with
 * it, which is unrecoverable in front of an audience.
 */
export function simulate(
  source: string,
  conditions: Conditions,
  timeoutMs = 4000,
): Promise<SimResult> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER, {
      workerData: { source, conditions },
      execArgv: ["--import", "tsx"],
    });

    let settled = false;
    const finish = (result: SimResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        kind: "rejected",
        error: `controller did not finish within ${timeoutMs}ms — likely an unbounded loop`,
      });
    }, timeoutMs);

    worker.on("message", (msg: SimResult | { ok: boolean; error?: string }) => {
      if ("ok" in msg && msg.ok === true) {
        const done = msg as unknown as {
          frames: LanderState[];
          telemetry: Telemetry;
        };
        finish({
          kind: "ok",
          frames: compact(done.frames),
          telemetry: done.telemetry,
        });
        return;
      }
      finish({
        kind: "rejected",
        error: (msg as { error?: string }).error ?? "controller failed",
      });
    });

    worker.on("error", (err) => {
      finish({ kind: "rejected", error: err.message });
    });
  });
}
