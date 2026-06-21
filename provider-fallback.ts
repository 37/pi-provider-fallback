/**
 * provider-fallback — cross-provider model fallback for pi.
 *
 * Watches `agent_end` for terminal transient/quota errors and swaps the active
 * model to the next entry in a user-configured fallback chain, then re-issues the
 * failed prompt. Sticky for the session; the original model is restored on exit.
 *
 * SETUP: copy provider-fallback.example.json to provider-fallback.json (same dir)
 * and edit the `chain`. A missing or invalid config disables the extension silently.
 *
 * Compromises (pure-extension limits): the fallback order is this config list (the
 * host scoped-models list is not exposed to extensions); each swap persists the
 * default to disk and is restored on shutdown; fallback fires only after the host's
 * own same-model backoff completes.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "provider-fallback.json");

interface ChainEntry {
	provider: string;
	model: string;
	thinking?: string;
}

interface FallbackConfig {
	enabled: boolean;
	chain: ChainEntry[];
}

function loadConfig(): FallbackConfig {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<FallbackConfig>;
		const chain = Array.isArray(parsed.chain)
			? parsed.chain.filter(
					(e): e is ChainEntry =>
						!!e && typeof e.provider === "string" && typeof e.model === "string",
				)
			: [];
		return { enabled: parsed.enabled !== false && chain.length > 0, chain };
	} catch {
		// Missing or malformed config → extension disabled, no error.
		return { enabled: false, chain: [] };
	}
}

// Errors that warrant swapping providers: transient (overload/rate-limit/5xx/network)
// OR quota/usage-limit. Regexes lifted verbatim from the host classifier in
// agent-session.js (transient _isRetryableError :1980, quota
// _isNonRetryableProviderLimitError :1963).
const TRANSIENT_RE =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;
const QUOTA_RE =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

// Valid thinking levels — a config typo is skipped rather than blind-cast.
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type Bucket = "transient" | "quota" | "ignore";

function classify(errorMessage: string | undefined): Bucket {
	if (!errorMessage) return "ignore";
	// Context-overflow is owned by compaction and matches NEITHER regex below, so it
	// naturally returns "ignore" — swapping providers never shrinks context.
	if (QUOTA_RE.test(errorMessage)) return "quota";
	if (TRANSIENT_RE.test(errorMessage)) return "transient";
	return "ignore";
}

export default function (pi: ExtensionAPI) {
	let config: FallbackConfig = { enabled: false, chain: [] };
	// The model the user started the session with (captured for restore-on-exit).
	let originalModel: { provider: string; id: string } | undefined;

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		const current = ctx.model;
		if (current) {
			originalModel = { provider: current.provider, id: current.id };
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// pi.setModel persists the default to disk; restore the user's original model
		// so the on-disk preference is not left pointing at a fallback target.
		if (!originalModel) return;
		const current = ctx.model;
		if (current && current.provider === originalModel.provider && current.id === originalModel.id) {
			return; // never swapped — nothing to restore
		}
		const restore = ctx.modelRegistry.find(originalModel.provider, originalModel.id);
		if (restore) {
			const ok = await pi.setModel(restore);
			if (!ok) {
				ctx.ui.notify(
					`[fallback] could not restore ${originalModel.provider}/${originalModel.id} on exit — the on-disk default is left on the fallback model`,
					"warning",
				);
			}
		}
	});

	// Index into config.chain of the current active fallback target. -1 = still on
	// the user's primary. Forward-only; never resets (sticky-for-session).
	let pointer = -1;
	// Most recent user prompt, captured for re-issue after a swap.
	let lastUserContent: Parameters<ExtensionAPI["sendUserMessage"]>[0] | undefined;
	// Set once the whole chain is exhausted; makes subsequent failures a no-op.
	let exhausted = false;

	pi.on("message_end", async (event) => {
		if (event.message.role === "user") {
			lastUserContent = event.message.content;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!config.enabled || exhausted) return;

		const last = [...event.messages].reverse().find((m) => m.role === "assistant");
		if (!last || last.role !== "assistant" || last.stopReason !== "error") return;

		const bucket = classify(last.errorMessage);
		if (bucket === "ignore") return;
		if (lastUserContent === undefined) return; // nothing to re-issue

		const failed = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "current model";
		// Lazily capture the primary if session_start missed it (model resolved late).
		// At pointer === -1 ctx.model is still the user's primary (no swap yet this run).
		if (pointer === -1 && !originalModel && ctx.model) {
			originalModel = { provider: ctx.model.provider, id: ctx.model.id };
		}
		for (let next = pointer + 1; next < config.chain.length; next++) {
			const entry = config.chain[next];
			const model = ctx.modelRegistry.find(entry.provider, entry.model);
			if (!model) continue; // unknown model id — skip
			// Don't re-issue on the model that just failed.
			if (ctx.model && model.provider === ctx.model.provider && model.id === ctx.model.id) continue;
			const ok = await pi.setModel(model);
			if (!ok) continue; // missing/expired auth — skip to next entry
			pointer = next;
			if (entry.thinking && (THINKING_LEVELS as readonly string[]).includes(entry.thinking)) {
				pi.setThinkingLevel(entry.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
			}
			ctx.ui.notify(
				`[fallback] ${failed} failed (${bucket}) → ${entry.provider}/${entry.model} (${next + 1}/${config.chain.length})`,
				"warning",
			);
			// Re-issue the failed prompt on the new model. sendUserMessage throws if the
			// agent is mid-stream, so send plainly when idle, else queue as a follow-up.
			if (ctx.isIdle()) {
				pi.sendUserMessage(lastUserContent);
			} else {
				pi.sendUserMessage(lastUserContent, { deliverAs: "followUp" });
			}
			return;
		}

		// No eligible entry left — chain exhausted. Notify once, then no-op.
		exhausted = true;
		ctx.ui.notify(
			`[fallback] chain exhausted (${config.chain.length}/${config.chain.length}) — staying on ${failed}`,
			"error",
		);
	});

	pi.registerCommand("fallback", {
		description: "Show provider-fallback status (chain, active model, position)",
		handler: async (_args, ctx) => {
			if (!config.enabled) {
				ctx.ui.notify(
					"[fallback] disabled — create ~/.pi/agent/extensions/provider-fallback.json with a non-empty chain",
					"info",
				);
				return;
			}
			const active = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
			const pos = pointer < 0 ? "primary" : `chain[${pointer + 1}]`;
			// One multi-line string through ctx.ui.notify — no raw console.log (corrupts the TUI).
			const lines = config.chain.map((e, i) => {
				const here = i === pointer ? "→" : " ";
				const missing = ctx.modelRegistry.find(e.provider, e.model) ? "" : " (?)";
				return `  ${here} ${i + 1}. ${e.provider}/${e.model}${e.thinking ? ` :${e.thinking}` : ""}${missing}`;
			});
			ctx.ui.notify(
				[
					`[fallback] active ${active} (${pos})${exhausted ? " — exhausted" : ""}`,
					...lines,
				].join("\n"),
				"info",
			);
		},
	});
}
