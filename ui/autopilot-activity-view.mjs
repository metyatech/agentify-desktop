export const AUTOPILOT_ACTIVITY_STALE_AFTER_MS = 15_000;

export function autopilotActivityViewModel(activity, now = Date.now()) {
  if (!activity) return { kind: 'empty', statusLabel: 'Codex activity unavailable', events: [], expanded: false };
  const storedProcessState = activity.processState || 'unknown';
  const lastActivityMs = Date.parse(activity.lastActivityAt || '');
  const heartbeatStale = storedProcessState === 'running' && (!Number.isFinite(lastActivityMs) || now - lastActivityMs > AUTOPILOT_ACTIVITY_STALE_AFTER_MS);
  const processState = heartbeatStale ? 'unknown' : (activity.effectiveProcessState || storedProcessState);
  const kind = processState === 'running' || processState === 'starting' ? processState : processState;
  const statusLabel = processState === 'running'
    ? '● Running'
    : processState === 'starting'
      ? '● Starting'
      : processState === 'exited'
        ? '○ Exited'
        : processState === 'failed'
          ? '✕ Failed'
          : '⚠ Activity heartbeat stale';
  const started = Date.parse(activity.startedAt || '');
  const finished = Date.parse(activity.finishedAt || '');
  const elapsedMs = Number.isFinite(started) ? Math.max(0, (Number.isFinite(finished) ? finished : now) - started) : null;
  return {
    kind,
    statusLabel,
    elapsedLabel: elapsedMs === null ? null : `Elapsed ${formatDuration(elapsedMs)}`,
    pidLabel: Number.isInteger(activity.pid) ? `PID ${activity.pid}` : null,
    lastActivityLabel: relativeLabel('Last activity', activity.lastActivityAt, now),
    lastOutputLabel: relativeLabel('Last output', activity.lastOutputAt, now),
    events: Array.isArray(activity.events) ? activity.events : [],
    expanded: processState === 'running' || processState === 'starting',
    activityStale: heartbeatStale || activity.activityStale === true || processState === 'unknown',
  };
}

function relativeLabel(prefix, value, now) {
  const at = Date.parse(value || '');
  if (!Number.isFinite(at)) return `${prefix} —`;
  return `${prefix} ${formatAge(Math.max(0, now - at))} ago`;
}

function formatAge(ms) {
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
