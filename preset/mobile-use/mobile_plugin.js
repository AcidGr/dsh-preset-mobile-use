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

const DELIVERED_JPEG_QUALITY = 88;

/** Token count of one grid (14px patch, 3:1 downsample -> 42px cell; row separator + 2 framing tokens). */
function gridTokens(width, height) {
	const gw = Math.ceil(width / 42);
	const gh = Math.ceil(height / 42);
	return gh * (gw + 1) + 2;
}

/** Drop trailing zeros so a stated factor reads as `2` rather than `2.0000`. */
function factorText(value) {
	return String(Number(value.toFixed(4)));
}

function planScreenshotDelivery(width, height) {
	let divisor = 1;
	while (gridTokens(width / divisor, height / divisor) > 1024) {
		divisor += 1;
	}
	const outW = Math.max(1, Math.round(width / divisor));
	const outH = Math.max(1, Math.round(height / divisor));
	const scaleX = width / outW;
	const scaleY = height / outH;
	return { divisor, width: outW, height: outH, scaleX, scaleY };
}

function screenshotScaleText(delivery) {
	if (!delivery) {
		return "Screenshot captured, but it could not be downscaled to a size the vision pipeline passes through untouched, so it may have been rescaled before you saw it. Read the image dimensions disclosed with this result and convert with x_display = x_image * displayW / imageW; do not assume the image is 1:1.";
	}
	const how = delivery.divisor > 1 ? `downscaled 1/${delivery.divisor}` : "not downscaled";
	return (
		`Screenshot captured. Display ${delivery.displayWidth}x${delivery.displayHeight} delivered as ${delivery.width}x${delivery.height} (${how}), a size the vision pipeline passes through untouched, so these are exactly the pixels you see. ` +
		`Convert any pixel you read off the image into a click coordinate with x_display = x_image * ${factorText(delivery.scaleX)} and y_display = y_image * ${factorText(delivery.scaleY)}. ` +
		`If the image dimensions disclosed with this result differ from ${delivery.width}x${delivery.height}, trust that disclosure instead and use x_display = x_image * displayW / imageW.`
	);
}

const SERVER_BASE = process.env.AGENT_VD_SERVER || "http://127.0.0.1:3070";

