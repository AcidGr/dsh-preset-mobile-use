import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";

let defineTool;
try {
	const toolsMod = await import("@deepseek-ai/dsh-tools");
	defineTool = toolsMod.defineTool;
} catch (_) {
	// Fallback schema compiler when running outside DSH host environment
	defineTool = function (options) {
		const userExecute = options.execute;
		const userRender = options.output?.render;
		let parameters = options.parameters;
		if (parameters && typeof parameters === "object" && !parameters.type && !parameters.properties) {
			const properties = {};
			const required = [];
			for (const [key, prop] of Object.entries(parameters)) {
				const { required: isReq, ...rest } = prop;
				properties[key] = rest;
				if (isReq) required.push(key);
			}
			parameters = {
				type: "object",
				properties,
				...(required.length > 0 ? { required } : {})
			};
		}
		return {
			name: options.name,
			description: options.description,
			parameters,
			output: {
				schema: options.output?.schema || { type: "object", additionalProperties: true },
				render(args, value) {
					return userRender ? userRender(args, value) : (value?.message || "");
				}
			},
			execute: userExecute
		};
	};
}

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

let latestNotice = "";

function checkNoticeHeader(resp) {
	if (!resp || !resp.headers) return;
	const raw = resp.headers.get("x-agent-notice");
	if (raw) {
		try {
			latestNotice = decodeURIComponent(raw.replace(/\+/g, " "));
		} catch (_) {
			latestNotice = raw;
		}
	}
}

