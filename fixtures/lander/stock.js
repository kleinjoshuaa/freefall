// Stock autopilot. Holds a fixed throttle and never steers.
// Pristine reference: the live controller is reset from this on every launch.
export function control(s) {
  return { thrust: 0.2, tilt: 0 };
}
