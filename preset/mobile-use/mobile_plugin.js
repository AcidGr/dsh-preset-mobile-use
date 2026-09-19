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

const SERVER_BASE = process.env.AGENT_VD_SERVER || "http://127.0.0.1:3070";

async function postJson(path, body) {
	const resp = await fetch(`${SERVER_BASE}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
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

export const name = "mobile-use-plugin";
export const inject = ["tools"];

export function apply(ctx) {
	// 1. mobile_status
	ctx.tools.register(defineTool({
		name: "mobile_status",
		description: "Get the current running status and display metrics of the Android Virtual Display subsystem.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_args, val) => [{ type: "text", text: val }],
		},
		async execute() {
			try {
				const status = await getJson("/api/status");
				return JSON.stringify(status, null, 2);
			} catch (err) {
				return `Error querying status: ${err.message}`;
			}
		},
	}));

	// 2. mobile_screenshot
	ctx.tools.register(defineTool({
		name: "mobile_screenshot",
		description: "Capture a real-time screenshot of the Android virtual display (matching physical resolution) and return the visual image for inspection. Older screenshot images in the conversation history are automatically offloaded into lean placeholders to keep context small and response fast.",
		parameters: {},
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
		async execute(_args, exec) {
			const resp = await fetch(`${SERVER_BASE}/api/screenshot`);
			if (!resp.ok) {
				const errText = await resp.text();
				throw new Error(`Screenshot failed (HTTP ${resp.status}): ${errText}`);
			}
			const buf = Buffer.from(await resp.arrayBuffer());
			const attachments = ctx.get("attachments");
			if (attachments) {
				// Evict/offload older historical images from the session so only the latest screenshot stays in context
				try {
					const session = exec?.agent?.session;
					if (session && typeof session.append === "function") {
						const nodes = session.surface?.nodes || [];
						const targets = [];
						for (const seq of nodes) {
							const event = session.eventAt(seq);
							if (!event || (event.type !== "user/message" && event.type !== "tool/result")) continue;
							const message = session.deriveEventMessage(event);
							if (!message || !Array.isArray(message.content)) continue;
							const imageIndexes = [];
							let imageIndex = 0;
							const visit = (blocks) => {
								for (const block of blocks) {
									if (block.type === "image") {
										if (block.offloaded !== true) {
											imageIndexes.push(imageIndex);
										}
										imageIndex += 1;
									} else if (block.type === "tool-result" && Array.isArray(block.content)) {
										visit(block.content);
									}
								}
							};
							visit(message.content);
							if (imageIndexes.length > 0) {
								targets.push({ seq, imageIndexes });
							}
						}
						if (targets.length > 0) {
							session.append("image/offload", { targets });
						}
					}
				} catch (offloadErr) {
					// Soft fallback
				}

				const ref = await attachments.saveImage({
					data: buf,
					mediaType: "image/png",
					name: "mobile_screenshot.png",
				});
				return {
					message: `Screenshot captured successfully (1:1 PNG, ${buf.length} bytes, historical images offloaded)`,
					attachment: ref,
				};
			}
			return {
				message: `Screenshot captured (${buf.length} bytes), attachment service unavailable.`,
			};
		},
	}));

	// 3. mobile_dump_ui
	ctx.tools.register(defineTool({
		name: "mobile_dump_ui",
		description: "Inspect the current screen's accessibility node tree. Returns a JSON object: {display_id, mode, width, height, windows, total, returned, truncated, nodes}. Coordinates in nodes are ABSOLUTE PIXELS with origin at the top-left; `b` is [left,top,right,bottom]. There is NO `ctr` field: the element's centre is just [(left+right)/2, (top+bottom)/2], compute it from `b`. When a node carries `tap`, prefer `tap` — it is an ancestor's centre and cannot be derived from this node's own bounds. Each node carries only raw signals: `type`, `text`/`desc`/`vid`, `click` (this element itself accepts a tap), `enabled` (0 = disabled, do not tap), `visible` (0 = scrolled off screen), `checkable`/`checked`, `scroll` (a scrollable container), `focused`, `w` (window index; when `w` appears at all there is a dialog or overlay on screen, and nodes without `w` sit BELOW it and may be covered). IMPORTANT: when a node is NOT itself clickable it may carry a resolved `tap` target — `tap:[x,y]`, `tap_id`, `tap_x` (how many times larger that ancestor is). Click `tap` when present; it is the ancestor that will actually receive the gesture, so you never have to reason about touch bubbling. A node with neither `click` nor `tap` may carry `why` (e.g. \"scrollable\", \"target>halfscreen\"): its resolved target was deliberately dropped because tapping it would only scroll or would land on a layout wrapper — do not guess a coordinate for such a node, find a child or sibling that does carry a target. READ THE ENVELOPE FIRST — it is how you tell these cases apart: `dup` is how many identical overlapping nodes were merged away; `empty_scan` means the accessibility engine reported no window at all (a retry, not an empty screen); `nodes: []` while `windows` > 0 means the app suppresses its tree and you must fall back to mobile_screenshot; `x_extent`/`y_extent` appear when content reaches outside the screen. TRUNCATION: nodes are emitted most-useful-first, so if `truncated` is true check `omitted_top`. When `omitted_top` is ABSENT, nothing tappable was dropped (only labels/decoration, see `omitted_min`) and you may act on what you have. When `omitted_top` is PRESENT, real controls were cut off and you MUST finish the read before acting: call mobile_dump_ui with y_min=next_y for the rest. This is not optional — measured on Amap, a dense screen silently loses 11 tappable controls including 查路线 and 我的位置, and only a paged read recovers them (verified: y_min=next_y returned all 15 controls, zero loss). The envelope's `act_total` vs `act_sent` is the exact count of controls on screen versus delivered, so use those two numbers to judge whether you actually have the whole screen. WebView/H5 pages ARE readable: this tool queries such a page twice to wake its accessibility tree, so page text and buttons appear normally — do not assume an H5 screen cannot be inspected. Always prefer a fresh dump over guessing from a screenshot.",
		parameters: {
			y_min: {
				type: "integer",
				description: "Optional vertical paging window: return only nodes ending below this y coordinate. Pass next_y from a truncated result to read the part of the screen that did not fit.",
			},
			y_max: {
				type: "integer",
				description: "Optional vertical paging window: return only nodes starting above this y coordinate. Omit for no lower bound.",
			},
		},
		output: {
			schema: { type: "string" },
			render: (_args, val) => [{ type: "text", text: val }],
		},
		async execute(args) {
			try {
				const q = [];
				if (typeof args.y_min === "number") q.push(`y_min=${args.y_min}`);
				if (typeof args.y_max === "number") q.push(`y_max=${args.y_max}`);
				const suffix = q.length ? `?${q.join("&")}` : "";
				const resp = await fetch(`${SERVER_BASE}/api/dump_ui${suffix}`);
				const text = await resp.text();
				return text;
			} catch (err) {
				return `Error dumping UI hierarchy: ${err.message}`;
			}
		},
	}));

	// 4. mobile_click
	ctx.tools.register(defineTool({
		name: "mobile_click",
		description: "Tap at absolute pixel coordinates (x, y) on the target display. Coordinates are only valid for the screen state of the LATEST observation: take them from `tap` when the node carries one, otherwise compute the centre as [(left+right)/2, (top+bottom)/2] from its `b`, using a fresh mobile_dump_ui result — never reuse coordinates after anything changed the screen. If a tap appears to have no effect, re-observe instead of tapping the same point again.",
		parameters: {
			x: {
				type: "integer",
				required: true,
				description: "X coordinate (0 to screen width)",
			},
			y: {
				type: "integer",
				required: true,
				description: "Y coordinate (0 to screen height)",
			},
		},
		output: {
			schema: { type: "string" },
			render: (_args, val) => [{ type: "text", text: val }],
		},
		async execute(args) {
			const res = await postJson("/api/click", { x: args.x, y: args.y });
			if (!res.success) {
				throw new Error(`Click failed: ${res.message || "unknown error"}`);
			}
			return `Tapped (${args.x}, ${args.y}). The screen has changed or is changing — run mobile_dump_ui again to see the result before the next action.`;
		},
	}));

	// 5. mobile_swipe
	ctx.tools.register(defineTool({
		name: "mobile_swipe",
		description: "Perform a touch swipe gesture from (x1, y1) to (x2, y2) on the Android virtual display. Useful for scrolling lists, page transitions, or drag interactions.",
		parameters: {
			x1: { type: "integer", required: true, description: "Starting X coordinate" },
			y1: { type: "integer", required: true, description: "Starting Y coordinate" },
			x2: { type: "integer", required: true, description: "Ending X coordinate" },
			y2: { type: "integer", required: true, description: "Ending Y coordinate" },
			duration_ms: { type: "integer", description: "Duration of swipe in milliseconds (default: 300)" },
		},
		output: {
			schema: { type: "string" },
			render: (_args, val) => [{ type: "text", text: val }],
		},
		async execute(args) {
			const duration = args.duration_ms || 300;
			const res = await postJson("/api/swipe", {
				x1: args.x1,
				y1: args.y1,
				x2: args.x2,
				y2: args.y2,
				duration,
			});
			if (!res.success) {
				throw new Error(`Swipe failed: ${res.message || "unknown error"}`);
			}
			return `Swiped from (${args.x1}, ${args.y1}) to (${args.x2}, ${args.y2}) in ${duration}ms`;
		},
	}));

	// 6. mobile_type
	ctx.tools.register(defineTool({
		name: "mobile_type",
		description: "Silently inject text into the currently focused input field on the virtual display via clipboard paste. Supports Chinese, long sentences, numbers, and special characters without popping up soft keyboards on Display 0.",
		parameters: {
			text: {
				type: "string",
				required: true,
				description: "The text content to input/paste",
			},
		},
		output: {
			schema: { type: "string" },
			render: (_args, val) => [{ type: "text", text: val }],
		},
		async execute(args) {
			const res = await postJson("/api/type", { text: args.text });
			if (!res.success) {
				throw new Error(`Text input failed: ${res.message || "unknown error"}`);
			}
			return `Injected text: "${args.text}"`;
		},
	}));

	// 7. mobile_press_key
	ctx.tools.register(defineTool({
		name: "mobile_press_key",
		description: "Inject a key event into the Android virtual display. Supports standard key names (BACK, HOME, ENTER, TAB, SPACE, DELETE, APP_SWITCH) or numeric keycodes (e.g. 4 for BACK, 66 for ENTER).",
		parameters: {
			key: {
				type: "string",
				required: true,
				description: "Key name (BACK, HOME, ENTER, TAB, SPACE, DELETE, APP_SWITCH) or integer keycode",
			},
		},
		output: {
			schema: { type: "string" },
			render: (_args, val) => [{ type: "text", text: val }],
		},
		async execute(args) {
			const res = await postJson("/api/key", { key: args.key });
			if (!res.success) {
				throw new Error(`Key injection failed: ${res.message || "unknown error"}`);
			}
			return `Pressed key: ${args.key}`;
		},
	}));

	// 8. mobile_launch_app
	ctx.tools.register(defineTool({
		name: "mobile_launch_app",
		description: "Launch an Android application on the virtual display by its package name or component name.",
		parameters: {
			package: {
				type: "string",
				required: true,
				description: "Package name (e.g. com.android.settings, com.sankuai.meituan)",
			},
			activity: {
				type: "string",
				description: "Optional specific Activity name",
			},
		},
		output: {
			schema: { type: "string" },
			render: (_args, val) => [{ type: "text", text: val }],
		},
		async execute(args) {
			const res = await postJson("/api/launch", {
				package: args.package,
				activity: args.activity || "",
			});
			if (!res.success) {
				throw new Error(`Launch failed: ${res.message || "unknown error"}`);
			}
			return `Launched app ${args.package}${args.activity ? "/" + args.activity : ""}: ${res.message || "OK"}`;
		},
	}));

	// 9. mobile_shell
	ctx.tools.register(defineTool({
		name: "mobile_shell",
		description: "Execute a high-privilege Android root shell command in the Android system environment. Use this for fast non-visual CLI tasks (e.g. SQLite database queries, inspecting packages with pm, querying system services with dumpsys, curl HTTP calls, am broadcast) which should ALWAYS be prioritized over visual GUI operations when available.",
		parameters: {
			command: {
				type: "string",
				required: true,
				description: "The shell command to execute in Android environment",
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

	// 10. mobile_switch_mode
	ctx.tools.register(defineTool({
		name: "mobile_switch_mode",
		description: "Switch the target display mode between foreground (Display 0, physical screen) and background (virtual display, headless isolated screen). All subsequent mobile actions (click, type, dump_ui, screenshot, launch) will target the chosen display.",
		parameters: {
			mode: {
				type: "string",
				required: true,
				description: "Target mode: 'foreground' (or 'fg' / '0') for main physical screen, 'background' (or 'bg') for virtual display.",
			},
		},
		output: {
			schema: { type: "string" },
			render: (_args, val) => [{ type: "text", text: val }],
		},
		async execute(args) {
			const res = await postJson("/api/mode", { mode: args.mode });
			if (!res.success) {
				throw new Error(`Failed to switch mode: ${res.message || "unknown error"}`);
			}
			return res.message || `Switched to ${res.mode} mode (Display ${res.target_display_id})`;
		},
	}));

	// Auto status notification: sync todo_write progress silently to Android status bar (BigText style)
	ctx.on("tools/result", async (exec, result) => {
		try {
			// DSH tools/result emits (exec: ToolExecution, result: ToolExecutionResult)
			const name = exec?.name;
			if (name === "todo_write") {
				// Tool arguments in DSH are stored in `exec.arguments` (fallback to `exec.args` or `exec.input`)
				const rawArgs = exec.arguments ?? exec.args ?? exec.input ?? {};
				const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
				const todos = args?.todos || [];
				if (!Array.isArray(todos) || todos.length === 0) return;

				const total = todos.length;
				const completed = todos.filter((t) => t.status === "completed").length;
				const inProgress = todos.find((t) => t.status === "in_progress");

				const isAllDone = completed === total;
				const title = isAllDone
					? `[Mobile Agent] 任务已全部完成 (${completed}/${total})`
					: `[Mobile Agent] 任务进度 (${completed}/${total})`;

				// 顶部第一行作为焦点摘要展示（去除 >> 箭头，更加干净）
				let header = "";
				if (isAllDone) {
					header = "所有任务均已执行完毕";
				} else if (inProgress) {
					const curTask = (inProgress.content || "").trim().replace(/\r?\n/g, " ");
					header = `当前执行: ${curTask}`;
				} else {
					header = "准备开始执行任务...";
				}

				// 格式化纯净打勾方框待办清单（Unicode 原生方框符号，非彩色 Emoji）
				// 已完成: ☑, 进行中: ◉, 待办: ☐
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

				await postJson("/api/notify", {
					title,
					content,
					tag: "dsh_agent",
					total,
					completed,
				});
				fs.appendFileSync("/tmp/agent_notify.log", `[${new Date().toISOString()}] Posted notify: ${title}\n`);
			}
		} catch (err) {
			try {
				fs.appendFileSync("/tmp/agent_notify.log", `[${new Date().toISOString()}] Error: ${err?.stack || err}\n`);
			} catch (_) {}
		}
	});
}

export default { apply, inject, name };