async function postJson(path, body, signal) {
	const resp = await fetch(`${SERVER_BASE}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	checkNoticeHeader(resp);
	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`HTTP ${resp.status} on ${path}: ${text}`);
	}
	return await resp.json();
}

/** Capture screenshot as attachment, using sharp downscaling and outer ruler when available. */
async function captureScreenshotAttachment(ctx) {
	const resp = await fetch(`${SERVER_BASE}/api/screenshot`);
	checkNoticeHeader(resp);
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

export const name = "mobile-use-plugin";
export const inject = ["tools", "sessionTitle"];

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
			"- You can specify `mode='tree'` (default, structured accessibility hierarchy dump) or `mode='visual'` (screenshot with outer coordinate rulers) to declare your desired observation format.\n" +
			"- Operating modes: 'foreground' (physical Display 0 visible, with touch glow), 'background' (isolated virtual display, completely silent), or 'idle' (standby/disarmed, Display -1). Use action='switch_mode' with target_mode to switch modes with automatic task migration. Auto-switches to 'idle' on session end; before using mobile operations, you must specify its mode first (e.g. switch to 'foreground' or 'background'); prefer switching to 'idle' when UI tasks finish.\n" +
			"- When encountering tasks requiring user assistance (e.g. entering passwords, SMS/verification codes, QR code scans) or situations with ambiguity/uncertainty, stop immediately or ask the user for help via `ask_user_question`.",
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
				],
				description:
					"Action to perform on device:\n" +
					"- 'observe': Capture and inspect current screen state without touching. Returns UI tree or visual screenshot.\n" +
					"- 'click': Tap or long-press at coordinate [x, y], or tap node by target ID. Automatically returns updated screen state.\n" +
					"- 'swipe': Drag from coordinate [x, y] to end_coordinate [x2, y2]. Automatically returns updated screen state.\n" +
					"- 'type': Input text into currently focused editable field or specified target node. Automatically returns updated screen state.\n" +
					"- 'key': Press physical or navigation key like 'BACK', 'HOME', 'ENTER', or key combination. Automatically returns updated screen state.\n" +
					"- 'wait': Pause execution for specified duration to let animations or page loading settle, then returns updated screen state.\n" +
					"- 'launch_app': Open an installed application by package name or 'package/activity' path. Automatically returns updated screen state.\n" +
					"- 'list_apps': Query installed applications matching an optional keyword. Returns app package list text only.\n" +
					"- 'switch_mode': Switch active operating mode between 'foreground' (physical Display 0), 'background' (virtual display with auto-wakeup), and 'idle' (standby/disarmed, Display -1). Returns mode switch receipt.",
			},
			coordinate: {
				type: "array",
				items: { type: "integer" },
				description: "Target [x, y] coordinates in display pixels. Tap position for 'click', or start position for 'swipe'.",
			},
			end_coordinate: {
				type: "array",
				items: { type: "integer" },
				description: "Ending [x2, y2] coordinates in display pixels. Drag finish position, used only by 'swipe'.",
			},
			target: {
				type: "string",
				description: "Accessibility node ID from UI dump tree (e.g. '146'). Used by 'click' (resolves center) and 'type' (direct input). Omit to use coordinates or focused field.",
			},
			text: {
				type: "string",
				description: "String payload: text to input ('type'), key name like 'BACK'/'HOME'/'ENTER' ('key'), package name or 'package/activity' (optional '--user <id>' for dual/clone apps) ('launch_app'), or search query ('list_apps').",
			},
			duration_ms: {
				type: "integer",
				description: "Duration in milliseconds for long-press 'click', swipe drag duration 'swipe', or pause time 'wait'.",
			},
			mode: {
				type: "string",
				enum: ["tree", "visual"],
				description: "Observation format: 'tree' (default, structured accessibility hierarchy) or 'visual' (screenshot with outer coordinate rulers).",
			},
			target_mode: {
				type: "string",
				enum: ["foreground", "background", "idle"],
				description: "Target operating mode for 'switch_mode': 'foreground' (physical Display 0, visible), 'background' (virtual display with auto-wakeup, silent), or 'idle' (standby/disarmed, Display -1).",
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
			const doExecute = async () => {
				const obsMode = args.mode || "tree";

				switch (args.action) {
					case "switch_mode": {
						let targetMode = "idle";
						const raw = String(args.target_mode || args.mode || "").trim().toLowerCase();
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
						const query = args.text || "";
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

					default: {
						const knownActions = new Set(["observe", "click", "swipe", "type", "key", "wait", "launch_app"]);
						if (!knownActions.has(args.action)) {
							return { message: `Error: unknown action '${args.action}'. Supported: observe, click, swipe, type, key, wait, launch_app, list_apps, switch_mode.` };
						}
						try {
							const res = await postJson("/api/action", args);
							if (!res.success) {
								return { message: `Action '${args.action}' failed: ${res.message || "unknown error"}` };
							}
							if (obsMode === "visual") {
								const shot = await captureScreenshotAttachment(ctx);
								return {
									message: `[${res.message}]\n\n${shot.message || ""}`,
									...(shot.attachment ? { attachment: shot.attachment } : {}),
								};
							}
							return {
								message: `[${res.message}]\n\n${res.data || ""}`,
							};
						} catch (err) {
							return { message: `Execution error (${args.action}): ${err.message}` };
						}
					}
				}
			};

			const res = await doExecute();
			if (latestNotice && res && typeof res.message === "string") {
				const notice = latestNotice;
				latestNotice = "";
				res.message = `${notice}\n\n${res.message}`;
			}
			return res;
		},
	}));

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
				const isAllDone = completed === total;
				if (!isAllDone) return;

				const sid = exec?.agent?.id || exec?.agent?.session?.id || exec?.agent?.session?.meta?.id || "";
				if (!sid) return;

				const header = "所有任务均已执行完毕";
				const lines = todos.map((t, idx) => {
					const cleanContent = (t.content || "").trim().replace(/\r?\n/g, " ");
					return `☑ ${idx + 1}. ${cleanContent}`;
				});

				const divider = "────────────";
				const content = `${header}\n${divider}\n${lines.join("\n")}`;

				lastTodoSummaryBySession.set(sid, {
					title: "已完成",
					content,
					total,
					completed,
				});
			}
		} catch (_) {}
	});

	const runningSessionIds = new Set();
	const activeWatchRequests = new Map();
	const lastNotifyTimeBySession = new Map();
	const lastAssistantMessageBySession = new Map();
	const lastTodoSummaryBySession = new Map();
	const sessionTitleBySession = new Map();

	function ensureSessionWatch(sid, title) {
		if (!sid) return;
		if (activeWatchRequests.has(sid)) return;
		try {
			const encSid = encodeURIComponent(sid);
			const encTitle = encodeURIComponent(title || "");
			const req = http.get(`http://127.0.0.1:3070/api/session/watch?session_id=${encSid}&session_title=${encTitle}`, () => {});
			req.on("error", () => {});
			activeWatchRequests.set(sid, req);
		} catch (_) {}
	}

	function releaseSessionWatch(sid) {
		if (!sid) return;
		const req = activeWatchRequests.get(sid);
		if (req) {
			activeWatchRequests.delete(sid);
			try {
				req.destroy();
			} catch (_) {}
		}
	}

	let lastCompletionNotifyTime = 0;

	function resolveSessionTitle(session) {
		try {
			const sid = session?.id || session?.meta?.id || "";
			if (sid && sessionTitleBySession.has(sid)) {
				return sessionTitleBySession.get(sid);
			}
			if (ctx.sessionTitle && typeof ctx.sessionTitle.get === "function" && session) {
				const t = ctx.sessionTitle.get(session)?.title;
				if (t) return t;
			}
			if (session) {
				const t = session.title || session.meta?.title;
				if (t) return t;
			}
		} catch (_) {}
		return "";
	}

	ctx.on("session/event", (session, event) => {
		try {
			const sid = session?.id || session?.meta?.id || "";
			if (event?.type === "user/message") {
				const title = resolveSessionTitle(session);
				if (sid) {
					runningSessionIds.add(sid);
					ensureSessionWatch(sid, title);
				}
				postJson("/api/task_event", {
					type: "agent_status",
					status: "running",
					session_id: sid,
					session_title: title,
				}).catch(() => {});
			} else if (event?.type === "session/title") {
				const newTitle = event?.data?.title;
				if (sid && newTitle) {
					sessionTitleBySession.set(sid, newTitle);
					if (runningSessionIds.has(sid)) {
						postJson("/api/task_event", {
							type: "agent_status",
							status: "running",
							session_id: sid,
							session_title: newTitle,
						}).catch(() => {});
					}
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
					if (clean && sid) {
						lastAssistantMessageBySession.set(sid, clean);
					}
				}
			}
		} catch (_) {}
	});

	// Reset to idle (display -1, unfocused) & notify completion
	async function safeResetToIdle(reason, opts = {}) {
		const sessionId = opts.sessionId || opts.session_id || "";
		releaseSessionWatch(sessionId);

		try {
			postJson("/api/task_event", {
				type: "agent_status",
				status: "idle",
				session_id: sessionId,
				session_title: opts.subtext || "",
			}).catch(() => {});
		} catch (_) {}

		if (opts.notify === true) {
			const now = Date.now();
			const lastNotify = (sessionId ? lastNotifyTimeBySession.get(sessionId) : 0) || lastCompletionNotifyTime;
			if (now - lastNotify > 1000) {
				if (sessionId) lastNotifyTimeBySession.set(sessionId, now);
				lastCompletionNotifyTime = now;
				try {
					const title = opts.title || "已完成";
					const subtext = opts.subtext || "";
					const content = opts.content || "所有执行事项均已处理完毕";
					const total = typeof opts.total === "number" ? opts.total : 0;
					const completed = typeof opts.completed === "number" ? opts.completed : 0;

					await postJson("/api/notify", {
						title,
						session_title: opts.sessionTitle || opts.session_title || opts.subtext || "",
						subtext: opts.sessionTitle || opts.session_title || opts.subtext || "",
						content,
						tag: "dsh_agent",
						session_id: sessionId,
						total,
						completed,
						is_completed: true,
					}).catch(() => {});
				} catch (_) {}
			}
		}
	}

	ctx.on("agent/status", async (payload) => {
		const status = payload?.status;
		const agent = payload?.agent;
		const currentSessionId = agent?.id || agent?.session?.id || agent?.session?.meta?.id || "";

		if (status === "running") {
			const title = resolveSessionTitle(agent?.session);
			if (currentSessionId) {
				runningSessionIds.add(currentSessionId);
				ensureSessionWatch(currentSessionId, title);
			}
			postJson("/api/task_event", {
				type: "agent_status",
				status: "running",
				session_id: currentSessionId,
				session_title: title,
			}).catch(() => {});
		} else if (status === "idle" || status === "ready") {
			if (currentSessionId && !runningSessionIds.has(currentSessionId)) {
				return;
			}
			if (currentSessionId) {
				runningSessionIds.delete(currentSessionId);
			}

			const todoSummary = currentSessionId ? lastTodoSummaryBySession.get(currentSessionId) : null;
			if (currentSessionId) lastTodoSummaryBySession.delete(currentSessionId);

			const sessionTitle = resolveSessionTitle(agent?.session);
			const finalContent = (currentSessionId ? lastAssistantMessageBySession.get(currentSessionId) : null) || todoSummary?.content || "所有执行事项均已处理完毕";
			if (currentSessionId) lastAssistantMessageBySession.delete(currentSessionId);

			const isAborted = agent?.phase?.abort?.signal?.aborted;
			await safeResetToIdle(`Agent Turn Completed (status: ${status})`, {
				title: "已完成",
				sessionTitle: sessionTitle,
				subtext: sessionTitle,
				content: finalContent,
				sessionId: currentSessionId,
				total: todoSummary?.total ?? 0,
				completed: todoSummary?.completed ?? 0,
				notify: !isAborted,
			});
		}
	});

	ctx.on("agent/error", async ({ agent, error }) => {
		const currentSessionId = agent?.id || agent?.session?.id || agent?.session?.meta?.id || "";
		if (currentSessionId) runningSessionIds.delete(currentSessionId);
		const errDetail = error?.message || (typeof error === "string" ? error : "Unknown error");
		await safeResetToIdle(`Agent Error / Timeout: ${errDetail}`, { sessionId: currentSessionId });
	});

	ctx.on("session/disposed", async (session) => {
		const currentSessionId = session?.id || session?.meta?.id || "";
		if (currentSessionId) {
			runningSessionIds.delete(currentSessionId);
			sessionTitleBySession.delete(currentSessionId);
		}
		await safeResetToIdle(`Session Disposed: ${currentSessionId || "unknown"}`, { sessionId: currentSessionId });
	});

	// Interactive questions: notify phone device (bring up DemoDialogActivity in foreground, or heads-up notification in background)
	// and cleanly delegate to DSH web handler
	ctx.on("user-questions/request", async (request, next) => {
		const requestId = "req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
		const sid = request?.session?.id || request?.agent?.id || "";

		// Fire question presentation to Android device
		postJson("/api/question", {
			request_id: requestId,
			session_id: sid,
			questions: request?.questions,
		}).catch(() => {});

		try {
			const res = typeof next === "function" ? await next() : { answers: [] };
			return res;
		} finally {
			// Settle: dismiss notification on device
			postJson("/api/question/cancel", { request_id: requestId }).catch(() => {});
		}
	}, { prepend: true });
}

export default { apply, inject, name };
