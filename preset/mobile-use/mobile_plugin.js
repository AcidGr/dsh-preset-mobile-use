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
 *
 * Same candidate order as {@link resolveDshTools}. `sharp` is a native module that only
 * resolves out of the DSH tree, and failing to find it must degrade the screenshot tool to
 * "no downscale" rather than take the whole preset down with it.
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

/**
 * Longest delivered edge that still fits the DeepSeek vision token grid at EVERY aspect
 * ratio, so a screenshot never gets rescaled a second time behind our back.
 *
 * The grid bills `gridH * (gridW + 1) + 2` tokens on 14px patches with 3:1 downsampling,
 * capped at 1024 tokens per image, and the count grows with the grid width — so a square is
 * the worst case. 1302x1302 is the largest square the cap admits (994 tokens; a 1316 square
 * already needs 1058), and a measured sweep over 181 aspect ratios never exceeded 994. Any
 * image whose long edge is <= 1302 therefore reaches the model untouched whatever its shape.
 *
 * That pass-through is the whole point: an image the pipeline does not rescale is one whose
 * delivered dimensions this tool can state authoritatively, instead of an unknown factor the
 * model would otherwise have to discover by trial and error.
 */
const MAX_DELIVERED_LONG_EDGE = 1302;

/**
 * Encoding of the downscaled image that actually reaches the model.
 *
 * This buffer is what the request carries, every request, for as long as the screenshot
 * stays the newest one — the harness passes a clean JPEG through byte-identically, so its
 * size is the request size.
 *
 * QUALITY, measured against the real screen: PNG 47.24 dB, JPEG q92 41.02 dB, q95 42.00 dB,
 * q85 39.60 dB. q92 is the chosen point: the agent reads UI off this buffer to decide where
 * to tap, and 41 dB keeps small text legible where q85 starts to soften it. Raising the
 * gateway's own JPEG quality instead buys almost nothing (q85 -> q95 was worth +0.11 dB)
 * because this second encode dominates the loss, so the daemon is left at q85.
 *
 * SIZE, measured by re-encoding the 287 real screenshots this tool has delivered, under the
 * pi-ai/cliproxyapi request limits that decide what actually goes on the wire (maxPixels
 * 4194304, maxBytes 1 MiB). Base64 bytes of ONE screenshot in ONE request, medians:
 *
 *   full-res 1272x2800 PNG, as delivered before the downscale landed   432 KB
 *     (the harness itself re-encodes any request image over 1 MiB down to <= 1 MiB, so the
 *      ~2 MB PNG a heavy screen produces never crossed the wire at its stored size)
 *   + downscale to 424x933 PNG                                         163 KB   (2.79x)
 *   + JPEG q92 instead of PNG                                           90 KB   (1.83x)
 *   end to end, 432 KB -> 90 KB                                        5.01x
 *
 * The spread is wide and it is not a rounding detail: per frame this ranges 2.77x to 10.04x,
 * because PNG is already good at flat UI (the JPEG step alone measured 1.24x there) while a
 * wallpaper-heavy screen measured 9.7x. Do not quote a single frame as "the" gain — the
 * heaviest frame in this corpus is 9.66x on the JPEG step alone, and quoting it would
 * overstate the change by more than 5x against the median.
 */
const DELIVERED_JPEG_QUALITY = 92;

/**
 * Pick the smallest integer divisor that brings the long edge within the pass-through limit,
 * so the factor the model applies is a whole number it cannot misremember.
 */
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

/** Drop trailing zeros so a stated factor reads as `3` rather than `3.0000`. */
function factorText(value) {
	return String(Number(value.toFixed(4)));
}

/**
 * State the exact image-to-display mapping in the tool result.
 *
 * This is the fix for the first-click failure: the model never has to infer the scale from
 * the image envelope, and it never has to carry a remembered constant between screenshots.
 */
