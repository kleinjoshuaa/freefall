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
  ): Promise<{ flown: number; rejected: number; landed: boolean }> => {
    let flown = 0;
    let rejected = 0;
    let landed = false;

    for await (const event of events) {
      const at = ((Date.now() - started) / 1000).toFixed(1).padStart(5);
      switch (event.kind) {
        case "hangar_open":
          console.log(`${at}s  ${label} stock     ${describe(event.baseline.telemetry)}`);
          break;
        case "conditions_changed":
          console.log(`${at}s  ${label} pad moved, autopilot unchanged`);
          break;
        case "attempt_flown": {
          flown += 1;
          const { attempt, telemetry } = event.trajectory;
          landed ||= telemetry.outcome.kind === "landed";
          console.log(
            `${at}s  ${label} attempt ${attempt}  ${describe(telemetry)}${event.note ? `  "${event.note}"` : ""}`,
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
          console.log(`${at}s  ${label} over  landed=${event.landed} attempts=${event.attempts}`);
          break;
        default:
          break;
      }
    }
    return { flown, rejected, landed };
  };

  const act1 = await runAct("act1", hangar.launch());
  const handoff = ((Date.now() - started) / 1000).toFixed(1);
  console.log("");
  console.log(`--- act 1 done at ${handoff}s, resuming the same agent ---`);
  console.log("");
  const act2 = await runAct("act2", hangar.harden());

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log("");
  console.log(`act 1 : ${act1.flown} flights, landed=${act1.landed ? "yes" : "no"}`);
  console.log(`act 2 : ${act2.flown} flights, landed=${act2.landed ? "yes" : "no"}`);
  console.log(`rejected      : ${act1.rejected + act2.rejected}`);
  console.log(`wall clock    : ${elapsed}s`);

  if (act1.flown === 0) {
    console.log("");
    console.log("NO-GO: the agent never called `fly`. Check the `mcp` allowlist.");
    process.exit(1);
  }
  if (!act1.landed || !act2.landed) {
    console.log("");
    console.log("SOFT NO-GO: an act never landed. Tune the mission brief.");
    process.exit(2);
  }
}

void main();
