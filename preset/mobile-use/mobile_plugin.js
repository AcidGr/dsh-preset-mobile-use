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
		description: "Inspect and dump the current Android accessibility node hierarchy on the virtual display. Returns a compact JSON array of clickable, editable, scrollable, and checkable elements with exact screen center coordinates [x, y], text, resource IDs, and bounding boxes. ALWAYS prefer this tool to find exact element coordinates over guessing.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_args, val) => [{ type: "text", text: val }],
		},
		async execute() {
			try {
				const resp = await fetch(`${SERVER_BASE}/api/dump_ui`);
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
		description: "Perform a physical touch tap/click at coordinates (x, y) on the Android virtual display. Use coordinates obtained from mobile_dump_ui or visual inspection.",
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
			return `Clicked at (${args.x}, ${args.y})`;
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

	// 10. mobile_notify
	ctx.tools.register(defineTool({
		name: "mobile_notify",
		description: "Post or update a system notification in the Android status bar/notification panel to display the current task progress, todo list status, or completion alert. Overwrites previous notification in place with the same tag.",
		parameters: {
			title: {
				type: "string",
				description: "Notification title (e.g. 'Mobile Agent 任务进行中' or 'Mobile Agent 任务已完成')",
			},
			content: {
				type: "string",
				required: true,
				description: "Detailed progress or status summary (e.g. '正在执行: 搜索外卖\\n进行中: 1 | 已完成: 2 | 待办: 0')",
			},
			tag: {
				type: "string",
				description: "Optional tag identifier for the notification (defaults to 'dsh_agent')",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					message: { type: "string" },
					success: { type: "boolean" },
				},
			},
			render: (_args, val) => [{
				type: "text",
				text: val.success ? `Notification posted: ${val.message || "OK"}` : `Notification error: ${val.message}`,
			}],
		},
		async execute(args) {
			const res = await postJson("/api/notify", {
				title: args.title || "Mobile Agent 任务状态",
				content: args.content,
				tag: args.tag || "dsh_agent",
			});
			return res;
		},
	}));
}

export default { apply, inject, name };
