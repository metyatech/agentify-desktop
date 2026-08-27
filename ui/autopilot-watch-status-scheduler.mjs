import { AUTOPILOT_WATCH_STATUS_STALE_AFTER_MS } from '../autopilot-watch-status.mjs';

export function createAutopilotWatchStatusStaleScheduler({
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  onStale = () => {},
} = {}) {
  let timerId = null;
  let scheduledAt = null;
  let generation = 0;
  const cancel = () => {
    generation += 1;
    if (timerId !== null) clearTimeoutImpl(timerId);
    timerId = null;
    scheduledAt = null;
  };
  const schedule = (snapshot) => {
    const pollMs = Date.parse(snapshot?.lastPollAt || '');
    const staleAt = Number.isFinite(pollMs) ? pollMs + AUTOPILOT_WATCH_STATUS_STALE_AFTER_MS + 1 : null;
    if (snapshot?.stale || staleAt === null || staleAt <= now()) {
      cancel();
      return;
    }
    if (timerId !== null && scheduledAt === staleAt) return;
    cancel();
    const scheduledGeneration = generation;
    scheduledAt = staleAt;
    timerId = setTimeoutImpl(() => {
      if (scheduledGeneration !== generation) return;
      timerId = null;
      scheduledAt = null;
      onStale();
    }, Math.max(1, staleAt - now()));
  };
  return { schedule, cancel };
}
