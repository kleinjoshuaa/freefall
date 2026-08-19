const canvas = document.getElementById("sky");
const ctx = canvas.getContext("2d");

const el = {
  act: document.getElementById("act"),
  sub: document.getElementById("sub"),
  verdict: document.getElementById("verdict"),
  verdictText: document.getElementById("verdictText"),
  launch: document.getElementById("launch"),
  harden: document.getElementById("harden"),
  status: document.getElementById("status"),
  code: document.getElementById("code"),
  attemptTag: document.getElementById("attemptTag"),
  padChip: document.getElementById("padChip"),
  gravityChip: document.getElementById("gravityChip"),
  windChip: document.getElementById("windChip"),
  phaseChip: document.getElementById("phaseChip"),
  sizeChip: document.getElementById("sizeChip"),
  velChip: document.getElementById("velChip"),
  receipt: document.getElementById("receipt"),
  receiptTag: document.getElementById("receiptTag"),
  receiptOutcome: document.getElementById("receiptOutcome"),
  receiptStats: document.getElementById("receiptStats"),
  receiptProfile: document.getElementById("receiptProfile"),
  receiptOpt: document.getElementById("receiptOpt"),
};

const PLAYBACK = 4;
// Framed to the region flights actually use, not the full out-of-bounds box —
// at world width the action shrank to a third of the screen.
const VIEW_HALF_WIDTH = 78;
const VIEW_CEILING = 100;
const FUEL_BURN_PER_S = 8;
const DT = 1 / 30;
const MAX_GHOSTS = 12;

const state = {
  arena: { halfWidth: 130, ceiling: 300, padHalfWidth: 6, safeDescent: 2.5 },
  world: { padX: 0, name: "calm", gravity: 1.62, wind: 0 },
  ghosts: [],
  current: null,
  head: 0,
  holdUntil: 0,
  lastSource: "",
  running: false,
  opened: false,
  velText: "",
  queue: [],
  fault: null,
};

const LUNAR_G = 1.62;

// Padded to a constant width so the chip does not resize as the lander speeds up.
function showVelocity(f) {
  const pad = (v) => v.toFixed(1).padStart(5);
  const text = f ? `VX ${pad(f.vx)} VY ${pad(f.vy)}` : "VX     — VY     —";
  if (text === state.velText) return;
  state.velText = text;
  el.velChip.textContent = text;
}

function formatSigned(v) {
  const rounded = Math.round(v * 100) / 100;
  return `${rounded >= 0 ? "+" : ""}${rounded}`;
}

function updateWorldHud(world) {
  state.world = world;
  el.padChip.textContent = `PAD x=${world.padX}`;

  const g = world.gravity ?? LUNAR_G;
  el.gravityChip.textContent = `G ${g} m/s²`;
  el.gravityChip.classList.toggle("heavy", g > LUNAR_G + 0.05);
  el.gravityChip.classList.toggle("light", g < LUNAR_G - 0.05);

  const wind = world.wind ?? 0;
  el.windChip.textContent =
    wind === 0 ? "WIND 0 m/s²" : `WIND ${formatSigned(wind)} m/s²`;
  el.windChip.classList.toggle("windy", wind !== 0);
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const { clientWidth: w, clientHeight: h } = canvas;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(resize).observe(canvas);

// World is metres with y up; canvas is pixels with y down.
function project(x, y) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const groundY = h - 110;
  const scale = Math.min(w / (VIEW_HALF_WIDTH * 2), groundY / VIEW_CEILING);
  return [w / 2 + x * scale, groundY - y * scale, scale];
}

function drawGround() {
  const w = canvas.clientWidth;
  const [, gy] = project(0, 0);

  ctx.fillStyle = "rgba(237,236,236,0.05)";
  ctx.fillRect(0, gy, w, canvas.clientHeight - gy);

  ctx.strokeStyle = "rgba(237,236,236,0.28)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, gy);
  ctx.lineTo(w, gy);
  ctx.stroke();
}

