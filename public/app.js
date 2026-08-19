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
  world: { padX: 0, name: "calm" },
  ghosts: [],
  current: null,
  head: 0,
  holdUntil: 0,
  lastSource: "",
  running: false,
};

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

function pathColor(traj, alpha) {
  const kind = traj.telemetry.outcome.kind;
  if (kind === "landed") return `rgba(74,222,128,${alpha})`;
  if (kind === "stranded") return `rgba(250,204,21,${alpha})`;
  return `rgba(248,113,113,${alpha})`;
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

function frame(now) {
  requestAnimationFrame(frame);
  const w = canvas.clientWidth;
  if (!w) return;

  ctx.clearRect(0, 0, w, canvas.clientHeight);
  drawGround();
  drawPad();

  for (const ghost of state.ghosts) {
    strokeTrail(ghost.frames, ghost.frames.length - 1, pathColor(ghost, 0.34), 2);
    drawImpact(ghost, 0.55);
  }

  const cur = state.current;
  if (!cur) return;

  if (now >= state.holdUntil) {
    if (state.head >= cur.frames.length - 1) {
      state.head = 0;
      hideVerdict();
    } else {
      state.head += (1 / 60) * 30 * PLAYBACK;
    }
  }

  const idx = Math.min(Math.floor(state.head), cur.frames.length - 1);
  strokeTrail(cur.frames, idx, pathColor(cur, 0.95), 3);
  drawLander(cur.frames[idx], cur.frames[idx - 1]);

  if (idx >= cur.frames.length - 1 && now >= state.holdUntil - 1) {
    drawImpact(cur, 1);
    if (state.holdUntil <= now) {
      showVerdict(cur);
      state.holdUntil = now + 1500;
    }
  }
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

function play(traj) {
  if (state.current) {
    state.ghosts.push(state.current);
    if (state.ghosts.length > MAX_GHOSTS) state.ghosts.shift();
  }
  state.current = traj;
  state.head = 0;
  state.holdUntil = 0;
  hideVerdict();
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

function apply(event) {
  switch (event.kind) {
    case "hangar_open":
      state.arena = event.arena;
      state.world = event.world;
      state.ghosts = [];
      state.current = null;
      state.lastSource = "";
      renderCode(event.source);
      el.attemptTag.textContent = "stock";
      el.sub.textContent = "Stock autopilot: fixed throttle, no steering.";
      play(event.baseline);
      break;

    case "conditions_changed":
      state.world = event.world;
      // Act one's trails are scored against the old pad; keeping them would
      // paint a green "landing" beside a pad it now misses by 50 m.
      state.ghosts = [];
      state.current = null;
      el.act.textContent = "THE PAD MOVED";
      el.sub.textContent = "Same autopilot, new target. Watch it miss.";
      el.attemptTag.textContent = "stale";
      play(event.baseline);
      break;

    case "thinking":
      el.status.textContent = "agent thinking…";
      break;

    case "attempt_flown":
      el.attemptTag.textContent = `attempt ${event.trajectory.attempt}`;
      el.sub.textContent = event.note || "New autopilot installed.";
      el.status.textContent = `attempt ${event.trajectory.attempt}`;
      renderCode(event.source);
      play(event.trajectory);
      break;

    case "attempt_rejected":
      el.status.textContent = `rejected: ${event.error.slice(0, 60)}`;
      break;

    case "flight_over":
      el.status.textContent = event.landed
        ? `landed in ${event.attempts} attempts`
        : `gave up after ${event.attempts}`;
      break;

    case "failed":
      el.status.textContent = `failed: ${event.message}`;
      break;

    default:
      break;
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
        if (line.trim()) apply(JSON.parse(line));
      }
    }
  } catch (err) {
    el.status.textContent = `error: ${err.message}`;
  } finally {
    state.running = false;
    el.launch.disabled = false;
    el.harden.disabled = endpoint !== "/api/launch";
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
requestAnimationFrame(frame);
