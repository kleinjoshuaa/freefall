import { parentPort, workerData } from "node:worker_threads";
import type { Conditions, LanderState } from "../public/types.js";
import { step, telemetryOf, terminationOf } from "./physics.js";

type Job = { readonly source: string; readonly conditions: Conditions };

async function main(): Promise<void> {
  const job = workerData as Job;
  const world = job.conditions;

  const encoded = Buffer.from(job.source, "utf8").toString("base64");
  const mod: Record<string, unknown> = await import(
    `data:text/javascript;base64,${encoded}`
  );

  const control = mod.control;
  if (typeof control !== "function") {
    throw new Error("module must export a function named `control`");
  }

  let state = world.start;
  const frames: LanderState[] = [state];
  let end = terminationOf(state);

  while (end.kind === "flying") {
    const command = (control as (s: LanderState) => unknown)({ ...state });
    if (
      typeof command !== "object" ||
      command === null ||
      typeof (command as { thrust?: unknown }).thrust !== "number" ||
      typeof (command as { tilt?: unknown }).tilt !== "number"
    ) {
      throw new Error("control() must return { thrust: number, tilt: number }");
    }

    // Never coerce a bad number into a valid one. Silently treating NaN as zero
    // thrust reads downstream as "the pilot chose not to fire the engine", which
    // sends the model chasing a control bug that does not exist.
    const { thrust, tilt } = command as { thrust: number; tilt: number };
    if (!Number.isFinite(thrust) || !Number.isFinite(tilt)) {
      throw new Error(
        `control() returned thrust=${thrust} tilt=${tilt} at t=${state.t.toFixed(2)}s ` +
          `(state: x=${state.x.toFixed(1)} y=${state.y.toFixed(1)} vx=${state.vx.toFixed(1)} vy=${state.vy.toFixed(1)} angleDeg=${state.angleDeg.toFixed(1)} fuel=${state.fuel.toFixed(1)}). ` +
          `The state object has exactly these fields: t, x, y, vx, vy, angleDeg, fuel. Anything else is undefined.`,
      );
    }

    state = step(state, { thrust, tilt }, world);
    frames.push(state);
    end = terminationOf(state);
  }

  parentPort?.postMessage({
    ok: true,
    frames,
    telemetry: telemetryOf(state, end, world),
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  parentPort?.postMessage({ ok: false, error: message });
});
