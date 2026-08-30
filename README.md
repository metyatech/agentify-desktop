# Agentify Desktop

Agentify Desktop is a local control center for AI web sessions. It lets MCP-capable tools such as Codex, Claude Code, and OpenCode use the AI subscriptions you are already signed into, while keeping browser state, files, and automation on your machine.

## What It Does

- Opens a local Agentify Control Center.
- Manages signed-in browser sessions for ChatGPT, Claude, Perplexity, Gemini, Google AI Studio, and Grok.
- Exposes MCP tools for querying a tab, reading a page, navigating, uploading files, saving artifacts, and reusing stable tab keys.
- Supports parallel tabs so different agents or tasks can use separate sessions.
- Packs local repo/file context into prompts when requested.
- Saves generated images/files locally so they can be reused in follow-up prompts.

## Example Prompts After MCP Setup

Once Agentify Desktop is running and registered with your MCP client, you can ask for workflows like:

- “Use Agentify with key `repo-triage` to ask ChatGPT for a second opinion on this bug, then compare its answer with your own analysis.”
- “Open a Perplexity tab with key `research-auth-flow` and research current OAuth best practices for desktop apps.”
- “Send this implementation plan to Claude in a separate Agentify tab and summarize any risks it finds.”
- “Use Agentify to generate three UI concept images, save the images as artifacts, and return the local file paths.”
- “Open Grok and ChatGPT in separate Agentify tabs, ask both to review this API design, then compare the tradeoffs.”
- “Pack this repo into context, ask ChatGPT to identify risky files, and save the conversation under a stable tab key for follow-ups.”
- “Read the current ChatGPT page through Agentify and turn the conversation into actionable TODOs.”

## Requirements

- Node.js 20 or newer
- An MCP-capable CLI if you want tool integration: Codex, Claude Code, or OpenCode

## Supported Sites

- `chatgpt.com`
- `claude.ai`
- `perplexity.ai`
- `aistudio.google.com`
- `gemini.google.com`
- `grok.com`

## Preferred Install And Run

Start the desktop GUI without cloning this repo:

```bash
npx @agentify/desktop
```

Equivalent explicit GUI command:

```bash
npx @agentify/desktop gui
```

If you prefer a global install:

```bash
npm install -g @agentify/desktop
agentify-desktop
```

If you want the older repo-clone and local source workflow, use [DEVELOPMENT_FROM_SOURCE.md](DEVELOPMENT_FROM_SOURCE.md).

## MCP Server

Run the MCP server over stdio:

```bash
npx @agentify/desktop mcp
```

Show newly-created browser tabs while debugging:

```bash
npx @agentify/desktop mcp --show-tabs
```

With a global install:

```bash
agentify-desktop-mcp
agentify-desktop-mcp --show-tabs
```

## Register With MCP Clients

Codex:

```bash
codex mcp add agentify-desktop -- npx -y @agentify/desktop mcp
```

Claude Code:

```bash
claude mcp add --transport stdio agentify-desktop -- npx -y @agentify/desktop mcp
```

OpenCode config example:

```json
{
  "mcp": {
    "agentify-desktop": {
      "type": "local",
      "command": ["npx", "-y", "@agentify/desktop", "mcp"],
      "enabled": true
    }
  }
}
```

Use `--show-tabs` at the end of the command while debugging:

```bash
codex mcp add agentify-desktop -- npx -y @agentify/desktop mcp --show-tabs
```

## First Run

1. Start the app:

```bash
npx @agentify/desktop
```

2. In the Control Center, create or show a ChatGPT tab.

3. Sign in to the target vendor in the browser window.

4. Register the MCP server with your CLI.

5. Ask your MCP client to use Agentify:

```text
Use Agentify Desktop with tab key repo-triage.
Ask ChatGPT to summarize this repo in 8 bullets and list the top 3 risky areas to change first.
Return the answer and keep the tab key stable for follow-ups.
```

The core loop is:

- keep a real signed-in browser session open locally
- call it from an MCP client
- reuse a stable tab key across follow-up prompts

## Useful MCP Tools

The MCP server registers `agentify_*` tools, including:

