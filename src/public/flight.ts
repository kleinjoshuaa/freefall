import fs from "node:fs/promises";
import path from "node:path";
import { Agent, CursorAgentError, type SDKAgent } from "@cursor/sdk";
import type {
  ApiKey,
  Arena,
  Conditions,
  ConditionsName,
  FlightEvent,
  FlightId,
  HangarRoot,
  Trajectory,
} from "./types.js";
import { asAttemptNo, asFlightId, asHangarRoot, parseApiKey } from "./types.js";
import { createChannel } from "./channel.js";
import {
  conditions,
  movedConditions,
  PAD_HALF_WIDTH,
  SAFE_DESCENT,
  WORLD_CEILING,
  WORLD_HALF_WIDTH,
} from "../world/physics.js";
import { simulate } from "../world/simulate.js";
import {
  buildFlyTool,
  CONTROLLER_PATH,
  createControllerRun,
  STOCK_PATH,
  type ControllerRun,
} from "../pilot/tools.js";
import { firstFlight, MISSION, relocated } from "../pilot/prompt.js";

/**
 * Custom tools ride the "mcp" capability group — leaving it out of the
 * allowlist silently unbinds `fly` and the model narrates instead. Nothing else
 * is granted: the mission brief carries every fact it needs, so filesystem
 * tools would only invite it to go read the repo and write an essay about it.
 */
const TOOLS = ["mcp"] as const;
const DENIED = ["edit", "shell", "read", "grep", "glob", "ls"] as const;
const MODEL = "composer-2.5";

/**
 * Two budgets, not one. Landing is open-ended because a bad run needs room to
 * recover; simplification is capped tight because it runs *after* the demo has
 * already succeeded and every extra flight is time the room spends watching a
 * green arc get shorter.
 */
const MAX_SOLVING_ATTEMPTS = 8;
const OPTIMIZATION_ATTEMPTS = 3;

const ARENA: Arena = {
  halfWidth: WORLD_HALF_WIDTH,
  ceiling: WORLD_CEILING,
  padHalfWidth: PAD_HALF_WIDTH,
  safeDescent: SAFE_DESCENT,
};

