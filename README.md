# codiva

> A TUI app you launch inside a Git repository. Every instruction you type starts a coding-agent session (Claude Code / Codex / Grok) on its own isolated git worktree, and they all run in parallel.

[![npm version](https://img.shields.io/npm/v/codiva.svg)](https://www.npmjs.com/package/codiva)
[![CI](https://github.com/takecchi/codiva/actions/workflows/ci.yml/badge.svg)](https://github.com/takecchi/codiva/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**日本語のドキュメントは [README.ja.md](./README.ja.md) にあります。**

`codiva` is a terminal UI that spins up a coding-agent session on a fresh git worktree + branch every time you type a plain-language instruction, so several tasks make progress at the same time. The goal is simple: *keep throwing instructions at it and watch the work happen in parallel.*

**It is not Claude Code only.** You can pick any of these three (switch with `/agent` in the session list — see [Choosing and switching agents](#choosing-and-switching-agents-agent)):

| Agent | What it launches |
|---|---|
| **Claude Code** | [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) (the `claude` CLI) |
| **Codex** | OpenAI's `codex` CLI |
| **Grok** | xAI's `grok` CLI |

You can choose the default for new sessions, and you can also switch a running session mid-flight (the worktree, working tree and PR all carry over). Where agents differ in what they support (permission dialogs, cost display, …) is spelled out in the capability table below.

## Features

- **Parallel sessions** — every instruction gets its own worktree (`.codiva/worktrees/<slug>`) and branch (`codiva/<slug>`), so file edits never collide.
- **Pick your agent** — Claude Code / **Codex** (`codex` CLI) / **Grok** (xAI's `grok` CLI). Use `/agent` in the list to choose the default for new sessions (saved automatically), and `/agent` in the detail view to switch an existing session mid-flight. Install and login status is shown in `/agent`, and `/login` lets you sign in from inside codiva.
- **Live progress** — the list view shows every session's state (`Running` / `Step 4/7` / `Question` / `Awaiting permission` / `Completed` / `Failed`) and elapsed time.
- **Non-blocking submission** — you can type the next instruction the instant you submit one.
- **Permission replies and follow-ups** — approve/deny tool use and send follow-up instructions to a running session from the detail view.
- **Merge or discard** — review the diff stat of a finished session, then merge it into the base branch or throw the whole worktree away.
- **Repo-wide instructions** — anything written in `.codiva/prompt.md` (e.g. "open a PR when you're done") is injected into every session. Editable inside the TUI via `/prompt`.
- **Plan / usage display** (Claude only) — the list header shows your claude.ai plan tier (Pro / Max / Team / Enterprise) and usage limit windows (percentage used, time until reset). Codex / Grok don't report these, so nothing is shown while one of them is the default agent.
- **Current branch** — the header shows the branch the target repository has checked out (i.e. where new sessions branch from and merge back to). It catches up within seconds even if you switch branches in another terminal.
- **Training-data warning** (Claude only) — a notice line appears in the startup header only when claude.ai's "Help improve our AI models" setting is ON.
- **Update notification** — codiva checks npm for a newer version at startup and shows one line in the header if there is one. `/update` upgrades in place after a confirmation.
- **Keyboard-first** — the mouse is optional. You can still drag-select and copy from the input, the header and the session log (dragging past the edge of the log auto-scrolls while the selection keeps growing). URLs in the log open in your browser on click.
- **Japanese / English UI** — switch via `~/.codiva/config.json` or `CODIVA_LANG`.

## Requirements

- Node.js **>= 20**
- **At least one of the `claude` / `codex` / `grok` CLIs** installed and logged in (see [Choosing and switching agents](#choosing-and-switching-agents-agent)).
  codiva starts even with none of them installed, and `/login` lets you sign in from inside codiva.
- The target directory is a Git repository with at least one commit

## Installation

```bash
npm install -g codiva
```

Just want to try it once:

```bash
npx codiva
```

### Updating

At startup codiva queries the npm registry exactly once and, if a newer version exists, shows `↑ v0.3.0 is available · run /update` in the banner (nothing is shown when you're up to date or the check failed).

Running `/update` re-checks for the latest version and, if there is an update, prints the command it would run and asks `y` / `n`. On `y` codiva runs `npm install` itself and then asks you to restart.

- Global install (`npm install -g codiva`) → runs `npm install -g codiva@latest` (you get a warning first if sessions are still running)
- `npx codiva` → nothing to update, so nothing happens (the next `npx` picks up the latest)
- Anything else (a project-local dependency / under a tool manager like volta / Windows / an install layout codiva can't identify) → codiva **does not run anything** and only shows you the command to run

The set of layouts codiva refuses to handle is deliberately wide. Updating a local dependency rewrites your repository's `package.json` and lockfile and rebuilds `node_modules` (which is symlinked into every worktree by default). And running `npm install -g` against an unidentified layout could install to somewhere other than where codiva actually lives and break your environment. The cost of a misdetection is capped at "you have to run one command yourself".

The check is a single request to `https://registry.npmjs.org/codiva/latest` (~2.3 KB, 3-second timeout) and the only thing sent is the package name — no version, no telemetry. Startup is never blocked, even offline. Set `"updateCheck": false` in `~/.codiva/config.json` to disable the request entirely.

## Usage

Launch it from the root of the target repository.

```bash
cd path/to/your-repo
codiva
```

1. Type an instruction (e.g. "implement the login flow") and hit Enter. A new session is created and you can immediately type the next one.
2. Watch each session's progress in the list view.
3. Select a session to open the detail view, where you can read the log, send follow-ups and answer permission requests.
4. When it's done, review the diff stat and merge or discard.

> codiva writes a `.codiva/.gitignore` containing a single `*` line, which hides everything under `.codiva/` from git (the ignore file matches `*` itself, so it's self-contained). Your repository's `.gitignore` and the contents of `.git/` are never touched.

### The input field

Long instructions **wrap automatically** at the terminal width, so nothing you type is truncated out of view (words aren't broken mid-word when there's whitespace to break at). The field grows to 8 rows and then scrolls internally to follow the caret.

#### Keys

These are identical in every input field (the list composer, the follow-up field in the detail view, the `/prompt` editor, and the free-text field in question dialogs). There's a single implementation, so behaviour never differs by location.

| Key | Action |
|---|---|
| `Enter` | Submit (runs a command when the text starts with `/`) |
| `Shift+Enter` | Newline (on terminals where that doesn't reach the app, end the line with `\` and press `Enter`) |
| `Ctrl+U` | **Clear the draft** (empties the field regardless of caret position) |
| `←→` | Move the caret |
| `↑↓` | Move the caret (by **visual row**, i.e. after wrapping). Pressing again at the top/bottom row walks the **input history** (list composer only) |
| `Backspace` | Delete one character |

#### Input history (list composer)

In the list view's input field, `↑` recalls **instructions you already sent**, like a shell (last 50; repeated identical instructions collapse into one).

- `↑` only becomes history when the caret is on the top row. While you're writing a multi-line draft, normal caret movement wins, so a draft never turns into history behind your back.
- `↓` walks back toward the newest entry, and going past the newest restores **the draft you had when you started browsing** (peeking at history never costs you your draft).
- Recalled text is fully editable (the caret lands at the end). `Ctrl+U` throws it away.
- In the detail view's follow-up field `↑↓` scroll the log, so history is a list-composer-only feature.

> macOS's `Cmd+Delete` never reaches the app (the `super` modifier only arrives on terminals with the kitty keyboard protocol enabled), which is why "clear all" is bound to `Ctrl+U`. To use `Cmd+Delete`, map it to `Ctrl+U` (`\x15`) in your terminal. On Ghostty, add this one line to your config:
>
> ```
> keybind = super+backspace=text:\x15
> ```

### Focus movement in the list (`Tab`) and answering questions

In the list view, `Tab` cycles focus **input field → question/permission dialog → session list → input field** (`Esc` returns to the input field from anywhere). The dialog only joins the cycle when the selected session is **actually waiting on a question or a permission request**.

| Zone | What `↑↓` does | Main keys |
|---|---|---|
| Input field | Caret movement / input history | `Enter` submit |
| Dialog | Move through the dialog's choices | `Enter` confirm · `Space` toggle (multi-select) · `y`/`n` (tool permission) |
| Session list | **Select a session** | `Enter`/`→` detail · `m`/`d`/`x` · `p` |

- **Selecting a row that's waiting on a question or permission hands the keys straight to the dialog** (whether you got there with `↑↓` or by clicking the row). Answering is what's blocking progress, so you shouldn't have to press `Tab` to reach it.
- **`Tab` is the way back to the list** (i.e. to switching sessions with `↑↓`). In the list zone the dialog stays visible — you can still read it — but it doesn't receive keys.
- **Dialog choices are clickable too** (confirm with `Enter` — the same relationship as clicking a list row and pressing `Enter` to open the detail view). Clicking a wrapped label line or a description line selects that choice as well. Even a dialog that's "display only" in the list zone will hand focus back to answering when you click a choice.
  - A click never confirms a permission (`y`) or a choice. `y`/`n` for tool permissions always require a key.
- Partial answers (which question you're on, which boxes are checked, a half-written free-text answer) survive `Tab` round-trips and clicking back into "write your own".
- Once you've answered, focus returns to the input field, so the next incoming question **doesn't steal your keystrokes** (one `Tab` gets you back to answering).

> **`Space` toggles checkboxes even with a Japanese IME turned on.** With macOS Japanese input, `Space` during kana composition arrives as a **full-width space** (only `Shift+Space` arrives as a half-width one). codiva treats the full-width space as the `Space` key, so you don't have to disable the IME or add `Shift` just to tick a box. (Letter keys such as `y`/`n` for tool permissions get swallowed by IME conversion, so turn the IME off for those.)

### Focus movement in the detail view (`Tab`) — read back before you answer

**While a question or permission dialog is up** in the session detail view, `Tab` moves between **the dialog and the conversation log**. It exists so you're never shown a question in isolation and forced to answer without knowing what it's about.

| Zone | What `↑↓` / `PgUp` `PgDn` do | Main keys |
|---|---|---|
| Dialog (default) | Move through the dialog's choices | `Enter` confirm · `Space` toggle · `y`/`n` (tool permission) |
| Conversation log | **Scroll the log** | `Tab` back to answering · `Esc` to the dialog |

- When a dialog appears **focus lands on the dialog first** (answering is what's blocking progress, so you don't press `Tab` to get there). Press `Tab` once when you want to read back.
- In the log zone the dialog **stays on screen** — only the keys go elsewhere. `Tab`, `Esc` or **clicking the dialog** all get you back to answering.
- Partial answers (question index, checked boxes, half-written free text) survive the round-trip.
- **Drag-selection and clicking URLs work as usual** in the log zone (wheel scrolling works in both zones).
- Once you've answered, focus returns to the dialog side so you can answer the next question right away.
- `Ctrl+C` (interrupt) works in both zones.
- **The dialog never crushes the log.** When there are many choices or long descriptions, the dialog gets a height cap and **the choices scroll internally** (hidden entries are shown as `↑ 3 more` and follow your cursor as you move with `↑↓`). Previously the dialog grew one row per choice, and on a ~24-row terminal **not a single log line was visible**. The list view's dialog reserves room for session rows the same way.

### Reading and scrolling the log

In the session detail log, the agent's response **grows downward as it arrives** (rather than a single line being rewritten), so you can read it like a chat.

- **It only follows the tail while you're at the bottom.** While you're back in history via `↑`/`PgUp`/wheel, the view doesn't move a single line even as the response grows (you never get swept along mid-read). "Viewing history — N lines to latest" appears at the bottom of the screen; `↓`/`PgDn` returns to the tail and resumes following.
- While text is still streaming it's rendered plain (no bold, no headings); it's replaced with the formatted body the moment the turn completes.

### Interrupting work in progress (`Ctrl+C`)

Pressing `Ctrl+C` in the session detail view **interrupts the turn that session is currently running** (the same gesture as `Ctrl+C` in Claude Code). codiva itself does not exit.

- An interrupted session is kept as **"interrupted", not "failed"**, so `Ctrl+R` (or just sending a follow-up) resumes **the same conversation**. The worktree, branch and work-in-progress code are untouched.
- **It works while a permission or question dialog is up too.** The dialog's `n` (deny) only refuses that one tool call and work continues, so use `Ctrl+C` when you want to stop *the work itself*.
- It works while the input field has focus (use `Ctrl+U` if you only want to clear a draft). A hint appears at the bottom of the screen while a turn is running.
- If you want to **throw the session away** rather than interrupt it, use `d` (discard) / `x` (remove). In the list view `Ctrl+C` does nothing — interrupting is a detail-view-only action, to avoid misfires.

### Copying text

**Every input field** (the list composer, the detail view's follow-up field, the `/prompt` repo-instruction editor, the free-text field in question dialogs), the header (wordmark / plan / model / branch / cwd) and **the session detail log** support **drag to select, release to copy to the clipboard** (via OSC 52, so it works over SSH too). Drag the header's cwd line to paste the path you're working in. Dragging in the header never moves typing focus or the selected row in the list.

- **You can select beyond what fits on screen in the log.** Keep dragging past the visible area (above the top / below the bottom) and the log auto-scrolls in that direction while the selection keeps growing. Scrolling continues even if you hold the mouse still, and only the selected range is copied when you release.
- What gets copied is **exactly what you see** (wrap points become newlines, and line prefixes like `•` and continuation indents are included).
- The selection is highlighted in reverse video and cleared by any keypress.
- Native terminal selection (select anywhere, but no app-side features) is available with **Shift+drag**, or by disabling mouse capture with `"mouse": false`.

### Opening URLs in the log

URLs in the session detail log are **underlined and open in your browser on click** (only a press-and-release without dragging opens them, so it doesn't conflict with drag-selection).

- `http(s)` URLs are recognized. For Markdown links (`[label](URL)`), clicking the label follows the link.
- Even when wrapping splits a URL across two lines, **clicking either line opens the whole URL**.
- **This is a plain click, not Cmd+click (the terminal's own link handling).** While codiva is full-screen it enables the terminal's mouse reporting, and some terminals disable their own link detection in that state (Ghostty ignores link hover and clicks entirely while the mouse is captured; SGR mouse reports have no bit for Cmd/Super either). So codiva takes the click itself and opens the URL, which behaves the same on every terminal.
- codiva also emits **OSC 8 hyperlinks**, so on terminals that support them (iTerm2 / GNOME Terminal / Windows Terminal, …) the terminal's own Cmd+click / Ctrl+click works too. On Ghostty / kitty / WezTerm, add Shift — **Shift+Cmd+click** (Shift+Ctrl+click on Linux) — because Shift is the mouse-capture bypass key. Terminals that don't support the escape simply ignore it and the display is unchanged.

### GitHub PR status

The right edge of each list row shows the state of the PR for that session's branch (detected by running `gh` every 20 seconds; click or press `p` to open it in a browser).

| Display | Meaning |
|---|---|
| `⋯` | Checking (the first query hasn't finished) |
| (blank) | No PR for this branch |
| `⋯ #12` | PR exists, **state being checked** (e.g. right after a restart) |
| `? #12` | PR exists, **state could not be checked** (rate limit / offline / `gh` not authenticated) |
| `✓ #12` | Mergeable (checks are green too) |
| `● #12` | **Checks running** |
| `✗ #12` | **Checks failed**, or not mergeable due to conflicts |
| `⑂ #12` | Merged |
| `⊘ #12` | **Closed without merging** (not a recovery target — see below) |
| `✓ #12 +2` | **3 PRs in total** (see below) |
| `?` | **Could not be checked** (GitHub API rate limit / offline / `gh` not authenticated) |

A dimmed number (`#12`) means a draft PR. On machines without `gh` the PR column is always empty.

#### When one session produces several PRs

When a session cuts its own branch and runs `gh pr create`, several PRs end up attached to one session. The list then shows `#12 +2` (the primary number plus the remaining count), and **the full set appears in the detail view (Enter) on the `3 PRs: ✓ #12 · #13 · #14` line**.

- The primary is **the PR for the session's branch (`codiva/<slug>`)**. That's what click / `p` opens, and the glyph (`✓` / `✗` / `●`) is that PR's state. If the branch has no PR, the last PR the session created becomes primary.
- Once a PR is primary, codiva **queries it by URL and tracks its state** even when its head branch isn't checked out in the worktree (including PRs in another repository), so it gets a glyph. Non-primary PRs (folded into `+n`) aren't tracked, so the detail view shows just their numbers.
- Conversely, **a reference GitHub answers "no such PR" for disappears from the list** (a misdetected URL, or a PR that was deleted). It is *not* dropped when the state merely "couldn't be checked" due to rate limiting or being offline (you just get `?`).
- Detection comes from the command output (the PR URL) of a `gh pr create` run. Merely looking at other PRs with `gh pr list` or `gh pr view` doesn't count (nor do commands that mix reads in, like `gh pr create … || gh pr list …`, to avoid false positives). Detected numbers are persisted, so `+n` survives a restart.
- Conversely, **PRs created while codiva wasn't running, or before this feature existed, don't show up in `+n`** (the command output happens once and can't be re-derived from a branch name later). PRs on the session branch are still detected via `gh` as always.
- Rows with multiple PRs widen the PR column slightly, so on narrow terminals (~80 columns) the branch column may be dropped.

A PR's **number** and its **state** are handled separately. The number is immutable for a branch, so it's persisted and `#12` appears immediately on the next launch (the state glyph arrives with the first poll). When only the state can't be fetched, the number stays and `⋯` (checking) / `?` (unknown) takes the glyph's place.

When you see `?`, check `gh auth status` and `gh api rate_limit`. GitHub's API rate limit in particular (GraphQL: 5000/hour) is shared with the `gh` calls your sessions make themselves, so heavy parallel work can exhaust it. On detecting this, codiva pauses polling for 5 minutes to let it recover. **The last known PR number and state stay on screen throughout** (vanishing would be more confusing).

### Recovering a stuck PR (base merges / CI fixes)

When a PR conflicts (`✗`) or CI goes red, you shouldn't have to enter each worktree by hand to fix it.

| Action | What it does |
|---|---|
| `/sync` | **Merges the base branch into** the selected session's worktree (the current session's, in the detail view) |
| `/fix-ci` | **Asks the selected session to fix the failing CI** |
| `Ctrl+F` (= `/recover`) | Recovers **every stuck session** at once (shows the count and asks `y` / `n`) |

`Ctrl+F` works regardless of focus. While there are stuck rows, a hint line appears in the list.

**What `/sync` does** (`git fetch origin <base>` → `git merge`):

| Situation | Result |
|---|---|
| Base is already included | Nothing happens |
| Merged cleanly | Merges and **pushes** (the session isn't woken — no tokens spent) |
| **Conflicted** | Does *not* `git merge --abort`; **leaves the conflict in the worktree** and asks the session to resolve it, with the conflicting file list attached |
| **Uncommitted changes present** | Doesn't attempt the merge; asks the session to commit/stash first, then take the base in (so it can't get mixed into work in progress) |

codiva never resolves conflicts on its own with things like `-X ours` (that would silently discard code). The session (the AI) decides, and is instructed to ask when it can't.

**PRs closed without merging (`⊘`) are not recovered.** Unlike a conflict or a red CI, they aren't *stuck* — they're **done** (a human decided to close them). They're excluded from `Ctrl+F`, and even with `autoSync` / `autoFixCi` enabled no base-merge or CI-fix instruction is sent (no tokens on closed PRs). To continue the work, reopen the PR on GitHub (the state glyph comes back on the next poll).

**What `/fix-ci` does**: it pulls **the failing check names and URLs** out of the very same `gh pr view` call that backs the PR status (no extra API calls) and attaches them to an instruction to "read the logs with `gh run view --log-failed`, fix the cause and push". Fetching the logs and making the fix is the session's own job.

**Automation** (off by default; the manual commands work regardless of these settings):

```json
{ "autoSync": true, "autoFixCi": true }
```

- `autoSync`: merge the base in automatically once a PR is found to be conflicting.
- `autoFixCi`: ask for a fix automatically when checks go red.
- Both only fire **while a session is idle** (completed, failed, interrupted, …). They never interrupt work in progress, and never run `git merge` in a worktree that's being worked on (the manual `/sync` behaves the same).
- Automatic requests are limited to **2 per session per kind**. The count only resets when the PR **actually goes green** (or gets merged) — not on "checks running" right after a push (otherwise a fix that never works would loop turns forever).
- The default is off because a request means a turn runs, which means you get billed.

### Query frequency (more sessions doesn't mean more load)

Instead of querying every session every 20 seconds, codiva does this:

- **Refresh intervals depend on state** — 20 seconds while checks are running, 60 seconds while GitHub is computing mergeability, 3 minutes for a settled PR. **Merged PRs and discarded/merged sessions are never queried again.** In between, the cached value is displayed as-is.
- **Batched into one call** — when 3 or more sessions need checking in the same cycle, a single `gh pr list` fetches everything and it's matched up locally. Ten sessions still means one API call.
- **Backs off when exhausted** — on detecting a rate limit or missing authentication, polling stops for 5 minutes.

### Plan / usage display (when the default agent is Claude)

The list view's header (banner) shows the claude.ai plan you're logged into and your usage limit windows (Codex / Grok don't report these, so nothing appears while one of them is the default).

```
Codiva v0.3.1   3 sessions
Plan: Claude Max   Model: claude-sonnet-5   Branch: main
/Users/you/projects/your-repo

Usage
  Current session   ████████░░░░░░░░░░░░  42%  resets in 2h 45m
  This week         ██████████████████░░  88%  resets in 3d 0h
```

- Every window (5-hour, weekly, extra usage) is listed as a **gauge + percentage + time remaining**. The plan name, organization name and **the target repository's current branch** appear on the same line as the model (`Plan: Claude Max   Model: sonnet   Branch: main`). The branch is where new sessions branch from and merge back to; it catches up within seconds even if you `git switch` in another terminal, and is hidden on a detached HEAD.
- Updates come from two sources: running sessions get the latest values Claude sends at the start of each turn, and idle ones get an **automatic fetch every 5 minutes** (both are queries to Claude that run no inference, so there's no token usage or billing). Time-to-reset counts down.
- Some plans don't get a percentage (`%`) back from Claude. In that case the gauge is omitted and only the time remaining is shown (so 0% isn't misread).
- With an API key / Bedrock / Vertex there is no subscription limit, so this display doesn't appear.
- **The header describes "the agent that will run next".** Switch the default to Codex / Grok with `/agent` and the agent name, plan, model and usage all switch together (neither reports a plan or usage, so the plan line and gauges disappear and the model falls back to `Model: CLI default`). The 5-minute claude.ai fetch also stops while that's the case, and resumes when you switch the default back to Claude.
- The status bar at the bottom only carries the mode indicator (`⏵⏵ auto mode`) and key hints. Plan / usage live in the header (press Esc to return to the list if you want to see them from the detail view).

### Choosing and switching agents (`/agent`)

Sessions can be driven by **Claude Code** (the `claude` CLI / Claude Agent SDK), **Codex** (OpenAI's `codex` CLI) or **Grok** (xAI's `grok` CLI). Claude is the default, but codiva is perfectly usable with only Codex / Grok installed.

1. Install the CLI you want and log in (`claude` → `claude auth login` / `codex` → `codex login` / `grok` → `grok login`. Grok installs via `curl -fsSL https://x.ai/cli/install.sh | bash` and also works with `XAI_API_KEY`). **codiva does not bundle these CLIs** — like `git` and `gh`, it launches the commands installed on your machine (so users who don't need a provider aren't shipped a large binary). codiva never touches their credentials either.
2. **Type `/agent` in the list** and pick an agent; that's it — it becomes the default for new sessions (no hand-editing config: your choice is saved to `~/.codiva/config.json`. Writing `"agent": "codex"` / `"agent": "grok"` yourself works too). The dialog lists each agent's **install and login status** (`Ready` / `Not signed in` / `Not installed`).
3. To switch an already-running session, open the detail view (`Enter` from the list) and pick **`/agent`** there. The switch takes effect **from the next instruction**.

codiva starts even with none of `claude`, `codex` or `grok` installed. In that case the list says "No coding agent found" — follow the instructions to install one and log in.

**You can sign in from inside codiva.** Type **`/login`** in the list or detail view (or select a target in the `/agent` dialog and press `l`) and codiva launches `codex login` / `claude auth login` / `grok login --device-auth` in the background, **showing the auth URL and one-time code in a dialog** (the URL is also opened in your browser automatically). Finish signing in there and the status updates on its own (`Esc` aborts). The terminal is never handed over, so other sessions keep running.

Here's what does and doesn't carry over when you switch with `/agent`:

| Carries over | Does not carry over |
|---|---|
| The worktree, branch and working tree contents; codiva's user/assistant conversation log, title and PRs | The provider's native session itself (each CLI keeps its own transcript) |

The conversation id of each agent you've used is stored per session, so going Claude → Codex → Claude resumes **the original conversation** where it left off (this survives restarting codiva too).

The provider-native context can't be transferred directly, so **codiva copies the retained user and assistant conversation into a one-time handoff** for the incoming agent. It also includes the branch name, the first and most recent instructions, and a reminder to verify the working tree with `git status` / `git diff`. Tool-execution logs are left out (they're bulky, and the working tree tells the same story). The newest conversation is prioritized, and an omission marker is shown if the handoff reaches its safety limit. No extra turn runs at switch time; the handoff rides along with the next instruction you send.

**You can always see what each session is running on.**

- The header shows `Agent: Claude` — **the default for new sessions**.
- List rows get an agent-name column **only when several agents are in play** (if they're all the same it just duplicates the header, so that width goes to titles and branch names instead).
- The detail view's input field names the recipient, e.g. `Send a follow-up to Claude…`.
- The conversation log of a switched session gets a `── Codex from here ──` divider, so you can tell which agent said what.

#### Capability differences between agents

Worktree isolation, parallel execution, follow-ups, interrupting (`Ctrl+C`), merge / discard, PR automation (`/sync` / `/fix-ci`), desktop notifications, repo-wide instructions (`.codiva/prompt.md`) and `/model` all **work the same on every agent**. Only these four things differ.

| | Claude Code | Codex | Grok |
|---|---|---|---|
| Tool permission / question dialogs | ✅ | ❌ (sandbox instead) | ✅ |
| Cost display (total in the header) | ✅ | ❌ | ❌ |
| Plan / usage gauges | ✅ | ❌ | ❌ |
| Log restoration after a restart | ✅ | ❌ (resuming the conversation still works) | ❌ (same) |

**Codex session limitations** (differences from a Claude session):

- **It doesn't ask for tool permission.** `codex exec`'s JSON output mode auto-rejects approval requests inside the CLI, with no way to surface them to codiva. So rather than fake a plausible-looking permission dialog, codiva makes **the sandbox the only safety valve** (setting `codexSandbox`; the default `workspace-write` confines writes to the session's worktree). Codex sessions also never enter the `Question` state.
- **It doesn't display cost.** Codex only returns token counts at the end of a turn — no amounts, no account-wide usage. Codex sessions are excluded from the header's total cost (so a Claude-only figure isn't presented as "everything"). The plan display and usage gauges are about your Claude account, so **they don't appear in the header while Codex is the default** (and nothing is fetched either).
- **The footer's mode indicator reads `confirm mode (unsupported)`.** Since nothing can be asked, a plain `confirm mode` would read as "wait and you'll be asked" (the `shift+tab` toggle itself still works).
- **The log isn't restored after a restart** (resuming the session itself does work). Log reconstruction reads the Claude CLI's transcript files, and Codex's transcripts use a different format.
- `/model` lists Codex's own models (`codex debug models`). On machines where that list can't be fetched you only get "default" (codiva doesn't guess model names). Switching provider with `/agent` resets an incompatible model selection to the CLI default. Codex doesn't include the model name in its execution events, so the list shows whatever model you set explicitly with `/model`.

**Grok session limitations** (differences from a Claude session):

- **Tool permissions and questions come through normally.** Unlike Codex, Grok surfaces permission requests (`Awaiting permission`) and questions (`Question`) over codiva's bidirectional channel, so you answer them in dialogs as usual.
- **It doesn't display cost.** Grok only returns token counts at the end of a turn — no amounts, no account-wide usage. Grok sessions are excluded from the header's total cost, and the plan display and usage gauges (which are about your Claude account) don't appear while Grok is the default.
- **The log isn't restored after a restart** (resuming the session itself does work). Log reconstruction reads the Claude CLI's transcript files, and Grok's transcripts use a different format.
- `/model` lists Grok's own models. On machines where that list can't be fetched you only get "default" (codiva doesn't guess model names). Switching provider with `/agent` resets an incompatible model selection to the CLI default. Unlike Codex, Grok **tells you which model is actually running**, so the session list shows a model name even when you didn't set one with `/model`.

## Configuration

The on/off settings can be toggled from the TUI (`/config` in the list view — see [Changing settings from the UI](#changing-settings-from-the-ui-config)). Below is the full set of keys for editing the file directly.

`~/.codiva/config.json` (optional):

```json
{
  "language": "auto",
  "ignoredFiles": "symlink",
  "updateCheck": true
}
```

- `language`: `"ja"` / `"en"` / `"auto"` (follow the OS locale). The `CODIVA_LANG` environment variable (`ja` / `en`) takes precedence over everything.
- `updateCheck`: whether to check npm for the latest version at startup. Default `true`. Setting it to `false` stops the startup request and makes `/update` report "could not check".
- `ignoredFiles`: how `.gitignore`d untracked files (`node_modules/`, `.env`, …) are carried into a session's worktree. `git worktree` only carries tracked files, so without this you'd have to reinstall dependencies and re-create env files. Default `"symlink"`.
  - `"symlink"` (default): just symlink to the repository root. Zero copy cost, instant startup. Because the real files are shared, **codiva also tells the session about it, along with the "detach the link before writing" procedure** (see below).
  - `"copy"`: copy the real files from the repository root. The worktree becomes fully independent and work can never collide, but a huge `node_modules/` makes the copy slow.
  - `"none"`: carry nothing over (the session re-creates dependencies and env files itself).
  - The deprecated boolean `copyIgnored` is still understood for backward compatibility (`true` → like `copy`, `false` → like `none`). `ignoredFiles` wins if both are present.
  - **Build output and caches are never carried over** (`.next/` `.nuxt/` `.svelte-kit/` `.turbo/` `.vite/` `.cache/` `dist/` `build/` `out/` `coverage/` `target/` `__pycache__/` `*.tsbuildinfo`, …). They're generated, so the session can rebuild them, and sharing them breaks things (see below).
- `ignoredFilesExclude`: an array of patterns to add to — or cancel out of — the exclusion list above. It's appended **after** the defaults, and the last matching pattern wins. A pattern without `/` matches the final path segment, so it also catches nested locations like `apps/web/.next/`. A leading `*` matches a suffix (`*.log`).
  ```json
  { "ignoredFilesExclude": ["!dist", ".venv", "*.sqlite"] }
  ```
  This example means "do carry `dist/` over (cancelling the default exclusion), and don't carry `.venv/` or `*.sqlite`".
- `notifications`: whether to show desktop notifications on questions, permission requests, completion and so on. Default `true` (`false` disables them).
- `privacyWarning`: whether to show the header notice when training-data usage is ON. Default `true`. Setting it to `false` skips the detection entirely (see below).
- `autoSync`: whether to merge the base branch in automatically when a PR conflicts. Default `false` (see above).
- `autoFixCi`: whether to ask the session to fix CI automatically when it fails. Default `false` (see above).
- `crashLog`: whether to write a crash log to `~/.codiva/logs/` on an unexpected exit. Default `true` (see below). With `false` no file is written; codiva still prints the reason and restores the terminal.
- `agent`: which agent new sessions use by default. `"claude"` (default) / `"codex"` / `"grok"`. **Choosing one via `/agent` in the list saves it here**, so you normally don't write it by hand. Per-session switching is `/agent` in the detail view (see above).
- `claudeSettingSources`: an array of the settings layers a Claude session loads. `"user"` (`~/.claude/settings.json`) / `"project"` (`<repo>/.claude/settings.json`) / `"local"` (`<repo>/.claude/settings.local.json`). The default is `["project"]`, and `"project"` is always included whether you list it or not (the target repository's CLAUDE.md is only read through that layer).
  ```json
  { "claudeSettingSources": ["user", "project", "local"] }
  ```
  **Add `"user"` if you want your Claude Code plugins to work in codiva sessions too.** Plugin activation (`enabledPlugins`) for anything installed with `claude plugin install` is written to `~/.claude/settings.json`, so with the default, none of a plugin's skills / commands / subagents / hooks / MCP servers get loaded. The side effect is that **the rest of that layer (hooks, permissions, statusLine, …) also loads into your sessions**. That's why the default is `["project"]`: sessions run unattended in a worktree rather than in front of you, so codiva errs on the side of not silently importing your local Claude Code setup.
- `codexSandbox`: the sandbox for Codex sessions. `"read-only"` / `"workspace-write"` (default) / `"danger-full-access"`. Because Codex can't ask for tool permission, **this is the only safety valve for Codex sessions**. The default `workspace-write` means "read anything, write only inside the session's worktree".
- `codexNetworkAccess`: whether to allow network access when `codexSandbox` is `"workspace-write"`. Default `true`. Codex's own default is to block it, but that makes `npm install` and `gh` fail and most work never finishes, so codiva opens it (set `false` to close it).

### Shared symlinks and "detach when you need to"

With `ignoredFiles: "symlink"` (the default), `.gitignore`d paths such as `node_modules/` and `.env` are **links pointing at the originals in the main repository**. Reading through them is fine, but **writing** (adding or updating dependencies, building, code generation, clearing caches, …) rewrites the shared originals through the link, which propagates to your main checkout and to **other sessions running in parallel**.

So in this mode — and only this mode — codiva adds the following to each session's systemPrompt:

- that the ignored paths in this worktree are symlinks into the main repository and the targets are shared
- that reading is safe, but **before writing you must detach that one path and give the worktree its own copy** (either by copying the current contents, or by regenerating it with a fresh install / clean build)
- that removing the link with `rm -rf <path>/` or `<path>/*` (trailing slash, globs) **deletes the shared contents**
- that `.gitignore` patterns like `node_modules/` **don't match a symlink** because of the trailing slash, so the links show up as untracked (`git add -A` would commit the link itself, so stage by path)
- that only the paths actually being written to need detaching, and **tasks that don't write need nothing at all**

The wording is language- and toolchain-agnostic ("check whether it's a symlink"), so it works the same in projects that have no `node_modules`. codiva never pre-emptively replaces the links itself (what will be written depends on the instruction, and copying everything would defeat the point of symlink mode).

Use `"copy"` if you want full independence from the start, or `"none"` if you'd rather set things up yourself.

### Build output isn't carried over (dev-server freeze prevention)

Among `.gitignore`d paths, **build output and caches** (`.next/`, `dist/`, `target/`, `coverage/`, `*.tsbuildinfo`, …) are never carried over, in either `"symlink"` or `"copy"` mode. Two reasons:

- **Sharing them breaks things.** Running dev servers or builds in the main repository and several worktrees at once means concurrent writes to the same files.
- **Worktrees live inside the repository** (`.codiva/worktrees/<slug>`). So to a dev server that watches recursively from the project root (Next.js / Turbopack, …), **the directory it keeps writing to appears once per worktree as a separate path**. Change notifications echo back many times over, eating CPU, memory and file descriptors — sometimes freezing the whole OS ([#81](https://github.com/takecchi/codiva/issues/81)).

Generated files can be rebuilt by the session, so not carrying them is the safe default. Detection is a list of directory names, so add your project's own build output to `ignoredFilesExclude` (or cancel an exclusion with `"!dist"` if you do want to share something).

**Links left over in existing session worktrees are removed automatically at startup** (this also fixes worktrees created by older versions). Only **symlinks** are removed, so the link targets (the contents of the main repository) and any real build output inside the worktree are untouched.

If you want to reduce what's being watched in the first place, the reliable fix is adding `.codiva` to your dev server's watch-ignore config on the project side. (Hiding it from git is handled for you: codiva drops in `.codiva/.gitignore`. Your repository's `.gitignore` is never modified.)

### Desktop notifications

codiva notifies you when a session changes to states like "question", "permission request", "completed" or "failed" (it stays quiet while a state persists).

Notifications are emitted **by the terminal itself** whenever possible (using the notification escape sequences of Ghostty / WezTerm / foot / iTerm2 / kitty). That means clicking a notification brings the terminal running codiva to the front. It works inside tmux too, but requires `set -g allow-passthrough on`. Over SSH, notifications reach your local terminal for Ghostty / kitty / foot (identifiable from `TERM`) and for iTerm2 (which forwards `LC_TERMINAL`).

On terminals not covered above (macOS's built-in Terminal.app, Windows Terminal, …) codiva falls back to an OS command (`osascript` on macOS, `notify-send` on Linux). **On the macOS fallback path notifications are attributed to "Script Editor", and clicking one opens Script Editor** — an inherent limitation of notifications posted via `osascript`. Notifications also won't appear if you've disabled them on the terminal side (e.g. Ghostty's `desktop-notifications`).

### The training-data usage warning

On accounts where claude.ai's "**Help improve our AI models**" setting is ON, conversations through Claude Code / codiva may be used to improve Anthropic's models. Because codiva pushes a lot of code through parallel sessions, it shows a notice line in the startup header — **but only when it can determine that the setting is ON**.

```
⚠ Training-data usage is ON (conversations may be used to improve models)
  Change it: https://claude.ai/settings/data-privacy-controls
```

- Change the setting at that URL (or with Claude Code's `/privacy-settings`). **codiva never modifies your account settings** (read-only).
- Detection goes "cache in `~/.claude.json` → query the same API Claude Code uses", in that order, and never delays startup. When it can't tell (not signed in, API usage such as `ANTHROPIC_API_KEY`, offline, an upstream change) **nothing is shown**.
- After you turn the setting off, the warning is gone on the next launch (the API is re-checked even if the cache still says ON).
- The query uses Claude Code's OAuth token read-only (the `Claude Code-credentials` Keychain entry on macOS, `~/.claude/.credentials.json` elsewhere). If you'd rather it didn't, set `"privacyWarning": false` and codiva touches neither the Keychain nor the network.

### Repo-wide instructions (`.codiva/prompt.md`)

Whatever you write in the target repository's `.codiva/prompt.md` is injected into the systemPrompt of every session started in that repository. It lets a team share repository-specific workflow ("run the tests and open a PR when you're done", …) — usable alongside `CLAUDE.md`, independently of it. With no such file, nothing is injected and behaviour is unchanged.

Besides editing the file directly, typing **`/prompt`** in the list view's composer opens an in-TUI editor seeded with the current contents (`Enter` saves, `Shift+Enter` inserts a newline, `Esc` cancels, saving an empty buffer deletes the file). Saved content applies to **subsequently created sessions** (running sessions keep the instructions they started with).

Type `/` in the composer to see the available slash commands in a palette (`/prompt`, `/config`, `/model`, `/agent` (list = pick the default / detail = switch that session), `/login` (sign in from inside codiva), `/sync`, `/fix-ci`, `/recover`, `/remove`, `/clear`, `/update`, `/help`, …). On a short terminal the tail folds into "N more", so keep typing to narrow it down (`/help` shows everything).

### Changing settings from the UI (`/config`)

Typing **`/config`** (alias `/settings`) in the list view's composer opens a dialog for toggling the on/off keys in `~/.codiva/config.json`.

| Key | Action |
|---|---|
| `↑` `↓` | Select an item (a one-line description of the selected item appears below) |
| `Enter` / `Space` | Toggle it on / off (`[x]` / `[ ]`). A `Space` typed with a Japanese IME on (full-width space) toggles too |
| `Esc` | Close |

Toggles are **saved to `~/.codiva/config.json` immediately** (there's no cancel; items returned to their default value have their key removed, so the config file only ever holds what you changed from the defaults). These settings are read at startup and baked into sessions and terminal setup, though, so **they take effect on the next launch** (the dialog says so as well).

The items shown are: desktop notifications / mouse support / follow origin / auto-create PRs / auto base-merge on conflict / auto CI-fix requests / Claude Code plugin loading / the training-data warning / the startup update check / crash logs / Codex network access — 11 in total. Multiple-choice settings (`language`, `ignoredFiles`, `codexSandbox`, …) aren't in the dialog, so edit the config file for those (`model` and the default agent are changed via `/model` and `/agent`).

### Removing sessions (`x` / `/remove` / `/clear`)

There are three ways to clean up sessions still in the list (all of them ask `y` / `n` first).

| Action | Target | What's removed |
|---|---|---|
| `d` (discard) | The selected session | The worktree and branch. **The row stays in the list as "discarded"** (it's gone after a restart) |
| `x` (= `/remove`) | The selected session | The worktree and branch **plus the list row itself**. The record goes too |
| `/clear` | **Every** finished session (completed, interrupted, failed, …; running ones are skipped) | Each session's worktree and branch plus its list row. Shows the count before running |

`x` also works in the detail view (`Tab` over to the action panel). Since a removed session can no longer be opened, you're returned to the list automatically.

**Reach for `x` when you want to clean up sessions tied to old PRs.** With `d` (discard) the row stays as "discarded", and if that branch's PR is conflicting or its CI is failing it keeps showing up as a candidate for `Ctrl+F` (bulk recovery). `x` removes the row entirely, so it's fully out of scope for bulk actions.

All three only delete the local worktree and branch — **pushed remote branches and PRs on GitHub are untouched** (close the PR on GitHub if you want that). Deletion is forced even with uncommitted changes present, so commit anything you want to keep first.

Even if you forget the slash, **input that exactly matches a command name available on that screen** (`exit`, `help`, …) runs as that command. When it will, the command palette shows it, so you know what `Enter` is about to do. Anything with trailing text (`fix how exit behaves`) and aliases like `?` or `changes` are treated as ordinary instructions, so an instruction never turns into a command by accident.

**`/exit` means different things on different screens.** In the list view it quits codiva; in the session detail view it **closes the detail view and returns to the list** (same as `Esc`), so you can't accidentally kill the app by typing `/exit` while reading a session.

## Troubleshooting

### Scrolling after exit types a flood of characters

While full-screen, codiva enables the terminal's **mouse reporting** (click and drag notifications).
It always disables it on a normal exit, but if codiva is **killed outright** (an out-of-memory abort,
`kill -9`, or any death that leaves the process no chance to run code), the disable never happens and
the terminal stays in that mode. Scrolling then makes the terminal keep sending mouse positions, which
the shell sees as a flood of input like `[<64;12;5M`.

Run either of these to recover (both are safe and can be repeated):

```bash
codiva --reset-terminal   # restore terminal modes (mouse capture, alternate screen, cursor)
reset                     # the generic full terminal reset
```

codiva also **disables mouse reporting automatically at the next startup** before drawing anything,
so simply relaunching codiva fixes it too.

### Investigating a sudden exit

Because codiva draws on the alternate screen, errors from an abnormal exit vanish the moment it
leaves that screen. So the reason is written to `~/.codiva/logs/`.

| File | Contents |
|---|---|
| `crash-<timestamp>-<pid>.log` | The report codiva writes itself (kind, error message, stack trace, version, terminal, **memory usage**, session status breakdown). The 20 most recent are kept |
| `report.<timestamp>.<pid>....json` | Node's diagnostic report. On **out-of-memory (heap exhaustion) or a native crash** no JavaScript can run, so the log above isn't written and only this one appears |

- On an unexpected exit the same content and the log path are also printed to the terminal (after restoring the screen, so it doesn't disappear).
- Exits via `SIGTERM` / `SIGHUP` are recorded as `kind: signal` too (to distinguish "it crashed" from "it was told to quit").
- Set `"crashLog": false` in the config to stop writing them.
- Reporting problems is very welcome → [Issues](https://github.com/takecchi/codiva/issues). `crash-*.log` contains only the technical information listed above — no instructions and no code.
  - `report.*.json` (written by Node) may include environment variables. codiva excludes them automatically on Node versions that support it (23.3+), but **older Node versions do include env vars such as `ANTHROPIC_API_KEY`**, so check the contents before sharing.

### Memory usage grows over long runs (fixed in 0.3.9)

Up to 0.3.8 there was a bug where **every render left memory that was never freed** (in a little under a
day it reached Node's default ~4GB heap limit and exited abruptly with
`Allocation failed - JavaScript heap out of memory`. That kind of death leaves no `crash-*.log`, only
`report.*.json`). The cause was React running in its development build, which accumulates measurement
entries (`performance.measure`) on every render. 0.3.9 switches to the production build (which also made
rendering about 2.5× faster) and additionally discards measurement entries periodically.

If usage still grows on 0.3.9 or later, please report it at
[Issues](https://github.com/takecchi/codiva/issues) with `~/.codiva/logs/report.*.json` attached.

### Old lines disappear from the detail log

The session detail log keeps **the most recent 2,000 entries / 400,000 characters total** and drops
anything older (a single extremely long entry is truncated with a trailing `…`). Holding an unbounded
log from a long-running session would make codiva itself run out of memory, and the complete record of
the conversation lives in each agent's own CLI (`~/.claude/projects/` for Claude Code).

Note that when new lines are appended **while you're scrolled up reading** a log that has hit this
limit, the view shifts slightly toward the newer end by however many lines were dropped (and any
selection is cleared, for safety).

## Development

```bash
npm run dev        # start the TUI with tsx (development)
npm test           # vitest (with coverage)
npm run lint       # biome check
npm run typecheck  # tsc --noEmit
npm run build      # tsup → dist/index.js (launcher shim) + dist/main-<hash>.js (the app)
```

See [`docs/`](./docs) for design documents ([PRD](./docs/PRD.md) / [ARCHITECTURE](./docs/ARCHITECTURE.md) / [TECH_NOTES](./docs/TECH_NOTES.md)).

Coding conventions live in [`.claude/rules/`](./.claude/rules) (layering, naming, i18n, Ink, the session domain, SDK integration, git/IO, testing), and step-by-step procedures for routine work such as adding a slash command are in [`.claude/skills/`](./.claude/skills).
The overall index and the "what I want to do → which file to touch" map is in [`CLAUDE.md`](./CLAUDE.md).

> The documentation is authored in Japanese first; [README.ja.md](./README.ja.md) is the source of truth, and `docs/` and `.claude/` are Japanese-only for now.

## Releases

Publishing to npm uses **npm Trusted Publishing (OIDC)** and happens tokenlessly from GitHub Actions. Publishing a Release on GitHub is enough to run version syncing, the npm publish and the version-bump commit to main automatically. See [`docs/RELEASE.md`](./docs/RELEASE.md) for the first-time setup on GitHub and npm.

## License

[MIT](./LICENSE)
