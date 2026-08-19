# Freefall

A durable Cursor SDK agent writes the autopilot for a lunar lander, watches it
crash, and rewrites it — while you watch the flight path change on screen.

The point of the demo is the **closed loop**. The agent's only tool flies the
controller it just wrote and hands back real telemetry. It sees its own code
fail and revises. Nothing on screen is a progress bar: while the model thinks,
the current autopilot keeps flying its failing trajectory on repeat.

## Run it

```bash
npm install
cp .env.example .env      # then paste your key into CURSOR_API_KEY
npm run dev               # http://localhost:4321
```

If `CURSOR_API_KEY` is set but empty in your shell it will shadow `.env`.
Run `unset CURSOR_API_KEY` and start again.

Two buttons:

- **Launch** — the agent writes an autopilot, flies it, and iterates until it lands.
- **Move the pad** — same agent, resumed. The pad relocates and its autopilot is
  suddenly aiming at bare ground.

Typical run is 30–60 s per act.

## Verify before you demo

```bash
npm run world-check    # no API key needed: is the world failable and winnable?
npm run probe-hands    # full two-act rehearsal against the real agent
```

`world-check` is the one to run first. It asserts that the stock autopilot
fails, that a hand-written one can land, that both acts are winnable, and that
an infinite loop or a malformed return is rejected rather than absorbed.

`probe-hands` is the go/no-go gate. If it prints `NO-GO`, the agent never called
the tool and no amount of UI work will save the demo.

## How it fits together

```
src/
  world/      physics, worker isolation, deterministic simulation
  pilot/      the mission brief and the one custom tool
  public/     Hangar — the entire public surface
  server.ts   static files + NDJSON event stream
public/       canvas renderer and the code panel
fixtures/lander/
  stock.js       pristine baseline, never written to
  controller.js  the live file the agent overwrites
```

`src/public/flight.ts` is the only module that imports `@cursor/sdk`. Everything
crossing the wire is domain data — trajectories and telemetry. No `Agent`,
`Run`, or `SDKMessage` reaches the renderer.

### Three things worth stealing

**Custom tools ride the `mcp` capability group.** Leave `"mcp"` out of the
`tools` allowlist and your tools silently unbind — the model narrates instead of
acting, and nothing tells you why. Neither `tools` nor `disallowedTools`
survives `Agent.resume`, so both are re-passed.

**Model-written code runs in a worker with a timeout.** A `while(true)` in a
controller would otherwise wedge the event loop and take the demo with it.

**Never coerce a bad number into a valid one.** An early version turned `NaN`
thrust into `0`, which read downstream as "the pilot chose not to fire the
engine" and sent the model chasing a bug that did not exist. Rejecting loudly,
with the offending tick and the exact state field names, removed the failure.

## Talk track

See [docs/TALK_TRACK.md](docs/TALK_TRACK.md).
