const STATES = new Set(['waiting-for-reply', 'reply-detected', 'authorized', 'resuming', 'stale']);

export function resolveAutopilotTaskSurface({ taskStatus = null, watchStatus = null } = {}) {
  const userAction = watchStatus?.userAction;
  const taskId = typeof userAction?.taskId === 'string' ? userAction.taskId.trim() : '';
  const isFreshUserAction = watchStatus?.status === 'healthy'
    && watchStatus.stale !== true
    && Boolean(taskId)
    && STATES.has(userAction.state);

  if (!isFreshUserAction) return { kind: 'task-status', taskStatus };

  const sameTask = taskStatus?.taskId === taskId;
  if (sameTask && (taskStatus.status !== 'blocked' || taskStatus.latestVerdict !== 'USER_ACTION_REQUIRED')) {
    return {
      kind: 'conflict',
      taskId,
      userAction,
      taskStatus,
      reason: 'USER_ACTION_TASK_STATUS_CONFLICT',
      visible: false,
      canCheck: false,
      canResume: false,
    };
  }

  return {
    kind: 'user-action',
    taskId,
    userAction,
    matchingTaskStatus: sameTask ? taskStatus : null,
  };
}

export function autopilotTaskSurfaceViewModel({ taskStatus = null, watchStatus = null } = {}) {
  const surface = resolveAutopilotTaskSurface({ taskStatus, watchStatus });
  if (surface.kind !== 'user-action') return surface;
  return {
    ...surface,
    ...userActionViewModel(surface.userAction),
  };
}

export function autopilotUserActionViewModel(snapshot, watchStatus) {
  const surface = resolveAutopilotTaskSurface({ taskStatus: snapshot, watchStatus });
  if (surface.kind !== 'user-action') {
    return {
      visible: false,
      taskId: surface.taskId || null,
      conflict: surface.kind === 'conflict',
      reason: surface.reason || null,
      canCheck: false,
      canResume: false,
    };
  }
  return userActionViewModel(surface.userAction);
}

function userActionViewModel(source) {
  const taskId = String(source.taskId);
  const state = source.state;
  const userTurnCount = boundedCount(source.userTurnCount);
  const replyTurnCount = boundedCount(source.replyTurnCount);
  const canResume = source.canResume === true && state === 'reply-detected';
  const canCheck = state === 'waiting-for-reply' || state === 'stale';
  return {
    visible: true,
    taskId,
    sourceReviewRound: Number.isSafeInteger(source.sourceReviewRound) ? source.sourceReviewRound : null,
    state,
    userTurnCount,
    replyTurnCount,
    canResume,
    canCheck,
    heading: state === 'reply-detected'
      ? '回答を検出しました'
      : state === 'authorized'
        ? '再開を承認しました'
        : state === 'resuming'
          ? '再開中…'
          : state === 'stale' ? '回答を再確認してください' : '回答待ち',
    detail: state === 'reply-detected'
      ? `ユーザー回答: ${userTurnCount}件。会話の回答を使って同じtaskを次のRoundから再開できます。`
      : state === 'authorized'
        ? 'Watcherが回答と状態を再確認しています…'
        : state === 'resuming'
          ? '同じtaskを次のexecution roundで再開しています。'
          : state === 'stale'
            ? '会話が変わったため、最新の回答を検出してから再度承認してください。'
            : 'ChatGPTで必要事項に回答してください。回答するとここで再開できます。',
    buttonLabel: state === 'waiting-for-reply'
      ? '回答を確認'
      : state === 'stale' ? '回答を再確認' : 'この回答で再開',
  };
}

function boundedCount(value) {
  return Number.isSafeInteger(value) ? Math.max(0, Math.min(64, value)) : 0;
}
