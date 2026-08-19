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

`dev` watches `src/**` and restarts on change. The browser reloads `public/`
on its own, so without the watch a long-lived server keeps streaming events in
whatever shape it booted with while the page expects the shape you just wrote.
Editing `src/**` mid-run therefore ends that run — edit between acts.

Two buttons:

- **Launch** — the agent writes an autopilot, flies it, and iterates until it
  lands. Then it keeps going: a bounded simplification phase where it tries to
  make the winning controller shorter without breaking the landing.
- **Move the pad** — same agent, resumed. The pad relocates, gravity and wind
  change, and its autopilot is suddenly aiming at bare ground. Press it as many
  times as you like: the scenarios cycle, so each press is a different pad, a
  different launch point, and a different sky.

Typical run is 30–60 s per act.

The HUD under the title always shows the pad position, gravity, and wind, so
"the world changed" is visible rather than asserted. The lower right panel shows
the tool receipt — the exact telemetry string the agent read back from its last
flight, including the descent profile and the simplification verdict.

### Two stages, one agent

Each act runs a small state machine: **solving → optimizing → done**.

Landing gets a generous flight budget because a bad run needs room to recover.
Simplification gets three flights, because it happens *after* the demo has
already succeeded. Shorter only counts if it still lands: a simplification that
crashes, that grows the file, or that resubmits the same source is refused and
the previous winner stays on disk. `fixtures/lander/controller.js` always holds
the shortest controller that actually landed.

## Verify before you demo

```bash
npm run world-check    # no API key needed: is the world failable and winnable?
npm run render-check   # no API key needed: does the browser renderer behave?
npm run probe-hands    # full two-act rehearsal against the real agent
```

`world-check` is the one to run first. It asserts that the stock autopilot
fails, that a hand-written one can land, that every moved-pad preset starts well
clear of the pad and is still winnable, that a stale controller misses each of
them, that the simplification rule never accepts a controller that fails, and
that an infinite loop or a malformed return is rejected rather than absorbed. It
needs no API key.

`render-check` covers the other half — the browser renderer, which has no type
checking and used to be verified only by eye. It serves the real `public/`
assets on a throwaway port and drives `app.js` with a synthetic NDJSON stream:
the happy path asserts the code panel and receipt update, the trail stays neutral
(yellow) in flight and only resolves green/red at touchdown, and the scene queue
never cuts a flight short; the malformed path feeds a receipt-less `attempt_flown`
(the stale-server shape) and asserts the frame is dropped, the loud on-canvas
banner appears, the next good frame still renders, and the banner clears. It needs
no API key but does launch headless Chrome — it prefers the system browser and
honours `PLAYWRIGHT_CHROMIUM_PATH` if the bundled one is the wrong arch.

`probe-hands` is the go/no-go gate. If it prints `NO-GO`, the agent never called
the tool and no amount of UI work will save the demo. It now rehearses three
acts — launch plus two pad moves — so the repeated `Agent.resume` path is
covered. That is roughly 2–4 minutes of real model time, so run it once before a
demo rather than on every edit.

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
