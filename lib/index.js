import { createRequire } from "node:module";
import fs from "node:fs";

function resolveDshTools() {
	const tryLoad = (basePath) => {
		try {
			const real = fs.realpathSync(basePath);
			const req = createRequire(real);
			return req("@deepseek-ai/dsh-tools");
		} catch (e) {
			return null;
		}
	};

	for (const arg of process.argv) {
		if (arg) {
			const mod = tryLoad(arg);
			if (mod) return mod;
		}
	}

	const candidates = [
		"/usr/local/bin/dsh",
		process.execPath,
		process.cwd(),
	];
	for (const c of candidates) {
		const mod = tryLoad(c);
		if (mod) return mod;
	}
	throw new Error("Unable to locate @deepseek-ai/dsh-tools in current runtime environment");
}

const { defineTool } = resolveDshTools();

/**
 * Resolve an optional dependency from the DSH installation that mounted this plugin.
 */
function resolveOptionalDependency(name) {
	const tryLoad = (basePath) => {
		try {
			return createRequire(fs.realpathSync(basePath))(name);
		} catch (e) {
			return null;
		}
	};
	for (const arg of process.argv) {
		if (!arg) continue;
		const mod = tryLoad(arg);
		if (mod) return mod;
	}
	for (const c of ["/usr/local/bin/dsh", process.execPath, process.cwd()]) {
		const mod = tryLoad(c);
		if (mod) return mod;
	}
	return null;
}

const sharp = resolveOptionalDependency("sharp");

const MAX_DELIVERED_LONG_EDGE = 1302;
const DELIVERED_JPEG_QUALITY = 92;

function planScreenshotDelivery(width, height) {
	const longEdge = Math.max(width, height);
	let divisor = 1;
	while (longEdge / divisor > MAX_DELIVERED_LONG_EDGE) divisor += 1;
	return {
		divisor,
		width: Math.max(1, Math.round(width / divisor)),
		height: Math.max(1, Math.round(height / divisor)),
	};
}

function factorText(value) {
	return String(Number(value.toFixed(4)));
}

function screenshotScaleText(delivery) {
	if (!delivery) {
		return "Screenshot captured, but it could not be downscaled to a size the vision pipeline passes through untouched, so it may have been rescaled before you saw it. Read the image dimensions disclosed with this result and convert with x_display = x_image * displayW / imageW; do not assume the image is 1:1.";
	}
	const how = delivery.divisor > 1 ? `downscaled 1/${delivery.divisor}` : "not downscaled";
	return `Screenshot captured. Display ${delivery.displayWidth}x${delivery.displayHeight} delivered as ${delivery.width}x${delivery.height} (${how}), a size the vision pipeline passes through untouched, so these are exactly the pixels you see. Convert any pixel you read off the image into mobile(action: "click", coordinate: [x_display, y_display]) with x_display = x_image * ${factorText(delivery.scaleX)} and y_display = y_image * ${factorText(delivery.scaleY)}. If the image dimensions disclosed with this result differ from ${delivery.width}x${delivery.height}, trust that disclosure instead and use x_display = x_image * displayW / imageW.`;
}

const SERVER_BASE = process.env.AGENT_VD_SERVER || "http://127.0.0.1:3070";

/**
 * Drop system-chrome windows (status bar, navigation bar, notification shade, and the
 * ColorOS smart sidebar) from every tree observation.
 *
 * Why this is ON by default: the physical display carries that chrome and the virtual
 * display carries none of it, so the SAME app screen produced two different trees
 * depending on which display happened to be the target. Measured on the Settings app,
 * display 0, unfiltered vs filtered: windows 4 -> 2, total 27 -> 19, and every node that
 * disappeared was status-bar chrome (clock, battery, signal, WLAN icon). `.settings`
 * itself kept all 19 of its real controls, so system APPS are untouched — the test is on
 * the window's OWNER package, never on a node's package.
 *
 * Set AGENT_NO_SYSTEM_UI=0 to restore the unfiltered tree without touching the server;
 * the server also still honours a plain request with no query parameter, so this switch
 * is the only place the behaviour is chosen.
 */
