export const AUTOPILOT_STATUS_STALE_AFTER_MS = 10 * 60 * 1000;

const phaseLabels = {
  preparing: 'Preparing',
  executing: 'Executing',
  verifying: 'Verifying',
  reviewing: 'Reviewing',
  delivering: 'Delivering',
  cleaning: 'Cleaning',
  completed: 'Completed',
  blocked: 'Blocked',
};

export function autopilotStatusViewModel(snapshot, now = Date.now()) {
  if (!snapshot) return { kind: 'empty', label: 'No active Autopilot task', detail: 'Proposal status remains available above. Approve a proposal to start a task.' };
  const updatedMs = Date.parse(snapshot.updatedAt);
  const ageMs = Number.isFinite(updatedMs) ? Math.max(0, now - updatedMs) : Number.POSITIVE_INFINITY;
  const stale = snapshot.status === 'running' && ageMs > AUTOPILOT_STATUS_STALE_AFTER_MS;
  const phase = phaseLabels[snapshot.phase] || 'Working';
  const statusLabel = snapshot.status === 'completed' ? '✓ Completed' : snapshot.status === 'blocked' ? '✕ Blocked' : stale ? '⚠ Stale' : `● ${phase}`;
  const verification = snapshot.verification?.total > 0
    ? `Verification ${snapshot.verification.completed}/${snapshot.verification.total}${snapshot.verification.failed ? ` • ${snapshot.verification.failed} failed` : ''}`
    : null;
  return {
    kind: snapshot.status,
    stale,
    contextLabel: snapshot.status === 'running' ? '現在の実行' : '前回のAutopilot実行',
    canDismiss: snapshot.status === 'completed' || snapshot.status === 'blocked',
    statusLabel,
    taskLabel: snapshot.taskId,
    title: snapshot.title,
    phaseLabel: stale ? `Last phase: ${phase}` : phase,
    roundLabel: `Round ${snapshot.round} / ${snapshot.maxRounds}`,
    targetLabel: snapshot.repository ? `${snapshot.repository} → ${snapshot.targetBranch}` : 'Host / local task',
    verdictLabel: snapshot.latestVerdict ? `Latest review: ${snapshot.latestVerdict}` : null,
    verificationLabel: verification,
    errorCode: snapshot.error?.code || null,
    errorMessage: snapshot.error?.message || null,
    updatedLabel: snapshot.updatedAt ? `Updated ${new Date(snapshot.updatedAt).toLocaleString()}` : null,
  };
}
