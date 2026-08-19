import { openHangar } from "../src/public/flight.js";
import { describe } from "../src/world/physics.js";

async function main(): Promise<void> {
  await using hangar = await openHangar({
    apiKey: process.env.CURSOR_API_KEY,
    cwd: process.cwd(),
  });

  const started = Date.now();

  const runAct = async (
    label: string,
    events: AsyncIterable<import("../src/public/types.js").FlightEvent>,
  ): Promise<{
    flown: number;
    rejected: number;
    landed: boolean;
    simplified: number;
    shortest: number | null;
  }> => {
    let flown = 0;
    let rejected = 0;
    let landed = false;
    let simplified = 0;
    let shortest: number | null = null;

    for await (const event of events) {
      const at = ((Date.now() - started) / 1000).toFixed(1).padStart(5);
      switch (event.kind) {
        case "hangar_open":
          console.log(`${at}s  ${label} stock     ${describe(event.baseline.telemetry)}`);
          break;
        case "conditions_changed":
          console.log(
            `${at}s  ${label} pad moved to x=${event.world.padX} (move ${event.move}, g=${event.world.gravity}, wind=${event.world.wind}), autopilot unchanged`,
          );
          break;
        case "attempt_flown": {
          flown += 1;
          const { attempt, telemetry } = event.trajectory;
          const { optimization } = event.receipt;
          landed ||= telemetry.outcome.kind === "landed";
          if (optimization?.result === "accepted") simplified += 1;
          console.log(
            `${at}s  ${label} attempt ${attempt} [${event.receipt.phase}]  ${describe(telemetry)}` +
              `${optimization ? `  ${optimization.result} ${optimization.candidate.bytes}B vs ${optimization.best.bytes}B` : ""}` +
              `${event.note ? `  "${event.note}"` : ""}`,
          );
          break;
        }
        case "attempt_rejected":
          rejected += 1;
          console.log(`${at}s  ${label} attempt ${event.attempt}  REJECTED ${event.error}`);
          break;
        case "failed":
          console.log(`${at}s  ${label} FAILED ${event.message} (retryable=${event.retryable})`);
          break;
        case "flight_over":
          shortest = event.best?.bytes ?? null;
          console.log(
            `${at}s  ${label} over  landed=${event.landed} attempts=${event.attempts}` +
              ` phase=${event.phase}${event.best ? ` best=${event.best.bytes}B/${event.best.lines}L` : ""}`,
          );
          break;
        default:
          break;
      }
    }
    return { flown, rejected, landed, simplified, shortest };
  };

  const act1 = await runAct("act1", hangar.launch());
  const handoff = ((Date.now() - started) / 1000).toFixed(1);
  console.log("");
  console.log(`--- act 1 done at ${handoff}s, resuming the same agent ---`);
  console.log("");
  // Two moves, not one: the pad can be moved repeatedly in the demo, and the
  // second resume is where a stale tool binding or a spent budget would show up.
  const act2 = await runAct("act2", hangar.harden());
  console.log("");
  console.log("--- moving the pad again, same agent ---");
  console.log("");
  const act3 = await runAct("act3", hangar.harden());

  const acts = [act1, act2, act3];
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log("");
  for (const [i, act] of acts.entries()) {
    console.log(
      `act ${i + 1} : ${act.flown} flights, landed=${act.landed ? "yes" : "no"},` +
        ` simplifications accepted=${act.simplified}` +
        `${act.shortest === null ? "" : `, final=${act.shortest}B`}`,
    );
  }
  console.log(`rejected      : ${acts.reduce((n, a) => n + a.rejected, 0)}`);
  console.log(`wall clock    : ${elapsed}s`);

  if (act1.flown === 0) {
    console.log("");
    console.log("NO-GO: the agent never called `fly`. Check the `mcp` allowlist.");
    process.exit(1);
  }
  if (acts.some((act) => !act.landed)) {
    console.log("");
    console.log("SOFT NO-GO: an act never landed. Tune the mission brief.");
    process.exit(2);
  }
}

void main();