function drawPad() {
  const { padX } = state.world;
  const half = state.arena.padHalfWidth;
  const [left, gy, scale] = project(padX - half, 0);
  const [cx] = project(padX, 0);
  const width = half * 2 * scale;
  const beam = gy - 20;

  // A tall soft column so the target is unmissable and misses read as distance.
  const glow = ctx.createLinearGradient(0, 0, 0, gy);
  glow.addColorStop(0, "rgba(245,78,0,0)");
  glow.addColorStop(1, "rgba(245,78,0,0.07)");
  ctx.fillStyle = glow;
  ctx.fillRect(left, 0, width, gy);

  ctx.strokeStyle = "rgba(245,78,0,0.35)";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 10]);
  ctx.beginPath();
  ctx.moveTo(cx, beam);
  ctx.lineTo(cx, 0);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#f54e00";
  ctx.fillRect(left, gy - 6, width, 10);
  for (const side of [-1, 1]) {
    const [px] = project(padX + side * half, 0);
    ctx.fillRect(px - 2, gy - 34, 4, 30);
  }
}

// Only a clean landing is green. Stranded (out of fuel) is deliberately red like
// a crash: yellow now means "still deciding", so a settled trail must read as
// pass or fail, and running dry short of the pad is a failed landing.
function pathColor(traj, alpha) {
  const kind = traj.telemetry.outcome.kind;
  if (kind === "landed") return `rgba(74,222,128,${alpha})`;
  return `rgba(248,113,113,${alpha})`;
}

/**
 * The trajectory already knows how the flight ends, so colouring the live trail
 * by outcome gives the result away while the lander is still in the air. It
 * stays neutral until touchdown resolves it.
 */
function flyingColor(alpha) {
  return `rgba(250,204,21,${alpha})`;
}

