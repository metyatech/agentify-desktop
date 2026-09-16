export const AUTOPILOT_WATCHER_HEALTH_INTERVAL_MS = 2_000;
export const AUTOPILOT_WATCHER_RETRY_BACKOFF_MS = 5_000;

const watcherStateKey = (state) => JSON.stringify({
  status: state?.status || null,
  pid: Number.isInteger(state?.pid) ? state.pid : null,
  detail: typeof state?.detail === 'string' ? state.detail : null,
});

function canAutoStart(state) {
  if (state?.status !== 'offline') return false;
  return !['Watcher is disabled.', 'Watcher is not configured.'].includes(state.detail);
}

export function createAutopilotWatcherSupervisor({
  watcher,
  onStateChanged = () => {},
  intervalMs = AUTOPILOT_WATCHER_HEALTH_INTERVAL_MS,
  retryBackoffMs = AUTOPILOT_WATCHER_RETRY_BACKOFF_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  now = () => Date.now(),
} = {}) {
  if (!watcher || typeof watcher.getState !== 'function' || typeof watcher.start !== 'function')
    throw new TypeError('watcher supervisor requires a watcher manager');

  let timer = null;
  let stopped = true;
  let healthCheckInFlight = null;
  let retryNotBefore = 0;
  let lastStateKey = null;

  const publish = (state) => {
    const nextKey = watcherStateKey(state);
    if (nextKey === lastStateKey) return;
    lastStateKey = nextKey;
    try {
      onStateChanged(state);
    } catch {}
  };

  const inspectNow = () => {
    if (healthCheckInFlight) return healthCheckInFlight;
    healthCheckInFlight = (async () => {
      const before = await watcher.getState();
      const currentTime = now();
      if (before?.status === 'running') retryNotBefore = 0;
      if (before?.status === 'offline' && currentTime < retryNotBefore) {
        const waiting = { status: 'error', detail: 'Watcher restart is waiting for the retry backoff.' };
        publish(waiting);
        return waiting;
      }
      let after = before;
      publish(before);
      if (!stopped && canAutoStart(before)) {
        publish({ status: 'starting', detail: 'Watcher is starting.' });
        after = await watcher.start();
        if (after?.status === 'error') retryNotBefore = now() + Math.max(0, retryBackoffMs);
        else retryNotBefore = 0;
      }
      publish(after);
      return after;
    })().finally(() => {
      healthCheckInFlight = null;
    });
    return healthCheckInFlight;
  };

  const start = async () => {
    if (!stopped) return await inspectNow();
    stopped = false;
    if (timer === null) timer = setIntervalImpl(() => { void inspectNow().catch(() => {}); }, Math.max(1, intervalMs));
    return await inspectNow();
  };

  const stop = () => {
    stopped = true;
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
  };

  return { start, stop, inspectNow, isRunning: () => !stopped };
}