- `agentify_query`: send a prompt to a stable tab and return the assistant response.
- `agentify_read_page`: read visible page text from a tab.
- `agentify_navigate`: navigate a tab to a URL.
- `agentify_ensure_ready`: wait for login, CAPTCHA, or UI readiness.
- `agentify_show` / `agentify_hide`: bring windows forward or minimize them.
- `agentify_status`: inspect tab and readiness state.
- `agentify_tabs`, `agentify_tab_create`, `agentify_tab_close`: manage tabs.
- `agentify_save_artifacts`, `agentify_list_artifacts`, `agentify_open_artifacts_folder`: manage generated files/images.
- `agentify_save_bundle`, `agentify_list_bundles`: save and reuse context bundles.
- `agentify_add_watch_folder`, `agentify_list_watch_folders`, `agentify_remove_watch_folder`: manage watched folders.

## Artifact Workflow

Generate an image or file in a stable tab:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "ui-concepts",
    "prompt": "Generate 3 clean UI concept images for a compact desktop developer tool. Keep backgrounds neutral and avoid text."
  }
}
```

Save the generated images locally:

```json
{
  "tool": "agentify_save_artifacts",
  "arguments": {
    "key": "ui-concepts",
    "mode": "images",
    "maxImages": 3
  }
}
```

Reattach one of the returned file paths in a follow-up:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "ui-concepts",
    "prompt": "Use the attached concept image and create a more minimal variant with stronger contrast.",
    "attachments": ["/absolute/path/to/concept.png"]
  }
}
```

## Codebase Context Workflow

Ask Agentify to pack local files or folders into a prompt:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "repo-review",
    "prompt": "Summarize this codebase in 8 bullets and list the top 3 risky files to change first.",
    "contextPaths": ["/absolute/path/to/repo"]
  }
}
```

Control context size:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "repo-review",
    "prompt": "Focus only on rendering and state management.",
    "contextPaths": ["/absolute/path/to/repo"],
    "maxContextChars": 120000,
    "maxContextFiles": 80,
    "maxContextInlineFiles": 30
  }
}
```

The tool result includes `packedContextSummary` so you can see what was included, attached, or skipped.

## Browser Backend

Agentify Desktop supports two browser backends:

- `chrome-cdp`: launches or attaches to a Chrome-family browser over Chrome DevTools Protocol. This is the default and recommended backend.
- `electron`: embedded windows managed by Agentify Desktop. Use this only as an explicit fallback.

Chrome CDP is the default because SSO providers commonly block embedded Electron login:

```bash
npx @agentify/desktop
```

Optional Chrome CDP settings:

```bash
AGENTIFY_DESKTOP_CHROME_DEBUG_PORT=9333 npx @agentify/desktop
AGENTIFY_DESKTOP_CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npx @agentify/desktop
```

You can also pass GUI flags:

```bash
npx @agentify/desktop gui --browser-backend chrome-cdp
npx @agentify/desktop gui --browser-backend electron
npx @agentify/desktop gui --chrome-debug-port 9333
```

Chrome CDP profile modes:

- `Agentify isolated profile`: safest default.
- `Existing Chrome profile`: reuses your normal Chrome session. Fully quit Chrome first so the profile is not already locked.

## CAPTCHA And Login Policy

Agentify Desktop does not bypass CAPTCHAs or use third-party solvers. If a verification or login challenge appears, automation pauses, brings the relevant window forward, and waits for you to complete the step manually.

If your account uses Google, Microsoft, or Apple SSO, keep auth popups enabled in the Control Center. If embedded login remains unreliable, use Chrome CDP.

## Autopilot Production proposal preparation

The Control Center has one production-only action, `この内容を実行`, for the
existing keyed ChatGPT tab `autopilot-production`. It checks that exactly one
usable ChatGPT tab exists and that Agentify has no active or in-flight query.
The action generates the version-1 proposal envelope locally, then sends the
versioned `ai-autopilot-proposal-generation-v3` instruction through the existing
authenticated `POST /query` path. Agentify validates the response markers, JSON,
metadata, and current v3 contract locally; malformed responses are discarded and
retried up to three times with the same envelope metadata. The instruction asks
ChatGPT to clarify only user decisions; verification commands, timeouts, review
rounds, and other execution-plan details are owned by Autopilot and must not be
requested from the user. Host/local tasks may use a null repository with push
disabled, and their verification plan may be empty. It does not create a tab,
start Codex, create a worktree, write a task, commit, push, or send approval. Only
a locally validated response is treated as received and remains in ChatGPT for
the user to inspect; a non-empty marker-free response is treated as a clarification
instead of being retried or treated as a proposal. The Control Center asks the user
to answer ChatGPT and press `この内容を実行` again. The existing watcher still
requires the later exact approval turn (`開始して XXXXXXXX`). Proposal responses
must be emitted as exactly one unlabeled fenced code block containing the marker
pair and standalone JSON; clarification responses remain natural language. The
rendered DOM text obtained by Agentify removes the fence but preserves literal
backslashes, quotes, and JSON newline escapes inside the code block.