const DROP_SYSTEM_UI = (process.env.AGENT_NO_SYSTEM_UI || "1") !== "0";
const DUMP_UI_PATH = DROP_SYSTEM_UI ? "/api/dump_ui?no_system_ui=1" : "/api/dump_ui";

async function postJson(path, body, signal) {
	const resp = await fetch(`${SERVER_BASE}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`HTTP ${resp.status} on ${path}: ${text}`);
	}
	return await resp.json();
}

async function getJson(path) {
	const resp = await fetch(`${SERVER_BASE}${path}`);
	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`HTTP ${resp.status} on ${path}: ${text}`);
	}
	return await resp.json();
}

/** Capture screenshot as attachment, using sharp downscaling when available. */
async function captureScreenshotAttachment(ctx) {
	const resp = await fetch(`${SERVER_BASE}/api/screenshot`);
	if (!resp.ok) {
		const errText = await resp.text();
		return { message: `Screenshot failed (HTTP ${resp.status}): ${errText}` };
	}
	let mediaType = (resp.headers.get("content-type") || "image/png").split(";")[0].trim();
	if (mediaType !== "image/jpeg") mediaType = "image/png";
	let buf = Buffer.from(await resp.arrayBuffer());
	let delivery;
	try {
		const meta = sharp ? await sharp(buf).metadata() : null;
		if (meta && meta.width > 0 && meta.height > 0) {
			const plan = planScreenshotDelivery(meta.width, meta.height);
			if (plan.divisor > 1) {
				buf = await sharp(buf)
					.resize({ width: plan.width, height: plan.height, fit: "fill" })
					.jpeg({ quality: DELIVERED_JPEG_QUALITY })
					.toBuffer();
			}
			delivery = {
				displayWidth: meta.width,
				displayHeight: meta.height,
				width: plan.width,
				height: plan.height,
				divisor: plan.divisor,
				scaleX: meta.width / plan.width,
				scaleY: meta.height / plan.height,
			};
		}
	} catch (_) {
		delivery = undefined;
	}
	if (delivery && delivery.divisor > 1) mediaType = "image/jpeg";

	const attachments = ctx.get("attachments");
	if (attachments) {
		const ref = await attachments.saveImage({
			data: buf,
			mediaType,
			name: mediaType === "image/jpeg" ? "mobile_screenshot.jpg" : "mobile_screenshot.png",
		});
		return {
			message: screenshotScaleText(delivery),
			attachment: ref,
		};
	}
	return {
		message: `${screenshotScaleText(delivery)} The attachment service is unavailable, so the image is not in your context.`,
	};
}

/** Capture accessibility hierarchy dump string. */
async function captureUiDump() {
	try {
		const resp = await fetch(`${SERVER_BASE}${DUMP_UI_PATH}`);
		const text = await resp.text();
		try {
			const data = JSON.parse(text);
			if (data && data.success === false) {
				const reason = data.message || "the gateway refused the dump";
				return `${reason}\n${data.data || ""}`;
			}
			if (data && typeof data.data === "string") {
				const notice = data.notice ? `${data.notice}\n` : "";
				const head = data.message ? `${data.message}\n` : "";
				return `${notice}${head}${data.data}`;
			}
		} catch (_) {}
		return text;
	} catch (err) {
		return `Error dumping UI hierarchy: ${err.message}`;
	}
}

/**
 * Detect transient empty tree:
 * 1. tree_blocked=1: window exists, but root was empty (firstWindows > 0 && firstSize == 0).
 * 2. no_windows=1: zero windows returned during Activity transition.
 * 3. total=0: 0 actionable or 0 total elements.
 * 4. foreground display: only status bar/system chrome (act_sent <= 2) while main app is transitioning.
 */
function isTransientEmptyTree(text) {
	if (!text || typeof text !== "string") return true;

	// 1. 常规空树特征：包含无窗口、树受阻、总节点为0、或应用节点为0
	if (/tree_blocked=1|no_windows=1|\btotal=0\b|\bapp_nodes=0\b|tree 0 nodes/i.test(text)) return true;

	// 2. 前台物理屏特有特征：只有系统状态栏/侧边栏（可操作节点 <= 2 个）
	if (text.includes("mode=foreground") && /\bact_sent=[0-2]\b/.test(text)) {
		return true; // 说明前台只有时钟和灵动岛，主应用还在转场中，自动退避重试！
	}

	return false;
}

/** Capture accessibility hierarchy dump string, with auto-retry on transient empty trees. */
async function captureUiDumpWithRetry(maxRetries = 2, delayMs = 600) {
	let lastText = "";
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		lastText = await captureUiDump();
		if (!isTransientEmptyTree(lastText)) {
			return lastText;
		}
		if (attempt < maxRetries) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	return lastText;
}

/** Unified observation: returns dump_ui text or visual screenshot. */
async function captureObservation(obsMode, ctx) {
	if (obsMode === "visual") {
		return await captureScreenshotAttachment(ctx);
	}
	const text = await captureUiDumpWithRetry();
	return { message: text };
}

/** Execute action and append observation to build a single-turn action-observation loop. */
async function executeActionAndObserve(headerText, actionNotice, obsMode, ctx) {
	const obs = await captureObservation(obsMode, ctx);
	const notice = actionNotice ? `${actionNotice}\n` : "";
	return {
		message: `${notice}[${headerText}]\n\n${obs.message}`,
		...(obs.attachment ? { attachment: obs.attachment } : {}),
	};
}

export const name = "mobile-use-plugin";
export const inject = ["tools"];

export function apply(ctx) {
	// 1. mobile: Unified screen interaction and perception tool
	ctx.tools.register(defineTool({
		name: "mobile",
		description: "Interact with and observe the mobile device. Every physical action (click, swipe, type, key, wait, launch_app) automatically captures and returns the updated screen state (UI hierarchy tree by default, or visual screenshot). Call action='observe' to inspect the screen without moving.",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"observe",
					"click",
					"swipe",
					"type",
					"key",
					"wait",
					"launch_app",
					"list_apps",
					"switch_mode",
					"status",
				],
				description: "Action to perform on device. 'observe': refresh and view current screen state without touching.",
			},
			coordinate: {
				type: "array",
				items: { type: "integer" },
				description: "[x, y] coordinates in display pixels for click (tap/long-press), or starting coordinates for swipe.",
			},
			end_coordinate: {
				type: "array",
				items: { type: "integer" },
				description: "[x2, y2] ending coordinates in display pixels for swipe.",
			},
			x: {
				type: "integer",
				description: "Optional direct X coordinate in display pixels for click or swipe start.",
			},
			y: {
				type: "integer",
				description: "Optional direct Y coordinate in display pixels for click or swipe start.",
			},
			x2: {
				type: "integer",
				description: "Optional direct ending X coordinate in display pixels for swipe.",
			},
			y2: {
				type: "integer",
				description: "Optional direct ending Y coordinate in display pixels for swipe.",
			},
			text: {
				type: "string",
				description: "Text to type; key name ('BACK', 'HOME', 'ENTER') for key; package name for launch_app; app query for list_apps; or mode ('foreground'|'background') for switch_mode.",
			},
			activity: {
				type: "string",
				description: "Optional Activity class for launch_app (e.g. '.ui.LauncherUI'). Omit to launch the package's default launcher activity.",
			},
			target: {
				type: "string",
				description: "Optional node ID from dump tree (e.g. '146') for direct input. Omit to type into focused field.",
			},
			duration_ms: {
				type: "integer",
				description: "Duration in milliseconds for long-press click, swipe, or wait.",
			},
			mode: {
				type: "string",
				enum: ["tree", "visual"],
				description: "Observation mode: 'tree' (default, returns structured accessibility UI dump) or 'visual' (returns screenshot image).",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					message: { type: "string" },
				},
			},
			render: (_args, val) => {
				const blocks = [{ type: "text", text: val.message }];
				if (val.attachment) {
					blocks.push({ type: "image", attachment: val.attachment });
				}
				return blocks;
			},
		},
		async execute(args) {
			const obsMode = args.mode || "tree";

			switch (args.action) {
				case "observe": {
					const obs = await captureObservation(obsMode, ctx);
					return {
						message: `[Observed screen state]\n\n${obs.message}`,
						...(obs.attachment ? { attachment: obs.attachment } : {}),
					};
				}

				case "click": {
					const x = args.coordinate?.[0] ?? args.x;
					const y = args.coordinate?.[1] ?? args.y;
					if (x == null || y == null) {
						return { message: "Error: action 'click' requires coordinates: coordinate: [x, y] (or x and y)." };
					}
					const payload = { x: Math.round(x), y: Math.round(y) };
					if (typeof args.duration_ms === "number" && args.duration_ms > 0) {
						payload.duration_ms = args.duration_ms;
					}
					try {
						const res = await postJson("/api/click", payload);
						if (!res.success) {
							return { message: `Click failed at (${x}, ${y}): ${res.message || "unknown error"}` };
						}
						const actionDesc = payload.duration_ms
							? `OK: Long-pressed (${x}, ${y}) for ${payload.duration_ms}ms`
							: `OK: Tapped (${x}, ${y})`;
						await new Promise((r) => setTimeout(r, 350));
						return await executeActionAndObserve(actionDesc, res.notice, obsMode, ctx);
					} catch (err) {
						return { message: `Click execution error: ${err.message}` };
					}
				}

				case "swipe": {
					const x1 = args.coordinate?.[0] ?? args.x;
					const y1 = args.coordinate?.[1] ?? args.y;
					const x2 = args.end_coordinate?.[0] ?? args.x2;
					const y2 = args.end_coordinate?.[1] ?? args.y2;
					if (x1 == null || y1 == null || x2 == null || y2 == null) {
						return { message: "Error: action 'swipe' requires coordinate: [x1, y1] and end_coordinate: [x2, y2]." };
					}
					const duration = args.duration_ms || 300;
					try {
						const res = await postJson("/api/swipe", {
							x1: Math.round(x1),
							y1: Math.round(y1),
							x2: Math.round(x2),
							y2: Math.round(y2),
							duration,
						});
						if (!res.success) {
							return { message: `Swipe failed: ${res.message || "unknown error"}` };
						}
						const actionDesc = `OK: Swiped (${x1}, ${y1}) -> (${x2}, ${y2}) in ${duration}ms`;
						await new Promise((r) => setTimeout(r, 200));
						return await executeActionAndObserve(actionDesc, res.notice, obsMode, ctx);
					} catch (err) {
						return { message: `Swipe execution error: ${err.message}` };
					}
				}

				case "type": {
					if (args.text === undefined || args.text === null) {
						return { message: "Error: action 'type' requires 'text' parameter." };
					}
					const payload = {
						text: String(args.text),
						target: args.target !== undefined ? String(args.target) : "focused",
					};
					try {
						const res = await postJson("/api/type", payload);
						if (!res.success) {
							return { message: `Text input failed: ${res.message || "unknown error"}` };
						}
						let resultText = "";
						if (typeof res.message === "string" && res.message.startsWith("{")) {
							try {
								const p = JSON.parse(res.message);
								const ev = [];
								if (p.bounds) ev.push(`node=${p.bounds}${p.vid ? ` ${p.vid}` : ""}`);
								if (p.before_text != null) ev.push(`before="${p.before_text}"`);
								if (p.verified_text != null) ev.push(`after="${p.verified_text}"`);
								const evStr = ev.length ? ` | ${ev.join(" · ")}` : "";
								if (p.ok && !p.error) {
									resultText = `Text injected [verified, cost=${p.cost_ms}ms]${evStr}`;
								} else if (p.ok && p.error === "verify_unavailable") {
									resultText = `Text injected, read-back unavailable (${p.reason || "unreadable"}) [cost=${p.cost_ms}ms]${evStr}`;
								} else {
									const why = {
										no_focused_input: `no focused input field (focus is on: ${p.focus_hint || "nothing"}) — click field first, then type without target`,
										target_not_found: `target not found (${p.reason || "no such id"})`,
										ambiguous_target: `target matches multiple nodes (${p.reason || ""})`,
										target_not_editable: `target is not editable (${p.reason || ""})`,
										inject_rejected: "the field rejected write (ACTION_SET_TEXT returned false)",
										verify_mismatch: "write was accepted but read-back differs from input",
										internal_error: `internal error: ${p.exception || "unknown"}`,
									}[p.error] || p.error || "unverified";
									resultText = `Type failed: ${why}${evStr}`;
								}
							} catch (_) {
								resultText = `Injected text: "${args.text}"`;
							}
						} else {
							resultText = `Injected text: "${args.text}"`;
						}
						await new Promise((r) => setTimeout(r, 200));
						return await executeActionAndObserve(`OK: ${resultText}`, res.notice, obsMode, ctx);
					} catch (err) {
						return { message: `Type execution error: ${err.message}` };
					}
				}

				case "key": {
					const keyName = args.text || args.key;
					if (!keyName) {
						return { message: "Error: action 'key' requires key name in 'text' parameter (e.g. 'BACK', 'HOME', 'ENTER')." };
					}
					try {
						const res = await postJson("/api/key", { key: String(keyName) });
						if (!res.success) {
							return { message: `Key injection failed: ${res.message || "unknown error"}` };
						}
						const actionDesc = `OK: Pressed key '${keyName}'`;
						const isNavKey = /^(BACK|HOME)$/i.test(String(keyName).trim());
						await new Promise((r) => setTimeout(r, isNavKey ? 350 : 200));
						return await executeActionAndObserve(actionDesc, res.notice, obsMode, ctx);
					} catch (err) {
						return { message: `Key execution error: ${err.message}` };
					}
				}

				case "wait": {
					const ms = Math.min(Math.max(args.duration_ms || 1000, 100), 10000);
					await new Promise((resolve) => setTimeout(resolve, ms));
					return await executeActionAndObserve(`OK: Waited for ${ms}ms`, null, obsMode, ctx);
				}

				case "launch_app": {
					const pkg = args.text || args.package;
					if (!pkg) {
						return { message: "Error: action 'launch_app' requires package name in 'text' (or 'package') parameter." };
					}
					try {
						const res = await postJson("/api/launch", {
							package: String(pkg),
							activity: args.activity || "",
						});
						if (!res.success) {
							return { message: `Launch failed: ${res.message || "unknown error"}` };
						}
						const actionDesc = `OK: Launched app ${pkg}${args.activity ? "/" + args.activity : ""}: ${res.message || "OK"}`;
						await new Promise((r) => setTimeout(r, 2000));
						return await executeActionAndObserve(actionDesc, res.notice, obsMode, ctx);
					} catch (err) {
						return { message: `Launch execution error: ${err.message}` };
					}
				}

				case "switch_mode": {
					const targetMode = args.text || args.mode || "background";
					try {
						const res = await postJson("/api/mode", { mode: targetMode });
						if (!res.success) {
							return { message: `Failed to switch mode: ${res.message || "unknown error"}` };
						}
						return { message: res.message || `Switched to ${res.mode} mode (Display ${res.target_display_id})` };
					} catch (err) {
						return { message: `Switch mode error: ${err.message}` };
					}
				}

				case "list_apps": {
					const query = args.text || args.query || "";
					try {
						const res = await postJson("/api/apps", { query });
						if (!res.success) {
							return { message: `Failed to list apps: ${res.message || "unknown error"}` };
						}
						return { message: res.data || "No launchable apps found." };
					} catch (err) {
						return { message: `List apps error: ${err.message}` };
					}
				}

				case "status": {
					try {
						const status = await getJson("/api/status");
						return { message: JSON.stringify(status, null, 2) };
					} catch (err) {
						return { message: `Error querying status: ${err.message}` };
					}
				}

				default:
					return { message: `Error: unknown action '${args.action}'. Supported: observe, click, swipe, type, key, wait, launch_app, list_apps, switch_mode, status.` };
			}
		},
	}));

	// 2. mobile_shell: Android root shell execution
	ctx.tools.register(defineTool({
		name: "mobile_shell",
		description: "Execute a root shell command in the Android system.",
		parameters: {
			command: {
				type: "string",
				required: true,
				description: "Shell command to execute.",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					exit_code: { type: "integer" },
					output: { type: "string" },
					success: { type: "boolean" },
				},
			},
			render: (_args, val) => [{
				type: "text",
				text: `[exit code: ${val.exit_code}]\n${val.output}`,
			}],
		},
		async execute(args) {
			const res = await postJson("/api/shell", { command: args.command });
			return res;
		},
	}));

	// Report tool execution events to Go gateway for real-time monitoring
	ctx.on("tools/execute", async (exec, next) => {
		try {
			const toolName = exec?.name || "tool";
			const rawArgs = exec?.arguments ?? exec?.args ?? exec?.input ?? {};
			let summary = "";
			try {
				if (typeof rawArgs === "object" && rawArgs !== null) {
					if (rawArgs.action) {
						summary = `[${rawArgs.action}]`;
						if (rawArgs.coordinate) summary += ` (${rawArgs.coordinate.join(",")})`;
						else if (rawArgs.x !== undefined && rawArgs.y !== undefined) summary += ` (${rawArgs.x},${rawArgs.y})`;
						if (rawArgs.text) summary += ` "${String(rawArgs.text).slice(0, 30)}"`;
					} else if (rawArgs.command) {
						summary = String(rawArgs.command).slice(0, 80);
					} else {
						summary = JSON.stringify(rawArgs).slice(0, 80);
					}
				} else if (typeof rawArgs === "string") {
					summary = rawArgs.slice(0, 80);
				}
			} catch (_) {}

			postJson("/api/task_event", {
				type: "tool_start",
				tool: toolName,
				summary,
				timestamp: Date.now(),
			}).catch(() => {});
		} catch (_) {}

		const startTime = Date.now();
		try {
			const res = await next();
			try {
				const duration = Date.now() - startTime;
				postJson("/api/task_event", {
					type: "tool_end",
					tool: exec?.name || "tool",
					success: true,
					duration_ms: duration,
					timestamp: Date.now(),
				}).catch(() => {});
			} catch (_) {}
			return res;
		} catch (err) {
			try {
				const duration = Date.now() - startTime;
				postJson("/api/task_event", {
					type: "tool_end",
					tool: exec?.name || "tool",
					success: false,
					error: err?.message || String(err),
					duration_ms: duration,
					timestamp: Date.now(),
				}).catch(() => {});
			} catch (_) {}
			throw err;
		}
	});

	// Auto status notification: sync todo_write progress silently to Android status bar (BigText style)
	ctx.on("tools/result", async (exec, result) => {
		try {
			const name = exec?.name;
			if (name === "todo_write") {
				const rawArgs = exec.arguments ?? exec.args ?? exec.input ?? {};
				const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
				const todos = args?.todos || [];
				if (!Array.isArray(todos) || todos.length === 0) return;

				const total = todos.length;
				const completed = todos.filter((t) => t.status === "completed").length;
				const inProgress = todos.find((t) => t.status === "in_progress");

				const isAllDone = completed === total;
				const title = "任务已经完成！";

				let header = "";
				if (isAllDone) {
					header = "所有任务均已执行完毕";
				} else if (inProgress) {
					const curTask = (inProgress.content || "").trim().replace(/\r?\n/g, " ");
					header = `当前执行: ${curTask}`;
				} else {
					header = "准备开始执行任务...";
				}

				const lines = todos.map((t, idx) => {
					const cleanContent = (t.content || "").trim().replace(/\r?\n/g, " ");
					if (t.status === "completed") {
						return `☑ ${idx + 1}. ${cleanContent}`;
					} else if (t.status === "in_progress") {
						return `◉ ${idx + 1}. ${cleanContent}`;
					} else {
						return `☐ ${idx + 1}. ${cleanContent}`;
					}
				});

				const divider = "────────────";
				const content = `${header}\n${divider}\n${lines.join("\n")}`;

				if (isAllDone) {
					cachedLastTodoSummary = {
						title: "任务已经完成！",
						content,
						total,
						completed,
					};
				}
			}
		} catch (err) {
			try {
				fs.appendFileSync("/tmp/agent_notify.log", `[${new Date().toISOString()}] Error: ${err?.stack || err}\n`);
			} catch (_) {}
		}
	});

	let lastCompletionNotifyTime = 0;
	let cachedLastTodoSummary = null;
	let lastUserPromptSummary = "";
	let lastAssistantMessage = "";

	ctx.on("session/event", (_session, event) => {
		try {
			if (event?.type === "user/message") {
				const text = event?.data?.content?.[0]?.text || event?.data?.text || "";
				if (text) {
					const clean = text.trim().replace(/\r?\n/g, " ");
					lastUserPromptSummary = clean.slice(0, 30);
				}
			} else if (event?.type === "assistant/message") {
				const contentBlocks = event?.data?.message?.content || [];
				const textBlocks = contentBlocks.filter((b) => b?.type === "text" && b?.text);
				const fullText = textBlocks.map((b) => b.text).join("\n").trim();
				if (fullText) {
					const clean = fullText
						.replace(/^#+\s+/gm, "")
						.replace(/\*\*([^*]+)\*\*/g, "$1")
						.replace(/`([^`]+)`/g, "$1")
						.trim();
					if (clean) {
						lastAssistantMessage = clean;
					}
				}
			}
		} catch (_) {}
	});

	// Reset to background & notify completion
	async function safeResetToBackground(reason, opts = {}) {
		try {
			const res = await postJson("/api/mode", { mode: "background" });
			fs.appendFileSync("/tmp/agent_notify.log", `[${new Date().toISOString()}] Reset to background triggered by: ${reason} (mode: ${res?.mode}, target_display_id: ${res?.target_display_id})\n`);
		} catch (err) {
			try {
				fs.appendFileSync("/tmp/agent_notify.log", `[${new Date().toISOString()}] Failed to reset to background (${reason}): ${err?.message || err}\n`);
			} catch (_) {}
		}

		if (opts.notify === true) {
			const now = Date.now();
			if (now - lastCompletionNotifyTime > 1500) {
				lastCompletionNotifyTime = now;
				try {
					const title = opts.title || "任务已经完成！";
					const subtext = opts.subtext || "";
					const content = opts.content || "所有执行事项均已处理完毕";
					const total = typeof opts.total === "number" ? opts.total : 0;
					const completed = typeof opts.completed === "number" ? opts.completed : 0;
					const sessionId = opts.sessionId || opts.session_id || "";

					await postJson("/api/notify", {
						title,
						subtext,
						content,
						tag: "dsh_agent",
						session_id: sessionId,
						total,
						completed,
						is_completed: true,
					});
					fs.appendFileSync("/tmp/agent_notify.log", `[${new Date().toISOString()}] Sent completion notification via reset signal: ${title} (subtext: ${subtext})\n`);
				} catch (err) {
					try {
						fs.appendFileSync("/tmp/agent_notify.log", `[${new Date().toISOString()}] Failed to send completion notification: ${err?.message || err}\n`);
					} catch (_) {}
				}
			}
		}
	}

	let agentIsRunning = false;
	ctx.on("agent/status", async ({ agent, status }) => {
		if (status === "running") {
			agentIsRunning = true;
		} else if ((status === "idle" || status === "ready") && agentIsRunning) {
			agentIsRunning = false;
			const todoSummary = cachedLastTodoSummary;
			cachedLastTodoSummary = null;

			let sessionTitle = "";
			try {
				if (ctx.sessionTitle && typeof ctx.sessionTitle.get === "function" && agent?.session) {
					sessionTitle = ctx.sessionTitle.get(agent.session)?.title || "";
				}
				if (!sessionTitle && agent?.session) {
					sessionTitle = agent.session.title || agent.session.meta?.title || "";
				}
			} catch (_) {}

			const finalContent = lastAssistantMessage || todoSummary?.content || "所有执行事项均已处理完毕";
			lastAssistantMessage = "";
			const currentSessionId = agent?.session?.id || agent?.session?.meta?.id || "";

			await safeResetToBackground(`Agent Turn Completed (status: ${status})`, {
				title: "任务已经完成！",
				subtext: sessionTitle || lastUserPromptSummary || "",
				content: finalContent,
				sessionId: currentSessionId,
				total: todoSummary?.total ?? 0,
				completed: todoSummary?.completed ?? 0,
				notify: true,
			});
		}
	});

	ctx.on("agent/error", async ({ agent, error }) => {
		const errDetail = error?.message || (typeof error === "string" ? error : "Unknown error");
		await safeResetToBackground(`Agent Error / Timeout: ${errDetail}`);
		postJson("/api/task_event", {
			type: "agent_error",
			error: errDetail,
			timestamp: Date.now(),
		}).catch(() => {});
	});

	ctx.on("session/disposed", async (session) => {
		await safeResetToBackground(`Session Disposed: ${session?.id || "unknown"}`);
		postJson("/api/task_event", {
			type: "session_disposed",
			session_id: session?.id,
			timestamp: Date.now(),
		}).catch(() => {});
	});

	// Interactive questions: race between phone and Web UI
	ctx.on("user-questions/request", async (request, next) => {
		const requestId = "req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
		const phoneController = new AbortController();
		const webController = new AbortController();

		const callerSignal = request?.signal;
		let webSignal = webController.signal;
		if (callerSignal) {
			if (typeof AbortSignal.any === "function") {
				webSignal = AbortSignal.any([callerSignal, webController.signal]);
			} else {
				callerSignal.addEventListener("abort", () => webController.abort(callerSignal.reason), { once: true });
			}
		}
		if (request) {
			request.signal = webSignal;
		}

		if (callerSignal) {
			callerSignal.addEventListener("abort", () => {
				phoneController.abort();
				webController.abort();
				postJson("/api/question/cancel", { request_id: requestId }).catch(() => {});
			});
		}

		const phonePromise = postJson("/api/question", {
			request_id: requestId,
			questions: request?.questions,
			timeout_ms: 600000,
		}, phoneController.signal)
			.then((res) => {
				if (res && res.success && Array.isArray(res.answers) && res.answers.length > 0) {
					webController.abort(new Error("answered on phone"));
					return { answers: res.answers };
				}
				throw new Error("phone answer empty or unsuccessful");
			})
			.catch(() => {
				return new Promise(() => {});
			});

		const webPromise = (typeof next === "function" ? next() : Promise.reject(new Error("no next handler")))
			.then((webAnswer) => {
				phoneController.abort();
				postJson("/api/question/cancel", { request_id: requestId }).catch(() => {});
				return webAnswer;
			})
			.catch((err) => {
				phoneController.abort();
				postJson("/api/question/cancel", { request_id: requestId }).catch(() => {});
				if (webController.signal.aborted) {
					return new Promise(() => {});
				}
				throw err;
			});

		return await Promise.race([phonePromise, webPromise]);
	}, { prepend: true });
}

export default { apply, inject, name };
