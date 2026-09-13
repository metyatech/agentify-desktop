import { AUTOPILOT_ACTIVITY_STALE_AFTER_MS } from './autopilot-activity-view.mjs';

export function createAutopilotActivityStaleScheduler({ now = () => Date.now(), setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, onStale = () => {} } = {}) {
  let timerId = null;
  let scheduledAt = null;
  let generation = 0;
  const cancel = () => { generation += 1; if (timerId !== null) clearTimeoutImpl(timerId); timerId = null; scheduledAt = null; };
  const schedule = (activity) => {
    const last = Date.parse(activity?.lastActivityAt || '');
    const live = ['starting', 'running'].includes(activity?.processState);
    const staleAt = live ? (Number.isFinite(last) ? last : now()) + AUTOPILOT_ACTIVITY_STALE_AFTER_MS + 1 : null;
    if (staleAt === null || staleAt <= now()) return cancel();
    if (timerId !== null && scheduledAt === staleAt) return;
    cancel();
    const scheduledGeneration = generation;
    scheduledAt = staleAt;
    timerId = setTimeoutImpl(() => { if (scheduledGeneration !== generation) return; timerId = null; scheduledAt = null; onStale(); }, Math.max(1, staleAt - now()));
  };
  return { schedule, cancel };
}