function screenshotScaleText(delivery) {
	if (!delivery) {
		return "Screenshot captured, but it could not be downscaled to a size the vision pipeline passes through untouched, so it may have been rescaled before you saw it. Read the image dimensions disclosed with this result and convert with x_display = x_image * displayW / imageW; do not assume the image is 1:1.";
	}
	const how = delivery.divisor > 1 ? `downscaled 1/${delivery.divisor}` : "not downscaled";
	return `Screenshot captured. Display ${delivery.displayWidth}x${delivery.displayHeight} delivered as ${delivery.width}x${delivery.height} (${how}), a size the vision pipeline passes through untouched, so these are exactly the pixels you see. Convert any pixel you read off the image into a mobile_click coordinate with x_display = x_image * ${factorText(delivery.scaleX)} and y_display = y_image * ${factorText(delivery.scaleY)}. If the image dimensions disclosed with this result differ from ${delivery.width}x${delivery.height}, trust that disclosure instead and use x_display = x_image * displayW / imageW.`;
}

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
		description: "Capture a real-time screenshot of the target display and return it for inspection. The image is NOT 1:1 with the screen: this tool downscales it to a fixed size the vision pipeline passes through untouched, and the result text states the delivered size together with the exact image-to-display factor. Apply that factor to any pixel you read off the image before turning it into a mobile_click coordinate, and never assume the image is 1:1. Older screenshot images in the conversation history are automatically offloaded into lean placeholders to keep context small and response fast.",
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
			// The gateway answers with the daemon's cached frame (JPEG) whenever it has
			// one, and falls back to screencap (PNG) otherwise, so the media type has to
			// travel with the bytes. This matters on the path below where sharp is
			// unavailable and the response is attached untouched — a JPEG declared as
			// image/png would be rejected by the provider.
			let mediaType = (resp.headers.get("content-type") || "image/png").split(";")[0].trim();
			if (mediaType !== "image/jpeg") mediaType = "image/png";
			let buf = Buffer.from(await resp.arrayBuffer());
			// Downscale before the harness ever encodes the image for the provider. A
			// delivered long edge at or below MAX_DELIVERED_LONG_EDGE is passed through
			// untouched, so the dimensions reported below are exactly the ones the model
			// receives — which is what lets us state the factor instead of the model
			// discovering it by tapping the wrong pixel first.
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
			} catch (scaleErr) {
				// Keep the native image and let the result text warn about scale rather
				// than claiming a factor the delivered image may not honour.
				delivery = undefined;
			}
			// The downscaled branch re-encodes through sharp, so the attachment is JPEG
			// there no matter what the gateway sent; only the pass-through case keeps the
			// server's own format.
			if (delivery && delivery.divisor > 1) mediaType = "image/jpeg";

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
					mediaType,
					name: mediaType === "image/jpeg" ? "mobile_screenshot.jpg" : "mobile_screenshot.png",
				});
				return {
					message: `${screenshotScaleText(delivery)} Historical images offloaded.`,
					attachment: ref,
				};
			}
			return {
				message: `${screenshotScaleText(delivery)} The attachment service is unavailable, so the image is not in your context.`,
			};
		},
	}));

	// 3. mobile_dump_ui
	ctx.tools.register(defineTool({
		name: "mobile_dump_ui",
		description: "Inspect the current screen's accessibility tree as one line per element. Reads the DEFAULT observation tool: its coordinates are already absolute display pixels. Format: a status line, then a `# ...` line naming the columns once, then one row per element: `id type \"name\" x1,y1,x2,y2 flags [optional fields]`. A row is splittable on whitespace; free-text fields always come last and are quoted. `name` is the richer of text/content-desc, and may be absent when the app gives neither. Map `id` to a click target; `target=ID@x,y` fields just below a row point at a clickable ancestor's centre for labels that are not tappable themselves. Flags: c=clickable e=editable s=scrollable k+=checked/selected k-=unchecked off=disabled gone=offscreen focus=focused wN=window dN=depth. Optional: `d=` extra content-desc, `id=` resource, `how=` WHY the row has no name (unlabeled=try it, wraps=it only wraps a tappable child, so prefer the child, scrollonly, offscreen, disabled), `hint=` an input's placeholder, `tip=` a tooltip. Rows are ordered most useful first, and that order is the only statement of tier; every actionable node is present unless the status line reports `truncated=1`. Read the status line before the rows: `returned` rows, `act_sent/act_total` actionable delivered vs present, `truncated=1` (with `omitted` count; `omitted_top=1` means real controls were cut off), `no_windows=1` or `tree_blocked=1` (a scan failure, not an empty screen: retry, and check `recovered=1` on a later call), `x_extent`/`y_extent` when content reaches outside the screen. Prefer this over `mobile_screenshot` wherever it can see the screen; turn to a screenshot for canvas-drawn UI (maps, drawing), image-only content, and whenever a dump's status line looks wrong.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_args, val) => [{ type: "text", text: val }],
		},
		async execute(args) {
			try {
				const resp = await fetch(`${SERVER_BASE}/api/dump_ui`);
				const text = await resp.text();
				try {
					const data = JSON.parse(text);
					if (data && data.success === false) {
						const reason = data.message || "the gateway refused the dump";
						return `${reason}\n${data.data || ""}`;
					}
					// The gateway answers {success, message, data}: `message` is a one-line
					// count, `data` is the observation itself (a status line, a column line,
					// then one row per element). Hand the model the observation, NOT the
					// envelope — and say what the last dump lost, because a silent drop is
					// worse than a stated one.
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
		},
	}));

	// 4. mobile_click
	ctx.tools.register(defineTool({
		name: "mobile_click",
		description: "Tap or long-press at absolute pixel coordinates (x, y) on the target display. Omit duration_ms for a standard single tap; pass duration_ms (e.g. 500~1500) for a long press (useful for opening context menus, selecting text/messages, or press-and-hold interactions). Coordinates are only valid for the screen state of the LATEST observation: take them from `tap` when the node carries one, otherwise compute the centre as [(left+right)/2, (top+bottom)/2] from its `b`, using a fresh mobile_dump_ui result — never reuse coordinates after anything changed the screen. If a tap appears to have no effect, re-observe instead of tapping the same point again.",
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
			duration_ms: {
				type: "integer",
				description: "Optional press duration in milliseconds. Omit for standard instantaneous single tap (~50ms); pass 500~1500 for a long press (e.g. context menu, item selection, or hold action).",
			},
		},
		output: {
			schema: { type: "string" },
			render: (_args, val) => [{ type: "text", text: val }],
		},
		async execute(args) {
			const payload = { x: args.x, y: args.y };
			if (typeof args.duration_ms === "number" && args.duration_ms > 0) {
				payload.duration_ms = args.duration_ms;
			}
			const res = await postJson("/api/click", payload);
			if (!res.success) {
				throw new Error(`Click failed: ${res.message || "unknown error"}`);
			}
			const actionDesc = payload.duration_ms
				? `Long-pressed (${args.x}, ${args.y}) for ${payload.duration_ms}ms`
				: `Tapped (${args.x}, ${args.y})`;
			const resultText = `${actionDesc}. The screen has changed or is changing — run mobile_dump_ui again to see the result before the next action.`;
			return res.notice ? `${res.notice}\n${resultText}` : resultText;
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
			const resultText = `Swiped from (${args.x1}, ${args.y1}) to (${args.x2}, ${args.y2}) in ${duration}ms`;
			return res.notice ? `${res.notice}\n${resultText}` : resultText;
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
			const resultText = `Injected text: "${args.text}"`;
			return res.notice ? `${res.notice}\n${resultText}` : resultText;
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
			const resultText = `Pressed key: ${args.key}`;
			return res.notice ? `${res.notice}\n${resultText}` : resultText;
		},
	}));

	// 7.5. mobile_wait
	ctx.tools.register(defineTool({
		name: "mobile_wait",
		description: "Pause execution for a specified duration in milliseconds to wait for page transitions, asynchronous network loading, skeleton screens, or animations to finish before the next observation.",
		parameters: {
			duration_ms: {
				type: "integer",
				description: "Duration to wait in milliseconds (default: 1000, max: 10000)",
			},
		},
		output: {
			schema: { type: "string" },
			render: (_args, val) => [{ type: "text", text: val }],
		},
		async execute(args) {
			const ms = Math.min(Math.max(args.duration_ms || 1000, 100), 10000);
			await new Promise((resolve) => setTimeout(resolve, ms));
			return `Waited for ${ms}ms. UI state has settled. Proceed with observation (mobile_dump_ui or mobile_screenshot).`;
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
			const resultText = `Launched app ${args.package}${args.activity ? "/" + args.activity : ""}: ${res.message || "OK"}`;
			return res.notice ? `${res.notice}\n${resultText}` : resultText;
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