export type Hangar = {
  readonly id: FlightId | null;
  launch(): AsyncIterable<FlightEvent>;
  harden(): AsyncIterable<FlightEvent>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type HangarOptions = {
  readonly apiKey: string | undefined;
  readonly cwd: string;
};

const newRun = (previouslyFlown?: string): ControllerRun =>
  createControllerRun({
    maxSolvingAttempts: MAX_SOLVING_ATTEMPTS,
    optimizationAttempts: OPTIMIZATION_ATTEMPTS,
    previouslyFlown,
  });

export async function openHangar(options: HangarOptions): Promise<Hangar> {
  const apiKey: ApiKey = parseApiKey(options.apiKey);
  const root: HangarRoot = asHangarRoot(options.cwd);

  let agent: SDKAgent | undefined;
  let world: Conditions = conditions("calm");
  let moves = 0;
  let run: ControllerRun = newRun();

  let active: ReturnType<typeof createChannel<FlightEvent>> | undefined;

  const tools = () =>
    buildFlyTool({
      root,
      conditions: () => world,
      run: () => run,
      emit: (event) => active?.emit(event),
    });

  const flyFile = async (
    relative: string,
  ): Promise<{ trajectory: Trajectory; source: string }> => {
    const source = await fs.readFile(path.resolve(root, relative), "utf8");
    const result = await simulate(source, world);
    if (result.kind === "rejected") {
      throw new Error(`autopilot at ${relative} will not run: ${result.error}`);
    }
    return {
      source,
      trajectory: {
        attempt: asAttemptNo(0),
        conditions: world.name,
        frames: result.frames,
        telemetry: result.telemetry,
      },
    };
  };

  /** Rewinds the live controller to stock so every launch starts from failure. */
  const flyStock = async (): Promise<{ trajectory: Trajectory; source: string }> => {
    const stock = await fs.readFile(path.resolve(root, STOCK_PATH), "utf8");
    await fs.writeFile(path.resolve(root, CONTROLLER_PATH), stock, "utf8");
    return flyFile(STOCK_PATH);
  };

  const flyCurrent = () => flyFile(CONTROLLER_PATH);

  const drive = (
    channel: ReturnType<typeof createChannel<FlightEvent>>,
    body: () => Promise<void>,
  ): AsyncIterable<FlightEvent> => {
    active = channel;
    void (async () => {
      try {
        await body();
        const snapshot = run.snapshot();
        channel.emit({
          kind: "flight_over",
          landed: snapshot.kind !== "solving",
          attempts: snapshot.attempts,
          phase: snapshot.kind,
          best: snapshot.kind === "solving" ? null : snapshot.best.measure,
        });
      } catch (err) {
        if (err instanceof CursorAgentError) {
          channel.emit({
            kind: "failed",
            message: err.message,
            retryable: err.isRetryable,
          });
        } else {
          channel.emit({
            kind: "failed",
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
          });
        }
      } finally {
        channel.close();
      }
    })();
    return channel.stream();
  };

  const pump = async (prompt: string): Promise<void> => {
    if (!agent) throw new Error("hangar not started");
    const run = await agent.send(prompt, { local: { customTools: tools() } });
    console.log(`[freefall] agent=${agent.agentId} run=${run.id}`);

    for await (const message of run.stream()) {
      // Narration is deliberately dropped: the flight path is the output
      // channel. Only liveness reaches the screen.
      if (message.type === "assistant") active?.emit({ kind: "thinking" });
    }

    const result = await run.wait();
    if (result.status === "error") {
      throw new Error(`run failed: ${run.id}`);
    }
  };

  return {
    get id() {
      return agent ? asFlightId(agent.agentId) : null;
    },

    launch(): AsyncIterable<FlightEvent> {
      const channel = createChannel<FlightEvent>();
      return drive(channel, async () => {
        world = conditions("calm");
        moves = 0;
        const stock = await flyStock();
        run = newRun(stock.source);

        agent = await Agent.create({
          apiKey,
          model: { id: MODEL },
          tools: [...TOOLS],
          disallowedTools: [...DENIED],
          local: { cwd: root, customTools: tools() },
        });

        channel.emit({
          kind: "hangar_open",
          flightId: asFlightId(agent.agentId),
          world,
          arena: ARENA,
          baseline: stock.trajectory,
          source: stock.source,
        });

        await pump(
          `${MISSION}\n\n${firstFlight({ world, budget: MAX_SOLVING_ATTEMPTS, simplifications: OPTIMIZATION_ATTEMPTS })}`,
        );
      });
    },

    harden(): AsyncIterable<FlightEvent> {
      const channel = createChannel<FlightEvent>();
      return drive(channel, async () => {
        if (!agent) throw new Error("launch() before harden()");
        const previous = world;
        moves += 1;
        world = movedConditions(moves - 1);

        // Fly the unchanged autopilot against the moved pad so the miss is on
        // screen before the agent has said anything. The same flight is handed
        // to the agent as evidence — asking it to reproduce this would replay an
        // identical arc the room just watched and burn a landing flight.
        const stale = await flyCurrent();
        run = newRun(stale.source);
        channel.emit({
          kind: "conditions_changed",
          world,
          baseline: stale.trajectory,
          move: moves,
        });

        // Neither tools nor disallowedTools survive a resume; both are re-passed.
        agent = await Agent.resume(agent.agentId, {
          apiKey,
          model: { id: MODEL },
          tools: [...TOOLS],
          disallowedTools: [...DENIED],
          local: { cwd: root, customTools: tools() },
        });

        await pump(
          relocated({
            world,
            previousPadX: previous.padX,
            budget: MAX_SOLVING_ATTEMPTS,
            simplifications: OPTIMIZATION_ATTEMPTS,
            stale: stale.trajectory,
          }),
        );
      });
    },

    async [Symbol.asyncDispose](): Promise<void> {
      active?.close();
      if (agent) {
        await agent[Symbol.asyncDispose]();
        agent = undefined;
      }
    },
  };
}

export type { ConditionsName, FlightEvent, FlightId, Trajectory };
