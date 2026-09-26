import assert from "node:assert";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL("dsh-preset-mobile-use/preset/mobile-use/mobile_plugin.js").href);

let registeredTool = null;
const ctx = {
	tools: { register: (t) => { registeredTool = t; } },
	on: () => {},
	get: () => undefined,
};

await mod.apply(ctx);

assert(registeredTool, "tool should be registered");
assert.strictEqual(registeredTool.name, "mobile");

const schema = registeredTool.parameters;
assert(schema, "parameters must exist");
assert.strictEqual(schema.type, "object");
assert.deepStrictEqual(schema.required, ["action"]);

const props = schema.properties;

// 1. Verify action
assert.deepStrictEqual(props.action.enum, [
	"observe",
	"click",
	"swipe",
	"type",
	"key",
	"wait",
	"launch_app",
	"list_apps",
	"switch_mode",
]);
assert(!props.action.enum.includes("status"), "status must not be in action enum");
for (const act of props.action.enum) {
	assert(props.action.description.includes(`'${act}'`), `action.description must include '${act}'`);
}

// 2. Verify coordinate fields
assert.strictEqual(props.coordinate.type, "array");
assert.strictEqual(props.end_coordinate.type, "array");
assert.strictEqual(props.x, undefined, "x should be removed");
assert.strictEqual(props.y, undefined, "y should be removed");
assert.strictEqual(props.x2, undefined, "x2 should be removed");
assert.strictEqual(props.y2, undefined, "y2 should be removed");
assert.strictEqual(props.activity, undefined, "activity should be removed");

// 3. Verify mode & target_mode
assert.deepStrictEqual(props.mode.enum, ["tree", "visual"]);
assert.deepStrictEqual(props.target_mode.enum, ["foreground", "background", "idle"]);

// 4. Verify parameter count: action, coordinate, end_coordinate, target, text, duration_ms, mode, target_mode = 8
assert.strictEqual(Object.keys(props).length, 8);

// 5. Verify mobile description
assert(registeredTool.description.includes("Auto-switches to 'idle' on session end"), "mobile.description should include auto-switch idle");

console.log("All parameter schema assertions passed!");
