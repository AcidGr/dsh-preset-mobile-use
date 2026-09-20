#!/usr/bin/env node
//
// Load-test a preset plugin before it is installed.
//
// Why this exists. On 2026-09-20 an unimportable plugin was copied into
// ~/.dsh/.agent-presets/mobile-use/, and DSH could no longer resume ANY session in this
// workspace:
//
//   preset "mobile-use" failed to mount: failed to import loader entry
//   tool-mobile-use(./mobile_plugin.js): Unexpected identifier 'did'
//
// Two independent defects were in the file, both introduced when the dump tool's paging
// parameters were removed:
//
//   1. the description string contained an unescaped `"` (`answers "did the call work"`),
//      so the file was not valid JavaScript at all;
//   2. `mobile_dump_ui` had lost its `parameters` key entirely, and DSH requires one:
//      "unsupported JSON schema: parameters must be an object of value schemas".
//
// The check that was supposed to catch (1) was `node --check`, which does NOT report
// syntax errors in a file that uses ESM syntax — it parses such a file as CommonJS and
// exits 0. Measured:
//
//   node --check bad-esm.js                 -> exit 0   (a file with `import` and a bad quote)
//   node --input-type=module --check < bad  -> exit 1
//
// So this script imports the file for real, mounts it against a stand-in ctx, and then
// validates every registered tool the way DSH does.
//
// usage: node check-preset.mjs [path/to/mobile_plugin.js]
//
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";

// fileURLToPath, not url.pathname — this repo's own path contains a space.
const file = process.argv[2] ?? path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"preset/mobile-use/mobile_plugin.js",
);

const fail = (msg, detail) => {
	console.error(`FAIL: ${msg}`);
	if (detail) console.error(`  ${detail}`);
	process.exit(1);
};

let mod;
try {
	mod = await import(pathToFileURL(file).href);
} catch (err) {
	fail(`cannot import ${file}`, err.message);
}

if (typeof mod.apply !== "function") fail(`${file} does not export apply()`);

// The plugin only ever reaches for these three; anything else it needs will throw
// loudly, which is the behaviour we want from a load test.
const registered = [];
const ctx = {
	tools: { register: (tool) => registered.push(tool) },
	on: () => {},
	get: () => undefined,
};

try {
	await mod.apply(ctx);
} catch (err) {
	fail("apply() threw", err.message);
}

if (registered.length === 0) fail("apply() registered no tools");

const problems = [];
const seen = new Set();
for (const tool of registered) {
	const name = tool?.name ?? "(unnamed)";
	if (seen.has(name)) problems.push(`${name}: registered twice`);
	seen.add(name);
	if (typeof tool?.name !== "string" || !tool.name) problems.push(`${name}: missing name`);
	if (typeof tool?.description !== "string" || !tool.description) {
		problems.push(`${name}: missing description`);
	}
	if (typeof tool?.execute !== "function") problems.push(`${name}: missing execute()`);
	// DSH's rule, quoted from its own rejection message.
	if (tool?.parameters === null || typeof tool?.parameters !== "object" || Array.isArray(tool?.parameters)) {
		problems.push(
			`${name}: parameters must be an object — DSH rejects this with ` +
			`"unsupported JSON schema: parameters must be an object of value schemas"`,
		);
	}
}

if (problems.length > 0) {
	console.error("FAIL: tool definitions DSH would reject:");
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}

console.log(`OK: ${registered.length} tools mount cleanly — ${registered.map((t) => t.name).join(", ")}`);
