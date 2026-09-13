const STATES = new Set(['waiting-for-reply', 'reply-detected', 'authorized', 'resuming', 'stale']);

export function autopilotUserActionViewModel(snapshot, watchStatus) {
  if (!snapshot || snapshot.status !== 'blocked' || snapshot.latestVerdict !== 'USER_ACTION_REQUIRED') {
    return { visible: false };
  }
  const taskId = String(snapshot.taskId || '');
  const source = watchStatus?.userAction?.taskId === taskId ? watchStatus.userAction : null;
  const state = STATES.has(source?.state) ? source.state : 'waiting-for-reply';
  const userTurnCount = boundedCount(source?.userTurnCount);
  const replyTurnCount = boundedCount(source?.replyTurnCount);
  const canResume = source?.canResume === true && state === 'reply-detected';
  const canCheck = state === 'waiting-for-reply' || state === 'stale';
  return {
    visible: true,
    taskId,
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
