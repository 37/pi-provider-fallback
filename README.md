# pi-provider-fallback

Cross-provider model fallback for [pi](https://github.com/earendil-works/pi-coding-agent), with an interactive TUI config.

When the active model hits a terminal **transient**, **quota**, or **model-unavailable** error, the extension swaps to the next configured fallback model — trying the **same provider first**, then other providers — and re-issues the failed prompt. The swap is sticky for the session; the original model is restored on shutdown.

## Setup

```bash
pi -e ./provider-fallback.ts          # quick test
# or drop into ~/.pi/agent/extensions/ for auto-discovery + /reload
```

Then configure interactively in pi:

```
/fallback-config      # interactive TUI — set fallback models per provider
/fallback-status      # view current config
```

No JSON editing required. The TUI only shows providers/models actually present in your registry (`pi --list-models`).

## TUI controls

Provider list:
- `↑↓` navigate · `Enter` configure provider · `Esc` close

Provider menu:
- `↑↓` navigate models · `1`/`2` set priority · `Space` toggle · `e` enable/disable provider · `Esc` back

Changes auto-save on every action.

## How fallback works

On an eligible error for `providerA/modelX`:
1. Try `providerA`'s other configured fallbacks (priority 1, then 2).
2. If exhausted, try other enabled providers' fallbacks.
3. If nothing is available: `[fallback] no fallback available`.

The pointer is forward-only per session (never retries an already-failed fallback).

## Error classification

| Bucket | Triggers fallback | Examples |
|--------|-------------------|----------|
| transient | yes | overloaded, rate-limit, 429/5xx, network/timeout |
| quota | yes | usage limit, billing, insufficient quota |
| unavailable | yes | 404 not_found, "model is not available", invalid model |
| ignore | no | context overflow, user abort |

## Config

Stored at `~/.pi/agent/extensions/provider-fallback.json` (override with `PI_PROVIDER_FALLBACK_CONFIG`). Managed by the TUI — see `provider-fallback.example.json` for the shape.

## Testing fallback

Set your default model to `anthropic/claude-fable-5` (always 404s) and send a prompt. You should see:

```
[fallback] anthropic/claude-fable-5 failed (unavailable) → anthropic/claude-opus-4-8
```

Self-check the classifier: `npx tsx provider-fallback.ts --selfcheck`

## License

MIT
