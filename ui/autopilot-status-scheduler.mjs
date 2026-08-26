import { AUTOPILOT_STATUS_STALE_AFTER_MS } from './autopilot-status-view.mjs';

export function createAutopilotStatusStaleScheduler({
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
    const staleAt = staleBoundary(snapshot);
    if (staleAt === null || staleAt <= now()) {
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

function staleBoundary(snapshot) {
  if (!snapshot || snapshot.status !== 'running') return null;
  const updatedAt = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(updatedAt)) return null;
  // The view model uses age > threshold, so schedule just after equality.
  return updatedAt + AUTOPILOT_STATUS_STALE_AFTER_MS + 1;
}
