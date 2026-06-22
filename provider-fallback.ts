/**
 * pi-provider-fallback — Cross-provider model fallback with an interactive TUI config.
 *
 * On a terminal transient / quota / model-unavailable error, swaps the active model
 * to the next configured fallback (same provider first, then other providers) and
 * re-issues the failed prompt. Sticky for the session; original model restored on exit.
 *
 * Config: `/fallback-config` (interactive TUI). View: `/fallback-status`.
 * Stored at ~/.pi/agent/extensions/provider-fallback.json
 * (override with PI_PROVIDER_FALLBACK_CONFIG).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	visibleWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";

const CONFIG_PATH = process.env["PI_PROVIDER_FALLBACK_CONFIG"] ??
	join(homedir(), ".pi", "agent", "extensions", "provider-fallback.json");

interface ProviderConfig {
	enabled: boolean;
	fallbacks: Array<{ model: string; priority: 1 | 2 }>;
}

interface FallbackConfig {
	enabled: boolean;
	providers: Record<string, ProviderConfig>;
}

function loadConfig(): FallbackConfig {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<FallbackConfig>;
		return {
			enabled: parsed.enabled !== false && Object.keys(parsed.providers ?? {}).length > 0,
			providers: parsed.providers ?? {},
		};
	} catch {
		return { enabled: false, providers: {} };
	}
}

function saveConfig(config: FallbackConfig): void {
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
	} catch (err) {
		console.error(`[fallback] failed to save config: ${err}`);
	}
}

const TRANSIENT_RE =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;
const QUOTA_RE =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;
// Model unavailable / not found — 404, not_found_error, "is not available", "model not found".
// A perfect fallback trigger: the requested model can't serve, so switch.
const UNAVAILABLE_RE =
	/404|not_found_error|not[ _]found|is not available|model.?not.?available|does not exist|no such model|unsupported model|invalid model/i;

type Bucket = "transient" | "quota" | "unavailable" | "ignore";

function classify(errorMessage: string | undefined): Bucket {
	if (!errorMessage) return "ignore";
	if (QUOTA_RE.test(errorMessage)) return "quota";
	if (UNAVAILABLE_RE.test(errorMessage)) return "unavailable";
	if (TRANSIENT_RE.test(errorMessage)) return "transient";
	return "ignore";
}

// ponytail: self-check for classify(); run with `npx tsx provider-fallback.ts --selfcheck`
if (process.argv.includes("--selfcheck")) {
	const assert = (c: boolean, m: string) => {
		if (!c) throw new Error("selfcheck failed: " + m);
	};
	assert(classify('404 {"type":"not_found_error","message":"Claude Fable 5 is not available"}') === "unavailable", "fable-5 404");
	assert(classify("overloaded") === "transient", "overloaded");
	assert(classify("Monthly usage limit reached") === "quota", "quota");
	assert(classify("context length exceeded") === "ignore", "ignore");
	assert(classify(undefined) === "ignore", "undefined");
	console.log("✓ classify selfcheck passed");
	process.exit(0);
}

export default function (pi: ExtensionAPI) {
	let config: FallbackConfig = { enabled: false, providers: {} };
	let originalModel: { provider: string; id: string } | undefined;
	let fallbackState: Record<string, number> = {};
	let lastUserContent: Parameters<ExtensionAPI["sendUserMessage"]>[0] | undefined;

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();

		// Capture the user's true default ONCE per real session. A stage-driven
		// newSession (rpiv model-override, subagents) re-fires session_start carrying
		// an override model; re-capturing would make that override the restore target,
		// and setModel persists it as the global default. Cleared in session_shutdown.
		const current = ctx.model;
		if (!originalModel && current && typeof current.provider === "string" && typeof current.id === "string") {
			originalModel = { provider: current.provider, id: current.id };
		}

		if (config.enabled) {
			const issues: string[] = [];
			for (const [provider, cfg] of Object.entries(config.providers)) {
				if (!cfg.enabled || cfg.fallbacks.length === 0) continue;
				for (const fb of cfg.fallbacks) {
					const model = ctx.modelRegistry.find(provider, fb.model);
					if (!model) {
						issues.push(`${provider}/${fb.model}`);
					}
				}
			}
			if (issues.length > 0) {
				ctx.ui.notify(
					`[fallback] ${issues.length} configured model(s) not found: ${issues.join(", ")}. Run /fallback-config to fix.`,
					"warning",
				);
			}
		}

		fallbackState = {};
		for (const provider of Object.keys(config.providers)) {
			fallbackState[provider] = -1;
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!originalModel) return;
		const current = ctx.model;
		if (current && current.provider === originalModel.provider && current.id === originalModel.id) {
			originalModel = undefined; // already at baseline; clear so next real session re-captures
			return;
		}
		const restore = ctx.modelRegistry.find(originalModel.provider, originalModel.id);
		if (restore) {
			const ok = await pi.setModel(restore);
			if (!ok) {
				ctx.ui.notify(
					`[fallback] could not restore ${originalModel.provider}/${originalModel.id}. Check API keys or run /fallback-config.`,
					"warning",
				);
			}
		}
		originalModel = undefined; // clear so the next real session_start re-captures fresh
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "user") {
			lastUserContent = event.message.content;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!config.enabled) return;

		const last = [...event.messages].reverse().find((m) => m.role === "assistant");
		if (!last || last.role !== "assistant" || last.stopReason !== "error") return;

		const bucket = classify(last.errorMessage);
		if (bucket === "ignore") return;
		if (lastUserContent === undefined) return;

		const current = ctx.model;
		if (!current) return;

		const failed = `${current.provider}/${current.id}`;
		const providerCfg = config.providers[current.provider];
		if (!providerCfg || !providerCfg.enabled || providerCfg.fallbacks.length === 0) {
			return tryOtherProviders(ctx, failed, bucket);
		}

		const idx = fallbackState[current.provider] ?? -1;
		for (let next = idx + 1; next < providerCfg.fallbacks.length; next++) {
			const entry = providerCfg.fallbacks[next]!;
			const model = ctx.modelRegistry.find(current.provider, entry.model);
			if (!model) continue;
			if (model.id === current.id) continue;

			const ok = await pi.setModel(model);
			if (!ok) continue;

			fallbackState[current.provider] = next;
			ctx.ui.notify(
				`[fallback] ${failed} failed (${bucket}) → ${current.provider}/${entry.model}`,
				"warning",
			);
			retryAfterMaybeCompacting(ctx, current, model, `${current.provider}/${entry.model}`);
			return;
		}

		return tryOtherProviders(ctx, failed, bucket);
	});

	function retryLastUserMessage(ctx: any) {
		if (lastUserContent === undefined) return;
		if (ctx.isIdle()) {
			pi.sendUserMessage(lastUserContent);
		} else {
			pi.sendUserMessage(lastUserContent, { deliverAs: "followUp" });
		}
	}

	function retryAfterMaybeCompacting(ctx: any, fromModel: any, toModel: any, target: string) {
		const fromWindow = typeof fromModel?.contextWindow === "number" ? fromModel.contextWindow : undefined;
		const toWindow = typeof toModel?.contextWindow === "number" ? toModel.contextWindow : undefined;
		const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
		const tokens = typeof usage?.tokens === "number" ? usage.tokens : undefined;
		const reserveTokens = 16_384;
		const needsCompaction =
			fromWindow !== undefined &&
			toWindow !== undefined &&
			fromWindow > toWindow &&
			tokens !== undefined &&
			tokens > Math.max(0, toWindow - reserveTokens);

		if (!needsCompaction || typeof ctx.compact !== "function") {
			retryLastUserMessage(ctx);
			return;
		}

		ctx.ui.notify(
			`[fallback] compacting before retry: ${tokens}/${toWindow} tokens for ${target}`,
			"warning",
		);
		ctx.compact({
			customInstructions: `Preserve details needed to continue after fallback to ${target}.`,
			onComplete: () => {
				ctx.ui.notify(`[fallback] compaction complete → retrying on ${target}`, "info");
				retryLastUserMessage(ctx);
			},
			onError: (error: Error) => {
				ctx.ui.notify(`[fallback] compaction failed: ${error.message}. Retrying anyway.`, "warning");
				retryLastUserMessage(ctx);
			},
		});
	}

	async function tryOtherProviders(ctx: any, failed: string, bucket: Bucket) {
		const current = ctx.model;
		if (!current) return;

		const enabledProviders = Object.entries(config.providers)
			.filter(([p, cfg]) => cfg.enabled && cfg.fallbacks.length > 0 && p !== current.provider)
			.sort((a, b) => {
				const aAvail = a[1].fallbacks.filter((fb) => ctx.modelRegistry.find(a[0], fb.model)).length;
				const bAvail = b[1].fallbacks.filter((fb) => ctx.modelRegistry.find(b[0], fb.model)).length;
				return bAvail - aAvail;
			});

		for (const [provider, cfg] of enabledProviders) {
			for (let i = 0; i < cfg.fallbacks.length; i++) {
				const entry = cfg.fallbacks[i]!;
				const model = ctx.modelRegistry.find(provider, entry.model);
				if (!model) continue;

				const ok = await pi.setModel(model);
				if (!ok) continue;

				fallbackState[provider] = i;
				ctx.ui.notify(
					`[fallback] ${failed} failed (${bucket}) → ${provider}/${entry.model}`,
					"warning",
				);
				retryAfterMaybeCompacting(ctx, current, model, `${provider}/${entry.model}`);
				return;
			}
		}

		ctx.ui.notify(
			`[fallback] no fallback available. Configure /fallback-config.`,
			"error",
		);
	}

	pi.registerCommand("fallback-config", {
		description: "Configure provider fallback chains (Enter to configure, Esc to back/close)",
		handler: async (_args, ctx) => {
			let modifiedConfig: FallbackConfig | undefined;
			await ctx.ui.custom(
				(_tui, theme, _kb, done) => {
					const component = new FallbackConfigComponent(
						ctx,
						config,
						theme,
						(resultConfig: FallbackConfig) => {
							modifiedConfig = resultConfig;
							done(undefined);
						},
					);
					return component;
				},
				{ overlay: true },
			);

			if (modifiedConfig) {
				config = modifiedConfig;
				saveConfig(config);
				ctx.ui.notify("[fallback] config saved", "info");
			}
		},
	});

	pi.registerCommand("fallback-status", {
		description: "Show current fallback configuration",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			lines.push("[fallback] Status:");

			if (!config.enabled) {
				lines.push("  Disabled — no providers configured");
				lines.push("");
				lines.push("  Run /fallback-config to set up fallbacks");
			} else {
				lines.push("");
				for (const [provider, cfg] of Object.entries(config.providers)) {
					const status = cfg.enabled ? "enabled" : "disabled";
					lines.push(`  ${provider} [${status}]`);
					if (cfg.enabled && cfg.fallbacks.length > 0) {
						for (const fb of cfg.fallbacks) {
							const exists = ctx.modelRegistry.find(provider, fb.model) ? "✓" : "✗";
							lines.push(`    [${fb.priority}] ${fb.model} ${exists}`);
						}
					}
					lines.push("");
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

class FallbackConfigComponent implements Component, Focusable {
	focused = false;
	theme: any = {};
	done: (config: FallbackConfig) => void = () => {};

	private ctx: ExtensionCommandContext;
	private config: FallbackConfig;
	private providers: string[] = [];
	private selectedProviderIdx = 0;
	private selectedModelIdx: Record<string, number> = {};
	private inProviderMenu = false;

	constructor(
		ctx: ExtensionCommandContext,
		config: FallbackConfig,
		theme: any,
		done: (config: FallbackConfig) => void,
	) {
		this.ctx = ctx;
		this.config = JSON.parse(JSON.stringify(config));
		this.theme = theme;
		this.done = done;

		// Only show providers that have at least one available model
		const allProviders = new Set<string>();

		// Add configured providers
		for (const p of Object.keys(config.providers)) {
			allProviders.add(p);
		}

		// Add providers that have available models
		const candidateProviders = [
			"anthropic",
			"openai",
			"openai-codex",
			"google",
			"deepseek",
			"cohere",
		];
		const testModels: Record<string, string[]> = {
			anthropic: ["claude-opus-4-8", "claude-opus-4-6"],
			openai: ["gpt-4-turbo", "gpt-4o"],
			"openai-codex": ["gpt-5.5", "gpt-5.4"],
			google: ["gemini-2.5-flash", "gemini-2.0-flash"],
			deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
			cohere: ["command-r-plus"],
		};
		for (const provider of candidateProviders) {
			const models = testModels[provider] ?? [];
			const hasAvailable = models.some((m: string) => ctx.modelRegistry.find(provider, m));
			if (hasAvailable) {
				allProviders.add(provider);
			}
		}

		this.providers = Array.from(allProviders).sort();

		for (const p of this.providers) {
			if (!this.config.providers[p]) {
				this.config.providers[p] = { enabled: false, fallbacks: [] };
			}
			this.selectedModelIdx[p] = 0;
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.inProviderMenu) {
				this.inProviderMenu = false;
			} else {
				this.done(this.config);
			}
			return;
		}

		if (!this.inProviderMenu) {
			// Provider list
			if (matchesKey(data, "up")) {
				this.selectedProviderIdx = Math.max(0, this.selectedProviderIdx - 1);
			} else if (matchesKey(data, "down")) {
				this.selectedProviderIdx = Math.min(this.providers.length - 1, this.selectedProviderIdx + 1);
			} else if (matchesKey(data, "return")) {
				this.inProviderMenu = true;
			}
		} else {
			// Provider menu
			const provider = this.providers[this.selectedProviderIdx];
			const cfg = this.config.providers[provider]!;
			const models = this.getKnownModels(provider);

			if (matchesKey(data, "up")) {
				this.selectedModelIdx[provider] = Math.max(0, this.selectedModelIdx[provider] - 1);
			} else if (matchesKey(data, "down")) {
				this.selectedModelIdx[provider] = Math.min(models.length - 1, this.selectedModelIdx[provider] + 1);
			} else if (data === "e") {
				cfg.enabled = !cfg.enabled;
				if (!cfg.enabled) cfg.fallbacks = [];
				// Auto-save
				this.config.enabled = Object.values(this.config.providers).some(
					(p) => p.enabled && p.fallbacks.length > 0,
				);
			} else if (data === "1" || data === "2") {
				const priority = parseInt(data) as 1 | 2;
				const selectedModel = models[this.selectedModelIdx[provider]];
				if (selectedModel) {
					cfg.fallbacks = cfg.fallbacks.filter((f) => f.model !== selectedModel);
					cfg.fallbacks.push({ model: selectedModel, priority });
					cfg.fallbacks.sort((a, b) => a.priority - b.priority);
					cfg.enabled = true;
					// Auto-save
					this.config.enabled = true;
				}
			} else if (matchesKey(data, "space")) {
				const selectedModel = models[this.selectedModelIdx[provider]];
				if (selectedModel) {
					const existing = cfg.fallbacks.find((f) => f.model === selectedModel);
					if (existing) {
						cfg.fallbacks = cfg.fallbacks.filter((f) => f.model !== selectedModel);
					} else {
						cfg.fallbacks.push({
							model: selectedModel,
							priority: cfg.fallbacks.length === 0 ? 1 : 2,
						});
						cfg.enabled = true;
					}
					// Auto-save
					this.config.enabled = Object.values(this.config.providers).some(
						(p) => p.enabled && p.fallbacks.length > 0,
					);
				}
			}
		}
	}

	render(width: number): string[] {
		const w = Math.min(width, 90);
		const lines: string[] = [];
		const border = this.theme.fg?.("border", "─".repeat(w - 2)) ?? "─".repeat(w - 2);
		const pad = (s: string, len: number = w - 2) => {
			const vis = visibleWidth(s);
			return s + " ".repeat(Math.max(0, len - vis));
		};

		if (!this.inProviderMenu) {
			// Provider list
			lines.push(this.theme.fg?.("border", "┌" + border + "┐") ?? "┌" + border + "┐");
			lines.push(
				(this.theme.fg?.("border", "│") ?? "│") +
				pad(this.theme.fg?.("accent", " ⚙ Fallback Configuration") ?? " ⚙ Fallback Configuration", w - 2) +
				(this.theme.fg?.("border", "│") ?? "│"),
			);
			lines.push(
				(this.theme.fg?.("border", "│") ?? "│") +
				pad(this.theme.fg?.("dim", " Select a provider to configure") ?? " Select a provider to configure", w - 2) +
				(this.theme.fg?.("border", "│") ?? "│"),
			);
			lines.push(this.theme.fg?.("border", "├" + border + "┤") ?? "├" + border + "┤");

			for (let i = 0; i < this.providers.length; i++) {
				const p = this.providers[i]!;
				const cfg = this.config.providers[p]!;
				const isSelected = i === this.selectedProviderIdx;
				const marker = isSelected ? "▶" : " ";
				const status = cfg.enabled ? (this.theme.fg?.("success", "✓") ?? "✓") : (this.theme.fg?.("error", "✗") ?? "✗");
				const line = `${marker} ${p.padEnd(18)} ${status}  [Enter]`;

				lines.push(
					(this.theme.fg?.("border", "│") ?? "│") +
					pad(
						isSelected ? (this.theme.fg?.("accent", line) ?? line) : line,
						w - 2,
					) +
					(this.theme.fg?.("border", "│") ?? "│"),
				);
			}

			lines.push(this.theme.fg?.("border", "├" + border + "┤") ?? "├" + border + "┤");
			lines.push(
				(this.theme.fg?.("border", "│") ?? "│") +
				pad(this.theme.fg?.("dim", "↑↓ navigate  •  Enter: configure  •  Esc: close") ?? "↑↓ navigate  •  Enter: configure  •  Esc: close", w - 2) +
				(this.theme.fg?.("border", "│") ?? "│"),
			);
			lines.push(this.theme.fg?.("border", "└" + border + "┘") ?? "└" + border + "┘");
		} else {
			// Provider menu
			const provider = this.providers[this.selectedProviderIdx];
			const cfg = this.config.providers[provider]!;
			const models = this.getKnownModels(provider);

			lines.push(this.theme.fg?.("border", "┌" + border + "┐") ?? "┌" + border + "┐");
			lines.push(
				(this.theme.fg?.("border", "│") ?? "│") +
				pad(
					this.theme.fg?.("accent", ` ${provider} [${cfg.enabled ? "enabled" : "disabled"}]`) ?? ` ${provider} [${cfg.enabled ? "enabled" : "disabled"}]`,
					w - 2,
				) +
				(this.theme.fg?.("border", "│") ?? "│"),
			);
			lines.push(
				(this.theme.fg?.("border", "│") ?? "│") +
				pad(this.theme.fg?.("dim", " Mark up to 2 models as fallback preferences") ?? " Mark up to 2 models as fallback preferences", w - 2) +
				(this.theme.fg?.("border", "│") ?? "│"),
			);
			lines.push(this.theme.fg?.("border", "├" + border + "┤") ?? "├" + border + "┤");

			const selectedIdx = this.selectedModelIdx[provider] ?? 0;
			for (let j = 0; j < Math.min(models.length, 10); j++) {
				const model = models[j]!;
				const isSelected = j === selectedIdx;
				const fb = cfg.fallbacks.find((f) => f.model === model);
				const priority = fb ? `[${fb.priority}]` : "[ ]";
				const marker = isSelected ? "→" : " ";
				const line = `${marker} ${model.padEnd(22)} ${priority}`;

				lines.push(
					(this.theme.fg?.("border", "│") ?? "│") +
					pad(
						isSelected ? (this.theme.fg?.("accent", line) ?? line) : line,
						w - 2,
					) +
					(this.theme.fg?.("border", "│") ?? "│"),
				);
			}

			if (models.length > 10) {
				lines.push(
					(this.theme.fg?.("border", "│") ?? "│") +
					pad(this.theme.fg?.("dim", `... and ${models.length - 10} more`) ?? `... and ${models.length - 10} more`, w - 2) +
					(this.theme.fg?.("border", "│") ?? "│"),
				);
			}

			lines.push(this.theme.fg?.("border", "├" + border + "┤") ?? "├" + border + "┤");
			lines.push(
				(this.theme.fg?.("border", "│") ?? "│") +
				pad(
					this.theme.fg?.("dim", "↑↓ navigate  •  1/2: priority  •  Space: toggle") ?? "↑↓ navigate  •  1/2: priority  •  Space: toggle",
					w - 2,
				) +
				(this.theme.fg?.("border", "│") ?? "│"),
			);
			lines.push(
				(this.theme.fg?.("border", "│") ?? "│") +
				pad(
					this.theme.fg?.("dim", "e: enable/disable  •  Esc: back") ?? "e: enable/disable  •  Esc: back",
					w - 2,
				) +
				(this.theme.fg?.("border", "│") ?? "│"),
			);
			lines.push(this.theme.fg?.("border", "└" + border + "┘") ?? "└" + border + "┘");
		}

		return lines;
	}

	invalidate(): void {
		// Clear any caches
	}

	private getKnownModels(provider: string): string[] {
		// Comprehensive list of candidate models to check
		const candidateModels: Record<string, string[]> = {
		anthropic: [
			"claude-opus-4-8",
			"claude-opus-4-7",
			"claude-opus-4-6",
			"claude-opus-4-5",
			"claude-sonnet-4-6",
			"claude-sonnet-4-5",
			"claude-haiku-4-5",
		],
		openai: [
			"gpt-4-turbo",
			"gpt-4o",
			"gpt-4o-mini",
		],
		"openai-codex": [
			"gpt-5.5",
			"gpt-5.4",
			"gpt-5.4-mini",
			"gpt-5.3-codex-spark",
		],
		google: [
			"gemini-3.5-flash",
			"gemini-2.5-flash",
			"gemini-2.0-flash",
			"gemini-2.5-pro",
			"gemma-4-31b-it",
		],
		deepseek: [
			"deepseek-v4-pro",
			"deepseek-v4-flash",
		],
		cohere: [
			"command-r-plus",
			"command-r",
		],
	};

		const configuredModels = this.config.providers[provider]?.fallbacks.map((f) => f.model) ?? [];
		const candidates = candidateModels[provider] ?? [];
		const allArray = Array.from(new Set<string>([...candidates, ...configuredModels]));

		// Filter to only models that actually exist in the registry
		const available: string[] = [];
		for (const model of allArray) {
			if (this.ctx.modelRegistry.find(provider, model)) {
				available.push(model);
			}
		}

		// If no models found in registry, return candidates anyway (so user can see options)
		return available.length > 0 ? available.sort() : allArray.sort();
	}
}
