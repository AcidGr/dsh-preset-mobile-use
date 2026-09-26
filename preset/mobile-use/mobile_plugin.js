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

const RULER_TOP = 22;
const RULER_BOTTOM = 22;
const RULER_LEFT = 36;
const RULER_RIGHT = 36;
const RULER_EXTRA_W = RULER_LEFT + RULER_RIGHT;
const RULER_EXTRA_H = RULER_TOP + RULER_BOTTOM;

function chooseStep(span) {
	if (span <= 600) return { major: 100, minor: 50 };
	if (span <= 3200) return { major: 200, minor: 100 };
	return { major: 400, minor: 200 };
}

function generateRulerSvg(displayWidth, displayHeight, innerW, innerH) {
	const totalW = innerW + RULER_LEFT + RULER_RIGHT;
	const totalH = innerH + RULER_TOP + RULER_BOTTOM;
	const stepX = chooseStep(displayWidth);
	const stepY = chooseStep(displayHeight);

	const elements = [];
	elements.push(`<rect x="${RULER_LEFT}" y="${RULER_TOP}" width="${innerW}" height="${innerH}" fill="none" stroke="#388bfd" stroke-width="1" />`);

	const lastXLabelPos = [];
	function addXTick(val, isMajor) {
		const frac = val / displayWidth;
		const x = Math.round(RULER_LEFT + frac * innerW);
		const tickLen = isMajor ? 6 : 3;
		const stroke = isMajor ? "#8b949e" : "#484f58";

		elements.push(`<line x1="${x}" y1="${RULER_TOP - tickLen}" x2="${x}" y2="${RULER_TOP}" stroke="${stroke}" stroke-width="1" />`);
		elements.push(`<line x1="${x}" y1="${RULER_TOP + innerH}" x2="${x}" y2="${RULER_TOP + innerH + tickLen}" stroke="${stroke}" stroke-width="1" />`);

		if (isMajor) {
			const text = String(val);
			const minGap = 28;
			const canLabel = !lastXLabelPos.some((prevX) => Math.abs(prevX - x) < minGap);
			if (canLabel) {
				lastXLabelPos.push(x);
				elements.push(`<text x="${x}" y="${RULER_TOP - 8}" fill="#e6edf3" font-family="monospace, monospace" font-size="9" font-weight="bold" text-anchor="middle">${text}</text>`);
				elements.push(`<text x="${x}" y="${RULER_TOP + innerH + 16}" fill="#e6edf3" font-family="monospace, monospace" font-size="9" font-weight="bold" text-anchor="middle">${text}</text>`);
			}
		}
	}

	for (let v = 0; v <= displayWidth; v += stepX.minor) {
		addXTick(v, v % stepX.major === 0);
	}
	if (displayWidth % stepX.minor !== 0) {
		addXTick(displayWidth, true);
	}

	const lastYLabelPos = [];
	function addYTick(val, isMajor) {
		const frac = val / displayHeight;
		const y = Math.round(RULER_TOP + frac * innerH);
		const tickLen = isMajor ? 6 : 3;
		const stroke = isMajor ? "#8b949e" : "#484f58";

		elements.push(`<line x1="${RULER_LEFT - tickLen}" y1="${y}" x2="${RULER_LEFT}" y2="${y}" stroke="${stroke}" stroke-width="1" />`);
		elements.push(`<line x1="${RULER_LEFT + innerW}" y1="${y}" x2="${RULER_LEFT + innerW + tickLen}" y2="${y}" stroke="${stroke}" stroke-width="1" />`);

		if (isMajor) {
			const text = String(val);
			const minGap = 18;
			const canLabel = !lastYLabelPos.some((prevY) => Math.abs(prevY - y) < minGap);
			if (canLabel) {
				lastYLabelPos.push(y);
				elements.push(`<text x="${RULER_LEFT - 8}" y="${y + 3}" fill="#e6edf3" font-family="monospace, monospace" font-size="9" font-weight="bold" text-anchor="end">${text}</text>`);
				elements.push(`<text x="${RULER_LEFT + innerW + 8}" y="${y + 3}" fill="#e6edf3" font-family="monospace, monospace" font-size="9" font-weight="bold" text-anchor="start">${text}</text>`);
			}
		}
	}

	for (let v = 0; v <= displayHeight; v += stepY.minor) {
		addYTick(v, v % stepY.major === 0);
	}
	if (displayHeight % stepY.minor !== 0) {
		addYTick(displayHeight, true);
	}

	return `<svg width="${totalW}" height="${totalH}" xmlns="http://www.w3.org/2000/svg">${elements.join("")}</svg>`;
}

