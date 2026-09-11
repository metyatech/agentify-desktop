import { execFile } from 'node:child_process';
import { isCodexThreadId } from './codex-identity.mjs';

export { isCodexThreadId } from './codex-identity.mjs';

export async function detectCodexDeepLink({ platform = process.platform, execFileImpl = execFile } = {}) {
  if (platform !== 'win32') return false;
  return await new Promise((resolve) => {
    execFileImpl('reg.exe', ['query', 'HKCR\\codex\\shell\\open\\command'], { windowsHide: true }, (error, stdout) => {
      resolve(!error && /codex|openai/iu.test(String(stdout || '')));
    });
  });
}