The fallback prompt boundary is [`autopilot-proposal.mjs`](autopilot-proposal.mjs)
and is kept in sync with `ai-autopilot/src/proposal-generation.mjs` by matching
the explicit instruction and protocol versions. The installed desktop cannot
depend on the private controller repository, so this small versioned template
is intentionally duplicated rather than introducing a daemon or API redesign.

After approval, the Autopilot Production card also shows the latest
ai-autopilot task progress snapshot: task id, phase, round, repository target,
latest review verdict, verification counts, and blocked/completed details. The
snapshot is a small versioned observation contract received through the
authenticated loopback API (`POST /autopilot/status`); Agentify does not read
ai-autopilot's `state.json` and does not control delivery. The last snapshot is
kept under the existing Agentify state directory, with an `updatedAt` timestamp
and a stale marker for old running snapshots.

The card also receives the watcher's separate bounded heartbeat mirror through
authenticated `POST /autopilot/watch-status` and reads it with `GET`. It shows
watcher confirmation, the matching exact approval command, approval detection,
launch preparation, controller start, and watcher errors. The mirror contains
only tab/proposal identifiers, approval code, lifecycle state, timestamps, and a
bounded error code/message; it never contains conversation text, contracts,
tokens, URLs, paths, or Codex output. The approval command is copyable but is
never sent by Agentify. Completed or blocked task snapshots are labeled as the
previous Autopilot execution and can be hidden with `表示を消す`; this removes
only the Agentify display snapshot and never deletes task state, worktrees,
branches, evidence, or the watcher ledger. The API rejects clearing a running
snapshot.

## Structured Conversation Turns

The authenticated loopback API exposes a read-only ChatGPT conversation boundary
for local controllers:

```text
POST /conversation/turns
Authorization: Bearer <local-token>
Content-Type: application/json

{"tabId":"existing-chatgpt-tab","maxTurns":100,"maxCharsPerTurn":100000,"maxTotalChars":1000000,"historyMode":"complete"}
```

The request accepts exactly one of `tabId` or `key` (a key-only request remains
supported), accepts `historyMode: "visible"` or bounded `"complete"`, requires the resolved tab's `vendorId: "chatgpt"`, and never creates
a tab, navigates, queries, sends, or falls back to another vendor. The response
is bounded and returns `ok`, `tabId`, `vendorId`, the conversation URL, and the
latest valid DOM-ordered turns with `id`, `role`, `text`, and `index`. Complete
mode accumulates virtualized DOM windows and returns bounded completeness,
top-reached, stability, iteration, count, reason, and scroll-restoration
diagnostics. `history.complete: true` proves a continuous, stable sequence from
conversation start through the latest turn observed at read start. Timeouts,
loading stalls, gaps, ambiguity, and limits remain incomplete; the default
`visible` mode preserves the prior current-DOM-window response shape.
For Chrome/CDP, complete mode temporarily normalizes a minimized window only
when the page becomes visible and focused, uses the native mouse-wheel path for
history movement, and restores the conversation scroll with bounded convergence
before restoring the original window state. Its default history budget is the
existing maximum of 30 seconds or 80 iterations, and bounded lifecycle/restore
diagnostics are recorded. Other backends retain their existing native scrolling
path.
Clients should send the resolved `tabId` without duplicating `key` or
`vendorId`; requests containing both selectors are rejected.
Only ChatGPT's `data-message-author-role` selectors are used; nested duplicates,
composer and control text, empty turns, and NUL characters are excluded while
Markdown, JSON, and code blocks are preserved. The endpoint is intended for the
ai-autopilot approval watcher and uses the existing loopback and bearer-token
security boundary.

For read-only browser visibility diagnostics without scrolling, use the
authenticated endpoint:

```text
POST /native-input/diagnostics
Authorization: Bearer <local-token>
Content-Type: application/json

{"key":"autopilot-production"}
```

This endpoint serializes the controller operation and reads only bounded window
state and document visibility/focus values. It does not call scroll, pointer,
keyboard, focus, bring-to-front, or window-bounds mutation APIs, and it does not
expose CDP window, target, or session identifiers.