function planScreenshotDelivery(width, height) {
	let divisor = 1;
	while (
		Math.max(
			Math.round(width / divisor) + RULER_EXTRA_W,
			Math.round(height / divisor) + RULER_EXTRA_H
		) > MAX_DELIVERED_LONG_EDGE
	) {
		divisor += 1;
	}
	return {
		divisor,
		width: Math.max(1, Math.round(width / divisor)),
		height: Math.max(1, Math.round(height / divisor)),
	};
}

function screenshotScaleText(delivery) {
	if (!delivery) {
		return "Screenshot captured. Read the image dimensions disclosed with this result and map coordinates to physical display pixels; do not assume the image is 1:1.";
	}
	return (
		`Screenshot captured. Physical Display: ${delivery.displayWidth}x${delivery.displayHeight}.\n` +
		`The image is framed by outer rulers marking physical display coordinates (Top/Bottom: X 0~${delivery.displayWidth}, Left/Right: Y 0~${delivery.displayHeight}). The inner screen is 100% unoccluded.\n` +
		`Visually align your target element with the outer ruler tick labels to directly obtain physical display coordinates [x, y]. Pass them straight to mobile(action: "click", coordinate: [x, y]).`
	);
}

const SERVER_BASE = process.env.AGENT_VD_SERVER || "http://127.0.0.1:3070";

/**
 * Drop system-chrome windows (status bar, navigation bar, smart sidebar) so physical
 * display 0 and virtual display produce identical trees for the same app.
 * Set AGENT_NO_SYSTEM_UI=0 to restore unfiltered trees.
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

/** Capture screenshot as attachment, using sharp downscaling and outer ruler when available. */
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
			const svg = generateRulerSvg(meta.width, meta.height, plan.width, plan.height);
			buf = await sharp(buf)
				.resize({ width: plan.width, height: plan.height, fit: "fill" })
				.extend({
					top: RULER_TOP,
					bottom: RULER_BOTTOM,
					left: RULER_LEFT,
					right: RULER_RIGHT,
					background: { r: 15, g: 17, b: 23 },
				})
				.composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
				.jpeg({ quality: DELIVERED_JPEG_QUALITY })
				.toBuffer();

			delivery = {
				displayWidth: meta.width,
				displayHeight: meta.height,
				width: plan.width + RULER_EXTRA_W,
				height: plan.height + RULER_EXTRA_H,
			};
		}
	} catch (_) {
		delivery = undefined;
	}
	if (delivery) mediaType = "image/jpeg";

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
			lastUiDumpText = lastText;
			return lastText;
		}
		if (attempt < maxRetries) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	lastUiDumpText = lastText;
	return lastText;
}

let lastUiDumpText = "";

/** Resolve target node ID into center coordinates using cached or fresh dump tree. */
// ponytail: only numeric node ID or 'node:ID' supported. Upgrade to viewId/resource-id regex if requested.
export function findTargetCoordinates(dumpText, target) {
	if (!dumpText || target == null) return null;
	const clean = String(target).replace(/^node:/i, "").trim();
	if (!clean || !/^\d+$/.test(clean)) return null;

	for (const rawLine of dumpText.split("\n")) {
		const line = rawLine.trim();
		if (!line.startsWith(clean + " ")) continue;
		const m = line.match(/^(\d+)\s+/);
		if (!m || m[1] !== clean) continue;

		const unquoted = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
		const targetMatch = unquoted.match(/\btarget=\d+@(-?\d+),(-?\d+)(?:\s|$)/);
		if (targetMatch) {
			return { x: parseInt(targetMatch[1], 10), y: parseInt(targetMatch[2], 10), id: clean };
		}
		const boundsMatch = unquoted.match(/(?:^|\s)(-?\d+),(-?\d+),(-?\d+),(-?\d+)(?:\s|$)/);
		if (boundsMatch) {
			const l = parseInt(boundsMatch[1], 10);
			const t = parseInt(boundsMatch[2], 10);
			const r = parseInt(boundsMatch[3], 10);
			const b = parseInt(boundsMatch[4], 10);
			return { x: Math.round((l + r) / 2), y: Math.round((t + b) / 2), id: clean };
		}
	}
	return null;
}