const MOBILE_AGENT_GUIDANCE = `<mobile_agent_guidance>
## Android Mobile Use Operational Rules & Protocols

### 1. Closed-Loop Verification
- Every physical action (\`click\`, \`swipe\`, \`type\`, \`key\`, \`launch_app\`) automatically captures and returns the updated accessibility tree. Pass \`screenshot=true\` to attach an image.
- Never perform blind consecutive actions without verifying the updated state. After each action, inspect the returned UI tree or image to confirm the intended transition (e.g., page navigated, dialog dismissed, field populated) before deciding your next step.

### 2. Grounding Priority: Element Target vs. Coordinates
- Strongly prefer element-targeted interactions using \`target='<id>'\` from the accessibility dump. Target IDs are resilient to resolution differences, orientation changes, layout shifts, and scrolling.
- Use pixel \`coordinate=[x, y]\` only when interacting with custom Canvas views, games, sliders, or elements omitted from the accessibility tree.
- When calculating click coordinates from an attached screenshot (\`screenshot=true\`), strictly convert them using the disclosed scale factor: \`x_display = x_image * scaleX\`, \`y_display = y_image * scaleY\`. Never assume the image is 1:1.

### 3. Display Environments, Seamless Migration & User Preemption (Mode Lifecycle)
- The system operates across three display environments:
  * \`background\`: Silent Virtual Display (runs in isolated memory space, completely invisible on the physical screen, zero disruption to the user).
  * \`foreground\`: Physical Screen (Display 0, visible with real-time touch glow feedback).
  * \`idle\`: Disarmed Standby (Display -1, touches ignored, safe standby state).
- Seamless Task Migration: Switching between \`foreground\` and \`background\` via \`action='switch_mode'\` automatically migrates the topmost active application and its current state seamlessly to the target display.
- User Preemption & Real-time Switches: The user may switch modes directly on their physical device at any time. When this occurs, a system event/notice will be delivered to your session. Respect the user's intent, adapt to the new display environment, and proceed with your task smoothly without aborting.
- Lifecycle Protocol: Ensure an active operating mode is established before touching the UI. When all mobile UI tasks are finished or put on hold, switch to \`idle\` mode to disarm touch events.

### 4. Anti-Bypass & Tool Exclusivity Policy
- All mobile UI perception and physical interactions must be performed strictly through the \`mobile\` tool.
- Do NOT bypass this interface by executing shell workarounds (e.g., \`adb shell input tap\`, \`am start\`, \`screencap\`, \`sendevent\`, or raw scripts via \`bash\`) unless explicitly requested by the user.

### 5. Headless Input & System Navigation
- Headless Text Injection: For editable fields, use \`action='set_value', target='<id>', text='...'\`. Text is directly injected into the target element via accessibility services with immediate read-back verification.
- Essential System Keys:
  * \`action='key', text='BACK'\`: Navigate back, dismiss overlays, popups, or soft keyboards.
  * \`action='key', text='HOME'\`: Return to the system launcher/desktop.
  * \`action='key', text='ENTER'\`: Trigger search, submit forms, or confirm input.
  * \`action='key', text='RECENTS'\`: Open recent apps / multitasking overview.

### 6. Safety Safeguards & Human Intervention
- Destructive & Public Actions: For irreversible actions (placing orders, sending financial payments, deleting critical data, factory resets, or publishing public messages), obtain explicit user confirmation via \`ask_user_question\` before proceeding.
- Authentication Barriers: When encountering CAPTCHAs, SMS/email two-factor verification codes, lock-screen PINs, account passwords, or biometric authentication prompts, STOP automated actions immediately and request manual takeover via \`ask_user_question\`. Never fabricate or guess user credentials.
</mobile_agent_guidance>`;

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

