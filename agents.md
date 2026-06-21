# agents.md — Extending pi-provider-fallback

This document guides AI agents and developers on extending and maintaining the pi-provider-fallback extension.

## Architecture Overview

The extension is a single **factory function** (exported as default from `provider-fallback.ts`) that receives the `ExtensionAPI` at load time. It:

1. **Loads config** from a JSON sidecar (`~/.pi/agent/extensions/provider-fallback.json`)
2. **Captures session lifecycle** via `session_start` / `session_shutdown` hooks
3. **Watches for failures** via `agent_end` event
4. **Classifies errors** (transient vs quota vs ignore)
5. **Manages fallback state** (pointer, lastUserContent, exhausted flag)
6. **Swaps models** and **re-issues prompts** on eligible failures
7. **Provides status visibility** via `/fallback` command

## Key Safety Invariants

These invariants **must be preserved** across all changes:

### 1. Forward-only pointer
- `pointer` starts at `-1` (user's primary model)
- Only ever **increases**: `pointer = next` in the chain walk
- Never wraps or resets during a session
- **Why**: prevents infinite fallback loops, ensures progress toward exhaustion

### 2. Exhaustion latch
- `exhausted = true` is set exactly once, when the chain is fully walked
- After exhaustion, all `agent_end` handlers are skipped (`if (!config.enabled || exhausted) return`)
- Prevents repeat "chain exhausted" notifications and spurious re-issues
- **Why**: one-shot notification, then silent stop

### 3. Original model restoration
- `originalModel` is captured at `session_start` from `ctx.model`
- Lazily captured on first fallback if session_start missed it
- **Always** restored at `session_shutdown` unless auth fails
- **Why**: prevents on-disk default from being permanently left on a fallback target

### 4. Error classification
- Only `stopReason === "error"` triggers fallback (not `"aborted"`, `"length"`, `"toolUse"`)
- Only `transient` + `quota` buckets trigger fallback (not `ignore` including context-overflow)
- **Why**: respects user aborts, doesn't interfere with compaction or other terminal cases

### 5. Re-issue guard
- `lastUserContent` must be defined before re-issue (`if (lastUserContent === undefined) return`)
- Captured via `message_end` with `role === "user"` filter
- **Why**: prevents null/undefined crashes, ensures we have a prompt to re-issue

## Code Structure

```
provider-fallback.ts
├── Imports + types (ChainEntry, FallbackConfig, Bucket)
├── loadConfig() — reads JSON, filters malformed entries, returns {enabled, chain}
├── classify(errorMessage) — regex classify into transient|quota|ignore
├── factory function (pi: ExtensionAPI)
│   ├── State init (config, originalModel, pointer, lastUserContent, exhausted)
│   ├── session_start hook — load config, capture original model
│   ├── session_shutdown hook — restore original model, warn on auth failure
│   ├── message_end hook — capture last user prompt
│   ├── agent_end hook — classify error, walk chain, swap + re-issue
│   └── registerCommand("fallback") — status display
```

## Common Extension Points

### 1. Changing the error classifier

**Location**: `classify()` function and `TRANSIENT_RE` / `QUOTA_RE` regexes

**When**: New provider error messages don't match existing regexes, or need to add a new bucket (e.g., "rate limit" not caught)

**How to extend**:
```ts
// Add new regex or pattern
const RATE_LIMIT_RE = /rate.?limit|too.?many.?requests|429/i;

// Expand classify to check new patterns
function classify(errorMessage: string | undefined): Bucket {
	if (!errorMessage) return "ignore";
	if (QUOTA_RE.test(errorMessage)) return "quota";
	if (TRANSIENT_RE.test(errorMessage)) return "transient";
	if (RATE_LIMIT_RE.test(errorMessage)) return "rate-limit"; // new bucket
	return "ignore";
}

// Update agent_end handler to treat new bucket same as transient
if (bucket === "ignore") return;
```

**Caution**: Do NOT create a new bucket without also updating the `Bucket` type and the `agent_end` handler's classification checks.

### 2. Adding per-model configuration

**Location**: `ChainEntry` interface

**When**: Users want to tune fallback behavior per model (e.g., max retries, backoff delay, cost limits)

**How to extend**:
```ts
interface ChainEntry {
	provider: string;
	model: string;
	thinking?: string;
	maxRetries?: number;        // new: skip after N failures
	backoffMs?: number;         // new: wait before re-issue
	costLimit?: number;         // new: skip if over budget
}

// Then in agent_end, check these on each swap:
if (entry.maxRetries && retryCount >= entry.maxRetries) continue;
if (entry.backoffMs) await new Promise(r => setTimeout(r, entry.backoffMs));
```

**Caution**: Adding new config fields doesn't require changing the on-disk schema, but document them in `provider-fallback.example.json`.

### 3. Adding fallback metrics / observability

**Location**: End of `agent_end` handler, or a new `session_shutdown` section

**When**: Need to track fallback frequency, success rate, or cost across sessions

**How to extend**:
```ts
interface FallbackMetrics {
	swapsAttempted: number;
	swapsSucceeded: number;
	chainsExhausted: number;
}

const metrics: FallbackMetrics = { swapsAttempted: 0, swapsSucceeded: 0, chainsExhausted: 0 };

// In agent_end, after a successful swap:
metrics.swapsSucceeded++;

// In agent_end, at exhaustion:
metrics.chainsExhausted++;

// In session_shutdown, persist metrics somewhere (file / API / etc.)
```

**Caution**: Don't break the silent-disable path (return early if not enabled).

### 4. Changing the re-issue strategy

**Location**: `agent_end` handler, the `pi.sendUserMessage` call

**When**: Need to avoid transcript duplication, batch re-issues, or use a different prompt

**How to extend**:
```ts
// Current: re-issue immediately, polluting transcript
if (ctx.isIdle()) {
	pi.sendUserMessage(lastUserContent);
} else {
	pi.sendUserMessage(lastUserContent, { deliverAs: "followUp" });
}

// Alternative: queue for explicit user approval
ctx.ui.notify("Retry on next message? (yes/no)");
// (would need a command handler to process approval)
```

**Caution**: Any change to re-issue timing or method affects whether the transcript shows duplicates. Test manually.

### 5. Adding session persistence

**Location**: `session_shutdown` hook, or a new persistence module

**When**: Want to restore pointer position across pi restarts

**How to extend**:
```ts
interface SessionState {
	pointer: number;
	exhausted: boolean;
	timestamp: number;
}

function saveSessionState(state: SessionState) {
	const path = join(homedir(), ".pi", "agent", "extensions", ".provider-fallback-state.json");
	writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

function loadSessionState(): SessionState | null {
	try {
		const path = join(homedir(), ".pi", "agent", "extensions", ".provider-fallback-state.json");
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

pi.on("session_start", async (_event, ctx) => {
	// Restore pointer/exhausted from prior session (if any)
	const saved = loadSessionState();
	if (saved) {
		pointer = saved.pointer;
		exhausted = saved.exhausted;
	}
});

pi.on("session_shutdown", async (_event, ctx) => {
	// Save current pointer/exhausted state
	saveSessionState({ pointer, exhausted, timestamp: Date.now() });
	// ... rest of shutdown
});
```

**Caution**: Persisting pointer means `/reload` won't reset it. Consider a flag like `--reset-fallback` to clear state.

## Testing Patterns

### Unit-testable functions

These are pure and easily unit-testable (though the codebase currently lacks tests):

- `loadConfig(json)` — given JSON, return {enabled, chain} or {enabled: false}
- `classify(errorMessage)` — given error string, return bucket

### Manual testing checklist

(See README.md for the full list)

**Quick smoke test**:
```bash
# Load extension without error
pi -e ~/.pi/agent/extensions/provider-fallback.ts --list-models >/dev/null

# Check config is found
grep -q 'enabled' ~/.pi/agent/extensions/provider-fallback.json
```

**Integration test** (requires api key for a secondary provider):
1. Add a secondary model to the chain that will fail
2. Trigger a real request (e.g., via `/ask`)
3. Wait for the primary to fail
4. Observe the fallback notification and re-issue
5. Verify the response came from the secondary model

## Debugging Tips

### Config not loading
- Check file path: `~/.pi/agent/extensions/provider-fallback.json` (not a typo)
- Check JSON syntax: `node -e "JSON.parse(require('fs').readFileSync(...))"`
- Check permissions: `ls -la ~/.pi/agent/extensions/provider-fallback.json`

### Extension not loading
```bash
# Check syntax
npx tsc --noEmit provider-fallback.ts

# Check installed pi version matches API
npm ls @earendil-works/pi-coding-agent
```

### Pointer not advancing
- Check the `agent_end` handler is being reached (`grep "agent_end" provider-fallback.ts`)
- Check error classification: `classify()` must return `"transient"` or `"quota"`, not `"ignore"`
- Check chain entry is resolvable: `ctx.modelRegistry.find(provider, model)` must not return undefined

### Exhaustion not triggering
- Check the for-loop walks all entries: `for (let next = pointer + 1; next < config.chain.length; next++)`
- Check every entry either resolves or skips (missing auth, duplicate primary, etc.)

### Restored model not persisting
- Check `session_shutdown` is being called (pi is exiting cleanly, not crashed)
- Check `originalModel` was captured (`pointer === -1 && !originalModel && ctx.model`)
- Check restore model is still registered: `ctx.modelRegistry.find(...)` must not return undefined

## Future Improvements

### High-value
1. **Automated unit tests** for `classify()` and chain-walk logic (currently deferred per plan)
2. **Persistent session state** — restore pointer/exhausted across pi restarts
3. **Per-model cost tracking** — skip models over daily/monthly budget
4. **Exponential backoff** — avoid re-issuing immediately after a provider failure

### Medium-value
1. **Metrics export** — export fallback frequency/success to observability tool
2. **User approval gate** — require `/confirm` before re-issuing (avoid transcript bloat)
3. **Conditional chains** — different fallback chain per prompt type or cost tier
4. **Provider health check** — skip models known to be down without re-issuing

### Lower-value (research first)
1. **Scoped-models integration** — read host `--models` order instead of extension config (requires API change in pi)
2. **Non-persisting swap** — use a session-local model override without disk write (requires API change in pi)
3. **Interleaved re-issue** — detect host retry and swap mid-backoff instead of after (requires hooking into internals)

## Common Pitfalls

### Pitfall: Breaking the forward-only pointer
**Bad**: `pointer = -1` on success or `/reload`
**Good**: Pointer only increases, session is sticky, only `/restart` resets it

### Pitfall: Silent auth failures
**Bad**: `pi.setModel(model)` returns `false` and handler doesn't check
**Good**: `if (!ok) continue;` to skip the entry and advance the pointer

### Pitfall: Exhaustion loop
**Bad**: Forgetting to set `exhausted = true`, so `agent_end` re-issues infinitely
**Good**: After the for-loop completes with no swap, `exhausted = true` is set once

### Pitfall: Losing lastUserContent
**Bad**: `message_end` handler only captures some messages (e.g., missing role check)
**Good**: Explicitly check `role === "user"` before assigning

### Pitfall: On-disk fallback trap
**Bad**: Forgetting to restore original model on shutdown, so next session starts on fallback
**Good**: `session_shutdown` always restores if `originalModel` exists

## References

- **PI Extension API**: `@earendil-works/pi-coding-agent/docs/extensions.md`
- **Extension examples**: `@earendil-works/pi-coding-agent/examples/extensions/`
- **Host retry logic**: `agent-session.js:1963` (quota regex) / `:1980` (transient regex)
- **Implementation plan**: `.rpiv/artifacts/plans/2026-06-20_21-29-00_provider-fallback.md`
- **Code review**: `.rpiv/artifacts/reviews/2026-06-20_23-51-09_provider-fallback.md`

## Distribution & Installation

### For Local Testing

Install from your local project folder:
```bash
pi install ~/Tools/applications/pi/extensions/pi-provider-fallback
```

Or test without installing:
```bash
pi -e ~/Tools/applications/pi/extensions/pi-provider-fallback
```

### Publishing to npm

1. **Update version** in `package.json`
2. **Push to git** (github/gitlab/etc.)
3. **Publish to npm**:
   ```bash
   npm login
   npm publish
   ```
4. **Users can then install**:
   ```bash
   pi install npm:pi-provider-fallback
   # or scoped:
   pi install npm:@yourname/pi-provider-fallback
   ```

### Publishing to git (GitHub, GitLab, etc.)

1. **Create repo** on GitHub/GitLab and push this folder
2. **Tag a release**:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. **Users can install**:
   ```bash
   pi install git:github.com/yourname/pi-provider-fallback
   # or with version:
   pi install git:github.com/yourname/pi-provider-fallback@v0.1.0
   ```

### Package Manifest

The `package.json` includes a `pi` field that declares what this package provides:

```json
"pi": {
  "extensions": ["./provider-fallback.ts"]
}
```

This tells `pi install` to load `provider-fallback.ts` as an extension. You can also add:
- `"skills": ["./skills/**/*.ts"]` — skill files
- `"prompts": ["./prompts/**/*.md"]` — prompt templates
- `"themes": ["./themes/**/*.json"]` — theme definitions

The `pi-package` keyword makes the package discoverable in the [pi package gallery](https://pi.dev/packages).

### Install Methods

After publishing, users can install via:

| Method | Command | Notes |
|--------|---------|-------|
| **Local path** | `pi install ~/path/to/pi-provider-fallback` | For development |
| **npm** | `pi install npm:pi-provider-fallback` | After publishing to npm |
| **npm (scoped)** | `pi install npm:@user/pi-provider-fallback` | Recommended for personal pkgs |
| **GitHub HTTPS** | `pi install https://github.com/user/pi-provider-fallback` | No auth needed |
| **GitHub SSH** | `pi install git:git@github.com:user/pi-provider-fallback` | Requires SSH keys |
| **Git shorthand** | `pi install git:github.com/user/pi-provider-fallback@v0.1.0` | With pinned version tag |
| **Temporary** | `pi -e npm:pi-provider-fallback` | Try without installing |

### GitHub Release Workflow

Recommended for managing versions:

```bash
# Bump version in package.json
vi package.json  # e.g., 0.1.0 → 0.2.0

# Commit and tag
git add package.json
git commit -m "Bump version to 0.2.0"
git tag v0.2.0
git push
git push origin v0.2.0

# Create GitHub release (optional, for visibility)
# https://github.com/user/pi-provider-fallback/releases/new
```

Users can then pin to that version:
```bash
pi install git:github.com/user/pi-provider-fallback@v0.2.0
```

## Maintenance Checklist

When making changes:

- [ ] Preserve the three safety invariants (forward-only pointer, exhaustion latch, model restoration)
- [ ] Update `TRANSIENT_RE` / `QUOTA_RE` in comments if regexes change
- [ ] Test the new feature manually (smoke test + integration test if adding behavior)
- [ ] Update `provider-fallback.example.json` if new config fields are added
- [ ] Update this file if new extension points or pitfalls emerge
- [ ] Run `tsc --noEmit` to catch type errors
- [ ] Verify the extension still loads: `pi -e provider-fallback.ts --list-models >/dev/null`
- [ ] Bump version in `package.json` before publishing
- [ ] Tag release in git: `git tag v<version> && git push origin v<version>`
