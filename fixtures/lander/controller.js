export function control(s) {
  const { x, y, vx, vy, fuel, angleDeg } = s;
  const dx = 50 - x;
  let tilt = y > 55 ? 0.22 * dx - 0.58 * vx - 0.07 : y > 14 ? 0.08 * dx - 0.38 * vx - 0.075 : 0.04 * dx - 0.18 * vx - 0.085;
  tilt = Math.max(-1, Math.min(1, tilt));
  const cos = Math.max(0.9, Math.cos((angleDeg * Math.PI) / 180));
  const vyTgt = y > 55 ? -2.55 : y > 18 ? -2.05 : y > 6 ? -1.45 : -1;
  let thrust = (1.62 - (vy - vyTgt) * 2.9) / (5 * cos);
  if (vy < -Math.sqrt(2.4 * Math.max(0.5, y - 1))) thrust = Math.max(thrust, 1 / cos);
  if (y > 72 && Math.abs(dx) < 2.5 && Math.abs(vx) < 0.7 && vy > -2.55) thrust *= 0.64;
  if (y < 11) thrust = Math.max(thrust, (1.62 - (vy + 0.7) * 4.5) / (5 * cos), 0.5 / cos);
  thrust = fuel <= 0 ? 0 : Math.min(1, Math.max(0, thrust));
  return { thrust, tilt };
}
