#!/usr/bin/env node
//
// Resolve-test a preset composition before it is installed.
//
// Why this exists. install.sh has a gate, and its own comment states the intent exactly:
//
//   # The gate, and it runs BEFORE the copy: a plugin that cannot be mounted takes the whole
//   # preset down, and DSH then refuses to resume any session in this workspace ...
//   # Copying first and checking afterwards is too late, so nothing is written until this passes.
//   if ! node "$DIR/check-preset.mjs" "$SRC/mobile_plugin.js"; then
//
// But that gate is handed `mobile_plugin.js` only, while the copy that follows moves three
// files:
//
//   cp -f "$SRC/agent.cordis.yml" "$SRC/mobile_plugin.js" "$SRC/preset.yml" "$DST/"
//
// Every `name:` row in agent.cordis.yml is resolved by DSH at mount time, and a row that
// cannot be resolved takes the preset — and with it every session in that workspace — down:
//
//   preset "mobile-use" failed to mount: failed to import loader entry
//
// check-preset.mjs never parses this file, so such a row passes the gate, lands in $DST,
// and only fails later inside DSH. The gate covered one file fewer than it copies; this is
// the missing half.
//
// The check is deliberately dependency-free: a plain scan for `name:` rows plus Node's own
// resolver, anchored at the DSH installation that will actually mount the preset. The
// verdict therefore matches what DSH will do, without importing any DSH internals.
//
// usage: node check-composition.mjs [path/to/agent.cordis.yml] [path/to/dsh-package-root]
//
// exit 0 — every row resolves (or DSH could not be located; see the warning)
// exit 1 — at least one row names something that cannot be resolved
//
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const here = path.dirname(fileURLToPath(import.meta.url));
const composition = process.argv[2] ?? path.join(here, "preset/mobile-use/agent.cordis.yml");

const fail = (msg, detail) => {
	console.error(`FAIL: ${msg}`);
	if (detail) console.error(`  ${detail}`);
	process.exit(1);
};

// ── locate the DSH installation that will mount this preset ──────────────────
//
// install.sh runs from a bare checkout, where the composition sits next to no node_modules
// at all, so a resolver anchored at the composition directory finds nothing. DSH itself,
// however, is a global install — that is the tree whose `@deepseek-ai/dsh-*` packages the
// rows name. So we look in two families of places:
//
//   anchored resolution  — an explicit argv, the composition's own directory, the cwd
//   module roots         — $NODE_PATH entries, and the global node_modules implied by
//                          the running node binary's location
//
// If none works we cannot answer the question, and the honest answer is a warning rather
// than a block — refusing to install because *we* could not find DSH would be a different
// bug from the one this guards.
const locateDsh = () => {
	const anchored = [
		process.argv[3] && path.resolve(process.argv[3]),
		path.dirname(composition),
		process.cwd(),
	].filter(Boolean);

	for (const base of anchored) {
		try {
			const req = createRequire(path.join(base, "noop.js"));
			return path.dirname(req.resolve("@deepseek-ai/dsh/package.json"));
		} catch {}
	}

	// Global install layouts. A globally installed dsh lives in one of these two
	// node_modules roots, depending on platform:
	//   unix   <prefix>/lib/node_modules      (node at <prefix>/bin/node)
	//   win    <dir>/node_modules             (node at <dir>/node.exe)
	const nodeDir = path.dirname(process.execPath);
	const roots = [
		...(process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean),
		path.join(nodeDir, "node_modules"),
		path.join(path.dirname(nodeDir), "lib", "node_modules"),
	];

	for (const root of roots) {
		const guess = path.join(root, "@deepseek-ai", "dsh");
		if (existsSync(guess)) return guess;
	}

	return undefined;
};

const dshRoot = locateDsh();
if (!dshRoot) {
	console.warn(
		"WARN: could not locate a @deepseek-ai/dsh installation, so composition rows were " +
		"not resolve-tested. Pass the dsh package root as the second argument to check it.",
	);
	process.exit(0);
}

// ── collect the `name:` rows ────────────────────────────────────────────────
//
// A line scan rather than a YAML parse: the file's only structured use of `name:` is on
// plugin rows, and staying dependency-free keeps this runnable from a bare checkout.
const rows = [];
const lines = readFileSync(composition, "utf8").split(/\r?\n/);
for (const [i, line] of lines.entries()) {
	const m = /^\s*-?\s*name:\s*(.+?)\s*$/.exec(line);
	if (!m) continue;
	const raw = m[1].replace(/^['"]|['"]$/g, "");
	rows.push({ line: i + 1, name: raw });
}

if (rows.length === 0) fail(`no plugin rows found in ${composition}`);

// ── classify and resolve ────────────────────────────────────────────────────
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/; // cordis:group, node:fs, …
const RELATIVE = /^\.{0,2}\//;

const require_ = createRequire(path.join(dshRoot, "package.json"));
const problems = [];
const skipped = [];

for (const row of rows) {
	const { name } = row;

	if (SCHEME.test(name)) {
		skipped.push(`${name} (scheme — provided by the framework)`);
		continue;
	}
	if (RELATIVE.test(name)) {
		// The composition sits next to the files it names, and the whole preset directory
		// is what gets copied, so existence is the right test here.
		const target = path.resolve(path.dirname(composition), name);
		if (!existsSync(target)) {
			problems.push(`line ${row.line}: ${name} — no such file (${target})`);
		}
		continue;
	}

	try {
		require_.resolve(name);
	} catch (err) {
		problems.push(`line ${row.line}: ${name} — ${err.code ?? "unresolvable"}`);
	}
}

if (problems.length > 0) {
	console.error("FAIL: the composition names a plugin DSH cannot resolve:");
	for (const p of problems) console.error(`  - ${p}`);
	console.error("");
	console.error(
		"These rows are resolved at mount time. An unresolvable one takes the whole preset " +
		"down, and DSH then refuses to resume any session in this workspace.",
	);
	process.exit(1);
}

console.log(
	`OK: ${rows.length - skipped.length} composition rows resolve against ${dshRoot}` +
	(skipped.length ? ` (${skipped.length} skipped: ${skipped.join("; ")})` : ""),
);