function strokeTrail(frames, upto, color, width) {
  if (frames.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  const end = Math.min(upto, frames.length - 1);
  for (let i = 0; i <= end; i += 1) {
    const [px, py] = project(frames[i].x, frames[i].y);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

function drawImpact(traj, alpha = 1) {
  const last = traj.frames[traj.frames.length - 1];
  const [px, py] = project(last.x, last.y);
  const landed = traj.telemetry.outcome.kind === "landed";

  if (landed) {
    ctx.strokeStyle = `rgba(74,222,128,${alpha})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(px, py, 14, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }

  ctx.strokeStyle = `rgba(248,113,113,${alpha})`;
  ctx.lineWidth = 3;
  for (let i = 0; i < 6; i += 1) {
    const a = (Math.PI * 2 * i) / 6 - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(a) * 15, py + Math.sin(a) * 15 * 0.6);
    ctx.stroke();
  }
}

function drawLander(frame, prev) {
  const [px, py, scale] = project(frame.x, frame.y);
  const size = Math.max(20, scale * 4.5);

  const burn = prev
    ? Math.max(0, (prev.fuel - frame.fuel) / (FUEL_BURN_PER_S * DT))
    : 0;

  ctx.save();
  ctx.translate(px, py);
  ctx.rotate((frame.angleDeg * Math.PI) / 180);

  if (burn > 0.02) {
    const flame = size * (0.8 + burn * 2.4);
    const grad = ctx.createLinearGradient(0, size * 0.5, 0, size * 0.5 + flame);
    grad.addColorStop(0, "rgba(245,78,0,0.95)");
    grad.addColorStop(1, "rgba(245,78,0,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-size * 0.42, size * 0.5);
    ctx.lineTo(size * 0.42, size * 0.5);
    ctx.lineTo(0, size * 0.5 + flame);
    ctx.closePath();
    ctx.fill();
  }

  ctx.fillStyle = "#edecec";
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.8);
  ctx.lineTo(size * 0.62, size * 0.5);
  ctx.lineTo(-size * 0.62, size * 0.5);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

/**
 * A dropped event usually means the server is older than the page, which a
 * 12px status line loses in a room. This paints the reason across the stage so
 * a presenter reads "restart the server", not "the agent is failing". The flight
 * keeps replaying underneath so the demo is never a blank screen.
 */
function drawFault(w, h) {
  const band = 96;
  const top = h * 0.5 - band / 2;

  ctx.fillStyle = "rgba(20,18,11,0.86)";
  ctx.fillRect(0, top, w, band);
  ctx.fillStyle = "#f54e00";
  ctx.fillRect(0, top, w, 4);
  ctx.fillRect(0, top + band - 4, w, 4);

  ctx.textAlign = "center";
  ctx.fillStyle = "#f54e00";
  ctx.font = "700 26px ui-monospace, SFMono-Regular, Menlo, monospace";
  const drops = state.fault.drops > 1 ? ` ×${state.fault.drops}` : "";
  ctx.fillText(`RENDERER DROPPED AN EVENT${drops}`, w / 2, top + 38);

  ctx.fillStyle = "#edecec";
  ctx.font = "400 15px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillText(state.fault.text, w / 2, top + 66);
  ctx.textAlign = "start";
}

function renderScene(now) {
  const cur = state.current;
  if (!cur) {
    showVelocity(null);
    return;
  }

  if (now >= state.holdUntil) {
    if (state.head >= cur.frames.length - 1) {
      if (state.queue.length) {
        advanceScene();
        return;
      }
      state.head = 0;
      hideVerdict();
    } else {
      state.head += (1 / 60) * 30 * PLAYBACK;
    }
  }

  const idx = Math.min(Math.floor(state.head), cur.frames.length - 1);
  const down = idx >= cur.frames.length - 1;
  strokeTrail(cur.frames, idx, down ? pathColor(cur, 0.95) : flyingColor(0.95), 3);
  drawLander(cur.frames[idx], cur.frames[idx - 1]);
  showVelocity(cur.frames[idx]);

  if (idx >= cur.frames.length - 1 && now >= state.holdUntil - 1) {
    drawImpact(cur, 1);
    if (state.holdUntil <= now) {
      showVerdict(cur);
      state.holdUntil = now + 1500;
    }
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w) return;

  ctx.clearRect(0, 0, w, h);
  drawGround();
  drawPad();

  for (const ghost of state.ghosts) {
    strokeTrail(ghost.frames, ghost.frames.length - 1, pathColor(ghost, 0.34), 2);
    drawImpact(ghost, 0.55);
  }

  renderScene(now);

  // Drawn last so it sits above the replay: a dropped event must not be hidden
  // behind the stock arc still looping underneath it.
  if (state.fault) drawFault(w, h);
}

function showVerdict(traj) {
  const { outcome } = traj.telemetry;
  const good = outcome.kind === "landed";
  el.verdict.hidden = false;
  el.verdict.className = `verdict ${good ? "good" : "bad"}`;
  el.verdictText.textContent = good
    ? `LANDED  ${outcome.score}`
    : outcome.kind === "stranded"
      ? "OUT OF FUEL"
      : `MISS ${Math.abs(traj.telemetry.missDistance)}m`;
}

function hideVerdict() {
  el.verdict.hidden = true;
}

/**
 * A finished replay loops while the agent thinks, so when the next event lands
 * the lander is usually mid-air. Swapping trajectories at that moment cuts the
 * flight off before it touches down, so scenes wait for the running replay to
 * reach its verdict. Each scene carries its own panel updates and applies them
 * as its flight starts, which is what keeps the code and telemetry describing
 * the flight currently on screen rather than one still queued behind it.
 */
function enqueue(trajectory, present) {
  state.queue.push({ trajectory, present });
  if (!state.current) advanceScene();
}

function advanceScene() {
  while (state.queue.length) {
    const scene = state.queue.shift();
    scene.present();
    if (!scene.trajectory) continue;
    if (state.current) {
      state.ghosts.push(state.current);
      if (state.ghosts.length > MAX_GHOSTS) state.ghosts.shift();
    }
    state.current = scene.trajectory;
    state.head = 0;
    state.holdUntil = 0;
    hideVerdict();
    return;
  }
}

/** Act boundaries are the one case that preempts: the old world is gone. */
function cutTo(trajectory, present) {
  state.queue.length = 0;
  state.ghosts = [];
  state.current = null;
  enqueue(trajectory, present);
}

const PHASE_LABEL = {
  solving: "SOLVING",
  optimizing: "SIMPLIFYING",
  done: "DONE",
};

function showPhase(phase, best) {
  el.phaseChip.hidden = false;
  el.phaseChip.textContent = PHASE_LABEL[phase] ?? phase.toUpperCase();
  el.phaseChip.classList.toggle("simplifying", phase !== "solving");
  el.sizeChip.hidden = !best;
  if (best) el.sizeChip.textContent = `BEST ${best.bytes} B`;
}

function stat(key, value) {
  const wrap = document.createElement("div");
  const k = document.createElement("span");
  k.className = "k";
  k.textContent = key;
  const v = document.createElement("span");
  v.className = "v";
  v.textContent = value;
  wrap.append(k, v);
  return wrap;
}

const OPT_TEXT = {
  accepted: "shorter and it still lands.",
  failed: "shorter but it crashed. Best kept.",
  identical: "identical source, nothing simplified.",
  not_shorter: "it lands but is no shorter.",
  rejected: "it would not run. Best kept.",
};

/**
 * One element per field so the columns line up down the list. A run of
 * `t=0 y=92 vy=-2` set as one string is unreadable at panel width, and the
 * grid needs its own cell to align.
 */
function profileRow(cells, className) {
  const row = document.createElement("div");
  row.className = className;
  row.style.setProperty("--cols", String(cells.length));
  for (const text of cells) {
    const cell = document.createElement("span");
    cell.textContent = text;
    row.append(cell);
  }
  return row;
}

/**
 * Renders the tool's return value, not a prettier version of it. Every field
 * here came off the wire in the receipt, so the panel and the model are reading
 * the same thing.
 */
function renderReceipt(receipt, telemetry) {
  el.receipt.title = receipt.text;
  el.receiptTag.textContent = `attempt ${receipt.attempt} · ${PHASE_LABEL[receipt.phase] ?? receipt.phase}`;

  const kind = telemetry ? telemetry.outcome.kind : "rejected";
  el.receiptOutcome.textContent = receipt.outcomeLine;
  el.receiptOutcome.className = `outcome ${
    kind === "landed" ? "good" : kind === "stranded" ? "warn" : "bad"
  }`;

  el.receiptStats.replaceChildren();
  if (telemetry) {
    el.receiptStats.append(
      stat("miss", `${telemetry.missDistance} m`),
      stat("impact", `${telemetry.impactSpeed} m/s`),
      stat("tilt", `${telemetry.tiltDeg}°`),
      stat("fuel left", `${telemetry.fuelLeft}`),
      stat("duration", `${telemetry.durationS} s`),
    );
  }

  el.receiptProfile.replaceChildren();
  let heading = "";
  for (const waypoint of receipt.profile.split("|")) {
    const fields = waypoint
      .trim()
      .split(/\s+/)
      .map((field) => field.split("="))
      .filter(([, value]) => value !== undefined);
    if (fields.length === 0) continue;
    const names = fields.map(([name]) => name);
    // Re-heads the table if the tool ever reorders or renames its fields, so a
    // column can never sit under the wrong name.
    if (names.join(" ") !== heading) {
      heading = names.join(" ");
      el.receiptProfile.append(profileRow(names, "wp head"));
    }
    el.receiptProfile.append(profileRow(fields.map(([, value]) => value), "wp"));
  }

  const opt = receipt.optimization;
  el.receiptOpt.hidden = !opt;
  if (!opt) {
    // Cleared rather than only hidden. A stale verdict left in the DOM would
    // reappear under the next receipt that does carry one.
    el.receiptOpt.replaceChildren();
  } else {
    const accepted = opt.result === "accepted";
    el.receiptOpt.className = `opt ${accepted ? "accepted" : "declined"}`;
    const word = document.createElement("span");
    word.className = "word";
    word.textContent = accepted ? "ACCEPTED" : "DECLINED";
    const sizes = document.createElement("span");
    sizes.className = "sizes";
    sizes.textContent =
      `candidate ${opt.candidate.bytes} B / ${opt.candidate.lines} lines` +
      ` vs best ${opt.best.bytes} B / ${opt.best.lines} lines` +
      ` · ${opt.attemptsRemaining} simplification flights left`;
    el.receiptOpt.replaceChildren(
      word,
      document.createTextNode(` ${OPT_TEXT[opt.result] ?? opt.result}`),
      sizes,
    );
  }

  showPhase(receipt.phase, receipt.best);
}

function renderCode(source) {
  const previous = new Set(state.lastSource.split("\n").map((l) => l.trim()));
  el.code.innerHTML = "";
  for (const line of source.split("\n")) {
    const div = document.createElement("div");
    div.textContent = line || " ";
    if (state.lastSource && line.trim() && !previous.has(line.trim())) {
      div.className = "hot";
    }
    el.code.appendChild(div);
  }
  state.lastSource = source;
}

/**
 * The dev server compiles src/** once at boot, so a server started before the
 * receipt fields existed still streams the old event shape to a freshly loaded
 * page. Saying so here turns a TypeError deep in the renderer into one line a
 * presenter can act on.
 */
function requireReceipt(event) {
  if (event.receipt) return event.receipt;
  throw new Error(
    `${event.kind} carried no receipt — the server is running older code than this page; restart it`,
  );
}

function apply(event) {
  switch (event.kind) {
    case "hangar_open":
      state.arena = event.arena;
      state.opened = true;
      state.lastSource = "";
      cutTo(event.baseline, () => {
        updateWorldHud(event.world);
        renderCode(event.source);
        el.attemptTag.textContent = "stock";
        el.sub.textContent = "Stock autopilot: fixed throttle, no steering.";
        showPhase("solving", null);
      });
      break;

    case "conditions_changed":
      // Previous trails are scored against the old pad; keeping them would
      // paint a green "landing" beside a pad it now misses by 40 m.
      cutTo(event.baseline, () => {
        updateWorldHud(event.world);
        el.act.textContent = "MOVED";
        el.sub.textContent = `Move ${event.move}: new pad, gravity, and wind. Watch the stale autopilot miss.`;
        el.attemptTag.textContent = "stale";
        showPhase("solving", null);
      });
      break;

    case "thinking":
      el.status.textContent = "agent thinking…";
      break;

    case "attempt_flown": {
      const receipt = requireReceipt(event);
      const opt = receipt.optimization;
      const declined = opt !== null && opt.result !== "accepted";
      enqueue(event.trajectory, () => {
        el.attemptTag.textContent = `attempt ${receipt.attempt}`;
        el.status.textContent =
          receipt.phase === "solving"
            ? `attempt ${receipt.attempt}`
            : `simplifying · attempt ${receipt.attempt}`;
        el.sub.textContent =
          opt === null && receipt.phase !== "solving"
            ? "Landed. Now simplifying the controller."
            : event.note || "New autopilot installed.";
        // The panel is labelled with the file path, so it must show the installed
        // controller — a declined simplification never reaches disk.
        renderCode(declined ? opt.bestSource : event.source);
        renderReceipt(receipt, event.trajectory.telemetry);
      });
      break;
    }

    case "attempt_rejected": {
      const receipt = requireReceipt(event);
      enqueue(null, () => {
        el.status.textContent = `rejected: ${event.error.slice(0, 60)}`;
        renderReceipt(receipt, null);
      });
      break;
    }

    case "flight_over":
      enqueue(null, () => {
        showPhase(event.phase, event.best);
        el.status.textContent = event.landed
          ? `landed · ${event.attempts} flights${event.best ? ` · ${event.best.bytes} B` : ""}`
          : `gave up after ${event.attempts}`;
      });
      break;

    case "failed":
      el.status.textContent = `failed: ${event.message}`;
      break;

    default:
      break;
  }
}

function raiseFault(text) {
  state.fault = { text, drops: (state.fault?.drops ?? 0) + 1 };
  el.status.textContent = `dropped an event: ${text.slice(0, 90)}`;
}

// A shape-bearing event that renders proves server and page agree, so any
// standing fault was stale; lighter events (thinking, flight_over) can't clear
// it because they parse even against an older server.
const SHAPE_BEARING = new Set([
  "hangar_open",
  "conditions_changed",
  "attempt_flown",
]);

/**
 * This runs in front of a room, so a frame the renderer cannot handle is dropped
 * and named rather than allowed to abort the read and end the flight.
 */
function applyLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch (err) {
    console.error("freefall: unparseable event", err, line);
    raiseFault(`unparseable event — ${err.message}`);
    return;
  }
  try {
    apply(event);
    if (SHAPE_BEARING.has(event.kind)) state.fault = null;
  } catch (err) {
    console.error("freefall: dropped an event", err, line);
    raiseFault(`${event.kind}: ${err.message}`);
  }
}

async function drive(endpoint) {
  if (state.running) return;
  state.running = true;
  el.launch.disabled = true;
  el.harden.disabled = true;

  try {
    const res = await fetch(endpoint, { method: "POST" });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) applyLine(line);
      }
    }
  } catch (err) {
    el.status.textContent = `error: ${err.message}`;
  } finally {
    state.running = false;
    el.launch.disabled = false;
    // The pad can move again and again: each press resumes the same agent
    // against the next scenario in the cycle.
    el.harden.disabled = !state.opened;
  }
}

el.launch.addEventListener("click", () => {
  el.act.textContent = "FREEFALL";
  el.status.textContent = "waking the agent…";
  drive("/api/launch");
});
el.harden.addEventListener("click", () => {
  el.status.textContent = "moving the pad…";
  drive("/api/harden");
});

resize();
updateWorldHud(state.world);
requestAnimationFrame(frame);