/** Capture screenshot as attachment, using sharp downscaling when available. */
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
			buf = await sharp(buf)
				.resize({ width: plan.width, height: plan.height, fit: "fill" })
				.jpeg({ quality: DELIVERED_JPEG_QUALITY })
				.toBuffer();

			delivery = {
				displayWidth: meta.width,
				displayHeight: meta.height,
				width: plan.width,
				height: plan.height,
				divisor: plan.divisor,
				scaleX: plan.scaleX,
				scaleY: plan.scaleY,
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
	const deliveredGuidanceSessions = new Set();

	// 1. mobile: Unified screen interaction and perception tool
	ctx.tools.register(defineTool({
		name: "mobile",
		description:
			"Control native applications and system settings on the Android device via UI automation.\n\n" +
			"- Use `mobile` for all mobile UI interactions (discovery, launch, gestures, typing, key events, and screen inspection).\n" +
			"- Closed-loop feedback: Any action automatically returns the updated accessibility tree. Pass `screenshot=true` to attach an image.\n" +
			"- Display environments: Supports 'foreground' (physical Display 0), 'background' (silent virtual display), and 'idle' (disarmed standby). Auto-switches to 'idle' on session end; switch modes using action='switch_mode' with mode.",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"observe",
					"click",
					"swipe",
					"set_value",
					"key",
					"wait",
					"launch_app",
					"list_apps",
					"switch_mode",
				],
				description:
					"Action to perform on device:\n" +
					"- 'observe': Inspect current screen state.\n" +
					"- 'click': Tap at coordinate [x, y] or node target ID.\n" +
					"- 'swipe': Drag from coordinate [x, y] to end_coordinate [x2, y2].\n" +
					"- 'set_value': Set text of specified target node or focused field.\n" +
					"- 'key': Press key like 'BACK', 'HOME', 'ENTER', or key combination.\n" +
					"- 'wait': Pause execution for duration_ms to let UI settle.\n" +
					"- 'launch_app': Launch app by package name or 'package/activity'.\n" +
					"- 'list_apps': Query installed applications matching search keyword.\n" +
					"- 'switch_mode': Switch display mode ('foreground', 'background', or 'idle').",
			},
			coordinate: {
				type: "array",
				items: { type: "integer" },
				description: "Target [x, y] coordinates in display pixels (tap position for 'click', start position for 'swipe').",
			},
			end_coordinate: {
				type: "array",
				items: { type: "integer" },
				description: "Ending [x2, y2] coordinates in display pixels for 'swipe'.",
			},
			target: {
				type: "string",
				description: "Accessibility node ID from UI dump tree (e.g. '146') for 'click' or 'set_value'. Omit for focused field.",
			},
			text: {
				type: "string",
				description: "Text value ('set_value'), key name ('key'), package name ('launch_app'), or search query ('list_apps').",
			},
			duration_ms: {
				type: "integer",
				description: "Duration in milliseconds for long-press, swipe, or wait.",
			},
			mode: {
				type: "string",
				enum: ["foreground", "background", "idle"],
				description: "Target display mode for 'switch_mode': 'foreground' (visible Display 0), 'background' (silent virtual display), or 'idle' (standby).",
			},
			screenshot: {
				type: "boolean",
				description: "Whether to attach a visual screenshot image alongside the accessibility tree (default: false).",
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
		async execute(args, exec) {
			const doExecute = async () => {
				switch (args.action) {
					case "switch_mode": {
						const targetMode = args.mode || "idle";
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
						const knownActions = new Set(["observe", "click", "swipe", "set_value", "key", "wait", "launch_app"]);
						if (!knownActions.has(args.action)) {
							return { message: `Error: unknown action '${args.action}'. Supported: observe, click, swipe, set_value, key, wait, launch_app, list_apps, switch_mode.` };
						}
						try {
							const res = await postJson("/api/action", args);
							if (!res.success) {
								return { message: `Action '${args.action}' failed: ${res.message || "unknown error"}` };
							}
							if (args.screenshot === true) {
								const shot = await captureScreenshotAttachment(ctx);
								const parts = [`[${res.message}]`];
								if (res.data) parts.push(res.data);
								if (shot.message) parts.push(shot.message);
								return {
									message: parts.join("\n\n"),
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

			// Inject operational guidance only on the first mobile tool call per session
			const sid = exec?.agent?.id || exec?.agent?.session?.id || exec?.agent?.session?.meta?.id || "";
			if (!deliveredGuidanceSessions.has(sid)) {
				deliveredGuidanceSessions.add(sid);
				if (res && typeof res.message === "string") {
					res.message = `${MOBILE_AGENT_GUIDANCE}\n\n${res.message}`;
				}
			}

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

	function syncDshSecretToGateway() {
		try {
			const dshHome = process.env.DSH_HOME || (process.env.HOME ? `${process.env.HOME}/.dsh` : "/root/.dsh");
			const credPath = `${dshHome}/.credentials.yaml`;
			if (fs.existsSync(credPath)) {
				const content = fs.readFileSync(credPath, "utf-8");
				const match = content.match(/secret:\s*([A-Za-z0-9_-]+)/);
				if (match && match[1]) {
					const secret = match[1].trim();
					postJson("/api/auth/secret", { secret }).catch(() => {});
				}
			}
		} catch (_) {}
	}
	syncDshSecretToGateway();

	function ensureSessionWatch(sid, title) {
		if (!sid) return;
		syncDshSecretToGateway();
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
			if (currentSessionId && runningSessionIds.has(currentSessionId)) {
				return;
			}
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
			lastNotifyTimeBySession.delete(currentSessionId);
			deliveredGuidanceSessions.delete(currentSessionId);
		}
		deliveredGuidanceSessions.delete("");
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
