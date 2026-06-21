# pi-provider-fallback

Cross-provider model fallback extension for [pi](https://github.com/earendil-works/pi-coding-agent).

Watches for terminal transient/quota errors and automatically swaps the active model to the next entry in a user-configured fallback chain, then re-issues the failed prompt. The fallback is sticky for the session and the original model is restored on shutdown.

## Setup

1. Clone or install this extension
2. Copy `provider-fallback.example.json` to `~/.pi/agent/extensions/provider-fallback.json`
3. Edit the `chain` with your preferred fallback providers/models
4. Restart pi

## Config

`~/.pi/agent/extensions/provider-fallback.json`:
```json
{
  "enabled": true,
  "chain": [
    { "provider": "anthropic", "model": "claude-opus-4-6", "thinking": "high" },
    { "provider": "openai", "model": "gpt-5" },
    { "provider": "google", "model": "gemini-3-pro" }
  ]
}
```

Each chain entry:
- `provider` (string, required): provider id (e.g. `anthropic`, `openai`, `google`)
- `model` (string, required): model id (e.g. `claude-opus-4-6`, `gpt-5`)
- `thinking` (string, optional): thinking level to set on swap (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`)

## Usage

The extension is enabled when the config is present and `enabled: true`.

**When to fallback:**
- Transient errors (provider overloaded, rate-limited, network error, 5xx)
- Quota/usage-limit errors

**When NOT to fallback:**
- Context-overflow (compaction owns this)
- Other errors

**Commands:**
- `/fallback` — show chain, active model, and current position

## Behavior

```
anthropic/claude-opus-4-6 fails (overloaded)
↓ (host backs off same-model, still fails)
↓ extension swaps to openai/gpt-5 and re-issues:

[fallback] anthropic/claude-opus-4-6 failed (transient) → openai/gpt-5 (2/3)

openai/gpt-5 fails (quota limit reached)
↓
[fallback] openai/gpt-5 failed (quota) → google/gemini-3-pro (3/3)

google/gemini-3-pro fails
↓
[fallback] chain exhausted (3/3) — staying on google/gemini-3-pro
```

## Architecture Notes

**Pure extension:** survives pi package updates. No compiled-dist edits.

**Compromises:**
- Fallback order = extension config (host `--models` scoped order not exposed to extensions)
- Each swap persists the default to disk; mitigated by capturing the original model at session start and restoring it on shutdown
- Fallback fires only after the host's same-model backoff completes (host retry seam is internal)

**Safety invariants:**
- Forward-only pointer (never wraps)
- Exhaustion latch (exactly one "chain exhausted" notice, then no-op)
- Original model restoration on shutdown (unless auth expires)

## Testing

Manual checklist (automated unit tests not shipped, matching sibling extensions in pi):

- [ ] With no `provider-fallback.json`, pi starts normally and extension is inert
- [ ] After adding config, extension loads without error (check with `/reload`)
- [ ] Transient failure → shows fallback notice and re-runs on chain[0]
- [ ] Quota failure → swaps to next entry
- [ ] All entries failing → exactly one "chain exhausted" notice, no infinite loop
- [ ] Context-overflow → does NOT trigger fallback
- [ ] Subsequent turns after fallback → stay on fallback model (sticky)
- [ ] Shutdown → original model restored (check settings)
- [ ] `/fallback` command → shows chain, active model, position marker

## Type-checking

Requires TypeScript 5.0+:
```bash
npx tsc --noEmit --esModuleInterop --module nodenext --moduleResolution nodenext provider-fallback.ts
```

## License

MIT