async function resolveTargetCoordinates(target) {
	if (!lastUiDumpText) {
		await captureUiDumpWithRetry();
	}
	let match = findTargetCoordinates(lastUiDumpText, target);
	if (!match) {
		await captureUiDumpWithRetry();
		match = findTargetCoordinates(lastUiDumpText, target);
	}
	return match;
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
		description:
			"Control native apps and system settings on the user's Android device by reading or operating UI. Prefer purpose-built connectors, APIs, or CLIs when available.\n\n" +
			"- Use `mobile` for all Android app interactions (discovery, launching, touch gestures, typing, and key events).\n" +
			"- Do not use other technologies or shell workarounds for mobile interactions, unless specifically requested by the user (e.g. `am start`, `input tap`, `screencap`, raw Xposed hooks).\n" +
			"- Prefer a dedicated plugin or skill when it can complete the task; use Mobile Use for interactions that are not exposed through a more specific interface.\n" +
			"- Performing any physical action automatically captures and returns the updated screen state in the tool result.\n" +
			"- You can specify `mode='tree'` (default, structured accessibility hierarchy dump) or `mode='visual'` (screenshot image) to declare your desired observation format.\n" +
			"- Operating modes: 'foreground' (physical Display 0 visible, with touch glow), 'background' (isolated virtual display, completely silent), or 'idle' (standby/disarmed, Display -1). Use action='switch_mode' to switch modes with automatic task migration.",
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
				description: "[x, y] coordinates in display pixels for click (tap/long-press), or starting coordinates for swipe. Can be omitted if target is specified.",
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
				description: "Text to type; key name ('BACK', 'HOME', 'ENTER') for key; package name for launch_app; app query for list_apps; or mode ('foreground'|'background'|'idle') for switch_mode.",
			},
			activity: {
				type: "string",
				description: "Optional Activity class for launch_app (e.g. '.ui.LauncherUI'). Omit to launch the package's default launcher activity.",
			},
			target: {
				type: "string",
				description: "Optional node ID from dump tree (e.g. '146') for click (auto-resolves center coordinates) or direct input. Omit to type into focused field.",
			},
			duration_ms: {
				type: "integer",
				description: "Duration in milliseconds for long-press click, swipe, or wait.",
			},
			mode: {
				type: "string",
				enum: ["tree", "visual", "foreground", "background", "idle"],
				description: "Observation mode: 'tree' (default) or 'visual' (screenshot); or target mode for switch_mode ('foreground'|'background'|'idle').",
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
					let x = args.coordinate?.[0] ?? args.x;
					let y = args.coordinate?.[1] ?? args.y;
					let resolvedTarget = null;
					if ((x == null || y == null) && args.target !== undefined && args.target !== null && String(args.target).trim() !== "") {
						const resolved = await resolveTargetCoordinates(args.target);
						if (!resolved) {
							return { message: `Error: target '${args.target}' not found in current UI dump tree. Please call action='observe' to refresh the tree, or specify [x, y] coordinates.` };
						}
						x = resolved.x;
						y = resolved.y;
						resolvedTarget = resolved.id;
					}
					if (x == null || y == null) {
						return { message: "Error: action 'click' requires coordinates: coordinate: [x, y] (or x and y) or target (e.g. '146')." };
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
						const targetDesc = resolvedTarget ? `target ${resolvedTarget} at ` : "";
						const actionDesc = payload.duration_ms
							? `OK: Long-pressed ${targetDesc}(${x}, ${y}) for ${payload.duration_ms}ms`
							: `OK: Tapped ${targetDesc}(${x}, ${y})`;
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
					let targetMode = "idle";
					const raw = String(args.text || args.mode || "").trim().toLowerCase();
					if (raw.includes("fore") || raw === "0" || raw === "fg") {
						targetMode = "foreground";
					} else if (raw.includes("back") || raw.includes("virt") || raw === "bg") {
						targetMode = "background";
					} else if (raw.includes("idle") || raw.includes("standby") || raw === "-1" || raw.includes("none")) {
						targetMode = "idle";
					} else if (raw && raw !== "tree" && raw !== "visual") {
						targetMode = raw;
					}
					try {
						const res = await postJson("/api/mode", { mode: targetMode });
						if (!res.success) {
							return { message: `Failed to switch mode: ${res.message || "unknown error"}` };
						}
						const migrated = res.migrated_component ? ` (Migrated active app: ${res.migrated_component})` : "";
						return { message: `${res.message || `Switched to ${res.mode} mode (Display ${res.target_display_id})`}${migrated}` };
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
						else if (rawArgs.target) summary += ` target=${rawArgs.target}`;
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
	let lastAssistantMessage = "";

	function resolveSessionTitle(session) {
		try {
			if (ctx.sessionTitle && typeof ctx.sessionTitle.get === "function" && session) {
				const t = ctx.sessionTitle.get(session)?.title;
				if (t) return t;
			}
			if (session) {
				const t = session.title || session.meta?.title;
				if (t) return t;
			}
			const parts = process.cwd().split("/").filter(Boolean);
			if (parts.length > 0) return parts[parts.length - 1];
		} catch (_) {}
		return "移动端任务";
	}

	ctx.on("session/event", (session, event) => {
		try {
			if (event?.type === "user/message") {
				const sid = session?.id || session?.meta?.id || "";
				postJson("/api/task_event", {
					type: "agent_status",
					status: "running",
					session_id: sid,
					session_title: resolveSessionTitle(session),
				}).catch((err) => {
					try {
						fs.appendFileSync("/tmp/agent_notify.log", `[${new Date().toISOString()}] Failed to post running status (user/message): ${err?.message || err}\n`);
					} catch (_) {}
				});
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

	// Reset to idle (display -1, unfocused) & notify completion
	async function safeResetToIdle(reason, opts = {}) {
		try {
			postJson("/api/task_event", { type: "agent_status", status: "idle" }).catch(() => {});
			const res = await postJson("/api/mode", { mode: "idle" });
			fs.appendFileSync("/tmp/agent_notify.log", `[${new Date().toISOString()}] Reset to idle triggered by: ${reason} (mode: ${res?.mode}, target_display_id: ${res?.target_display_id})\n`);
		} catch (err) {
			try {
				fs.appendFileSync("/tmp/agent_notify.log", `[${new Date().toISOString()}] Failed to reset to idle (${reason}): ${err?.message || err}\n`);
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
	ctx.on("agent/status", async (payload) => {
		const status = payload?.status;
		const agent = payload?.agent;
		const currentSessionId = agent?.id || agent?.session?.id || agent?.session?.meta?.id || "";

		if (status === "running") {
			agentIsRunning = true;
			postJson("/api/task_event", {
				type: "agent_status",
				status: "running",
				session_id: currentSessionId,
				session_title: resolveSessionTitle(agent?.session),
			}).catch(() => {});
		} else if (status === "idle" || status === "ready") {
			if (!agentIsRunning) {
				return;
			}
			agentIsRunning = false;
			postJson("/api/task_event", { type: "agent_status", status: "idle" }).catch(() => {});
			const todoSummary = cachedLastTodoSummary;
			cachedLastTodoSummary = null;

			const sessionTitle = resolveSessionTitle(agent?.session);
			const finalContent = lastAssistantMessage || todoSummary?.content || "所有执行事项均已处理完毕";
			lastAssistantMessage = "";
			try {
				fs.appendFileSync("/tmp/agent_notify.log", `[${new Date().toISOString()}] Agent Turn Completed. agent.id=${agent?.id} session.id=${agent?.session?.id} finalSessionId=${currentSessionId}\n`);
			} catch (_) {}

			const isAborted = agent?.phase?.abort?.signal?.aborted;
			await safeResetToIdle(`Agent Turn Completed (status: ${status})`, {
				title: "已完成",
				subtext: sessionTitle || "任务已完成",
				content: finalContent,
				sessionId: currentSessionId,
				total: todoSummary?.total ?? 0,
				completed: todoSummary?.completed ?? 0,
				notify: !isAborted,
			});
		}
	});

	ctx.on("agent/error", async ({ agent, error }) => {
		const errDetail = error?.message || (typeof error === "string" ? error : "Unknown error");
		await safeResetToIdle(`Agent Error / Timeout: ${errDetail}`);
		postJson("/api/task_event", {
			type: "agent_error",
			error: errDetail,
			timestamp: Date.now(),
		}).catch(() => {});
	});

	ctx.on("session/disposed", async (session) => {
		await safeResetToIdle(`Session Disposed: ${session?.id || "unknown"}`);
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

		const cancelPhoneQuestion = () => {
			phoneController.abort();
			postJson("/api/question/cancel", { request_id: requestId }).catch(() => {});
		};

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
				webController.abort();
				cancelPhoneQuestion();
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
				cancelPhoneQuestion();
				return webAnswer;
			})
			.catch((err) => {
				cancelPhoneQuestion();
				if (webController.signal.aborted) {
					return new Promise(() => {});
				}
				throw err;
			});

		return await Promise.race([phonePromise, webPromise]);
	}, { prepend: true });
}

export default { apply, inject, name };
