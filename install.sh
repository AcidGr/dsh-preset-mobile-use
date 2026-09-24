#!/bin/bash
#
# Install this preset into the directory DSH actually loads it from.
#
# DSH reads presets from ${DSH_HOME:-$HOME/.dsh}/.agent-presets/<name>/, which is a
# COPY of preset/mobile-use/ — not a symlink. Editing the repository therefore changes
# nothing on its own. That has silently bitten three times: the paging removal (c920f43),
# the tree_blocked rewrite (f8b6fc8) and the load-breaking defects below all sat in the
# repo while DSH kept loading an older copy. Always run this after touching preset/.
#
# What needs a DSH restart and what does not (measured 2026-09-20):
#   agent.cordis.yml   picked up live — after installing, a 20060-char tool result came
#                      back intact where the old thresholdChars=14000 would have had its
#                      middle replaced
#   mobile_plugin.js   mounted at preset start — a restart is required for the tool
#                      descriptions and parameter schemas to change
#
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$DIR/preset/mobile-use"
DST="${DSH_HOME:-$HOME/.dsh}/.agent-presets/mobile-use"

if [ ! -d "$DST" ]; then
	echo "no preset installed at $DST — nothing to update" >&2
	exit 1
fi

# The gate, and it runs BEFORE the copy: a plugin that cannot be mounted takes the whole
# preset down, and DSH then refuses to resume any session in this workspace —
#
#   preset "mobile-use" failed to mount: failed to import loader entry
#   tool-mobile-use(./mobile_plugin.js): Unexpected identifier 'did'
#
# which is exactly what this script installed without looking, on 2026-09-20. Copying
# first and checking afterwards is too late, so nothing is written until this passes.
# `node --check` is NOT a substitute: it exits 0 on this file's syntax errors because it
# parses a file that uses ESM syntax as CommonJS. See check-preset.mjs.
if ! node "$DIR/check-preset.mjs" "$SRC/mobile_plugin.js"; then
	echo "refusing to install: the plugin does not mount (see the failure above)" >&2
	exit 1
fi

# The other half of the same gate, and for the same reason. The copy below moves three
# files, not one — agent.cordis.yml among them — and every `name:` row in that file is
# resolved by DSH at mount time. An unresolvable row fails exactly like an unimportable
# plugin: the preset does not mount, and DSH then refuses to resume any session in this
# workspace. check-preset.mjs never reads agent.cordis.yml, so such a row used to pass the
# gate and only surface later inside DSH. Still before the copy.
if ! node "$DIR/check-composition.mjs" "$SRC/agent.cordis.yml"; then
	echo "refusing to install: the composition names a plugin that cannot be resolved" >&2
	exit 1
fi

cp -f "$SRC/agent.cordis.yml" "$SRC/mobile_plugin.js" "$SRC/preset.yml" "$DST/"
cp -f "$SRC/mobile_plugin.js" "$DIR/lib/index.js"

diff -rq "$SRC" "$DST"
echo "installed into $DST"
echo "agent.cordis.yml takes effect now; restart DSH to remount mobile_plugin.js"
