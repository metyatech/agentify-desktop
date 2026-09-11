const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isCodexThreadId(value) {
  return CODEX_THREAD_ID_PATTERN.test(String(value || '').trim());
}