For a bounded, read-only causal probe of a minimized Chrome CDP tab, use the
authenticated endpoint below. It temporarily changes only the existing tab's
window state to `normal`, performs exactly one older-direction touch scroll
gesture when the document becomes visible, and always attempts to restore
`minimized` before returning. It does not send messages or run complete-history
backfill.

```text
POST /native-input/scroll-visibility-probe
Authorization: Bearer <local-token>
Content-Type: application/json

{"key":"autopilot-production"}
```

The endpoint is intentionally limited to a tab selector and returns bounded
window, visibility, gesture, URL-stability, and restoration diagnostics. It
does not provide general window-control operations or expose window/session
identifiers.

For a separate one-shot desktop mouse-wheel experiment, use the authenticated
`POST /native-input/mouse-wheel-visibility-probe` endpoint with the same tab
selector body. It requires the existing tab to be minimized, temporarily
normalizes it without an explicit focus or foreground call, requires the
document to be visible and focused, moves to the resolved conversation
scroller, dispatches exactly one older-direction `mouseWheel` with `deltaY`
`-720` per attempt, up to eight bounded attempts, stopping early on a
conversation-window transition, physical top, or safety failure. It restores
the minimized state in a `finally` path. Caller input is limited to `key` or
`tabId`; delta, direction, count, and window state are not configurable. This
probe does not run complete-history backfill or send a message.

## Windows Notes

Use Node.js 20 or 22 on Windows. Agentify Desktop is tested against Windows in CI, including the npm CLI launcher path.

Chrome CDP is still the recommended backend on Windows because Google and Microsoft SSO can block embedded Electron login. Agentify looks for Chrome, Chromium, Brave, and Microsoft Edge in the usual install locations and on `PATH`.

If Chrome CDP cannot find your browser, set the executable explicitly:

```powershell
$env:AGENTIFY_DESKTOP_CHROME_BIN = "C:\Program Files\Google\Chrome\Application\chrome.exe"
npx @agentify/desktop
```

## Local Data And Privacy

Agentify Desktop is local-first:

- The local API binds to `127.0.0.1`.
- The local API requires a bearer token stored under `~/.agentify-desktop/`.
- Electron browser data is stored under `~/.agentify-desktop/electron-user-data/`.
- Chrome CDP profile data is stored under `~/.agentify-desktop/chrome-user-data/` unless you choose an existing profile.
- Stable keyed tabs are restored after Agentify restarts from `~/.agentify-desktop/tabs.json`. The registry stores the supported vendor conversation URL without credentials, query parameters, or fragments; unkeyed tabs and the built-in `default` tab remain session-only.
- Artifacts, bundles, logs, and state are stored under `~/.agentify-desktop/`.

Anyone with access to your machine account may be able to access local session data. Treat the machine account as the security boundary.

## Environment Variables

- `AGENTIFY_DESKTOP_STATE_DIR`: override the local state directory.
- `AGENTIFY_DESKTOP_PORT`: choose the local API port.
- `AGENTIFY_DESKTOP_SHOW_TABS=true`: show newly-created tabs by default.
- `AGENTIFY_DESKTOP_MAX_TABS`: cap parallel tabs.
- `AGENTIFY_DESKTOP_BROWSER_BACKEND=electron|chrome-cdp`: choose browser backend.
- `AGENTIFY_DESKTOP_CHROME_BIN`: choose Chrome/Chromium executable.
- `AGENTIFY_DESKTOP_CHROME_DEBUG_PORT`: choose Chrome debug port.
- `AGENTIFY_DESKTOP_CHROME_PROFILE_MODE=isolated|existing`: choose Chrome profile mode.
- `AGENTIFY_DESKTOP_CHROME_PROFILE_NAME`: choose an existing Chrome profile name.

## Development From Source

Source checkout, quickstart script usage, local build commands, and source-only debugging notes live in [DEVELOPMENT_FROM_SOURCE.md](DEVELOPMENT_FROM_SOURCE.md).

## Package Commands

The npm package exposes these commands:

- `agentify-desktop`: default GUI launcher, with `mcp` subcommand support.
- `agentify-desktop-gui`: explicit GUI alias.
- `agentify-desktop-mcp`: explicit MCP alias.

Examples:

```bash
npx @agentify/desktop
npx @agentify/desktop mcp
npx -p @agentify/desktop agentify-desktop-mcp
```

## License And Trademarks

The code is licensed under `MPL-2.0`. Agentify trademarks and branding are not included in that license. See [TRADEMARKS.md](TRADEMARKS.md).
