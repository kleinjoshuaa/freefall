# Freefall — talk track

Three minutes. Two buttons. Do not read code aloud; the screen does that.

Before you start: `npm run world-check` and `npm run probe-hands`. If the probe
prints `NO-GO`, do not give the talk.

---

## 0:00 — The setup (before you click anything)

> This is a lunar lander. That orange strip is the pad. The autopilot flying it
> is fifteen lines of JavaScript in a real file on disk, and right now it holds a
> fixed throttle and never steers.
>
> I'm not going to write the autopilot. An agent is.

Click **Launch**.

The stock trajectory plays immediately: the lander sails across the screen and
smashes into the ground well right of the pad. You have a failure on screen
within two seconds of the click.

## 0:10 — While the agent thinks

The trajectory loops. Let it.

> Notice there's no spinner. While the model is working, you're watching the
> autopilot it hasn't fixed yet, still failing. That's not filler — that's the
> problem statement staying on screen.

This is the moment to explain the loop, because you have 10–15 seconds of honest
dead time and something is moving.

> The agent has exactly one tool. It's called `fly`, it takes a source string,
> and it runs in my process. It writes the file, simulates the flight, and hands
> back telemetry — where it hit, how fast, how much fuel was left, and a profile
> of the whole descent.
>
> So the agent isn't guessing. It sees its own code fail and revises.

## 0:25 — First attempts land on screen

Each attempt draws a new bright arc; the old one fades to a ghost.

> Every red arc is a controller it wrote and rejected. Watch them converge.

Point at the caption under the title — it's the agent's own six-word summary of
what it changed. Read one aloud; they're usually good. ("Fix vy sign
convention." "Brake vx harder.")

Point at the right panel once:

> That's the actual file being rewritten, with the changed lines marked. And
> that's the entire SDK surface underneath it — create an agent, send, stream,
> wait. That's the whole integration.

## 0:45–1:15 — The landing

The winning arc turns green and **LANDED** punches up in the middle of the
screen with a score.

> Three attempts. Nobody told it what was wrong — it read the telemetry.

Pause here. Let the fan of red arcs with one green line through it sit on screen.
That image is the demo.

## 1:20 — The second act

> Now the requirement changes.

Click **Move the pad**.

The pad jumps to the right and the unchanged autopilot flies its old, perfect,
gentle approach — and sets down fifty metres from where it now needs to be.

> That's the same agent. Same conversation. `Agent.resume` picks the thread back
> up, so it still has everything it learned in the first act. It isn't starting
> over; it's editing code it remembers writing.

Let it iterate. Second act usually takes 3–7 attempts.

## 2:15 — Close

> Two things I'd take away from this.
>
> First, the agent's only output channel was a tool. It couldn't talk its way to
> a result — narration is thrown away before it reaches the screen. If you want
> an agent to *do* something rather than describe it, give it hands and take
> away its mouth.
>
> Second, the interesting part isn't that it wrote code. It's that it wrote
> code, watched it fail against a real system, and fixed it — three times, in
> ninety seconds, without a human in the loop.

---

## If it doesn't land

It usually lands in 2–4 attempts, but it is a live model and it can flail.

- **It's on attempt 6 and still crashing** — say so. "This is a real run; it's
  having a bad one." Then point at the arcs: they're still converging. The
  convergence is the story even when the landing doesn't arrive.
- **An attempt is rejected** — that's the compile gate catching malformed code.
  The previous autopilot stays installed and it keeps flying. Worth calling out:
  "bad output can't blank the screen."
- **Ten attempts, no landing** — click **Move the pad** anyway. The second act
  starts from whatever it had and often goes better.

## Questions you will get

**"Did it really write the file?"** Yes — `fixtures/lander/controller.js`, open
it after. The tool persists the source only after it runs clean, so the file on
disk is always something that actually flew.

**"Why one tool?"** Round trips are the budget. One tool call equals one visible
flight, which is the tightest feedback loop available in a three-minute demo.

**"Could it use the editor instead of a custom tool?"** Yes, and for real work it
should. Here the custom tool buys determinism and a single round trip per
attempt, and it demonstrates that tools execute in *your* process against
*your* state.

**"Is the physics rigged?"** `npm run world-check` proves the stock autopilot
fails and a hand-written one lands, in both acts. Run it in front of them.
