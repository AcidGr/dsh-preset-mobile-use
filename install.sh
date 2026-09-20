#!/bin/bash
#
# Install this preset into the directory DSH actually loads it from.
#
# DSH reads presets from ${DSH_HOME:-$HOME/.dsh}/.agent-presets/<name>/, which is a
# COPY of preset/mobile-use/ — not a symlink. Editing the repository therefore changes
# nothing on its own. That has silently bitten twice: the paging removal (c920f43) and
# the tree_blocked rewrite (f8b6fc8) both sat in the repo while DSH kept loading a copy
# from 2026-09-19. Always run this after touching preset/.
#
# What needs a DSH restart and what does not (measured 2026-09-20):
#   agent.cordis.yml   picked up live — after installing, a 20060-char tool result came
#                      back intact where the old thresholdChars=14000 would have had its
#                      middle replaced
#   mobile_plugin.js   mounted at preset start — a restart is required for the tool
#                      descriptions and parameter schemas to change
#
set -e

SRC="$(cd "$(dirname "$0")" && pwd)/preset/mobile-use"
DST="${DSH_HOME:-$HOME/.dsh}/.agent-presets/mobile-use"

if [ ! -d "$DST" ]; then
	echo "no preset installed at $DST — nothing to update" >&2
	exit 1
fi

cp -f "$SRC/agent.cordis.yml" "$SRC/mobile_plugin.js" "$SRC/preset.yml" "$DST/"

diff -rq "$SRC" "$DST"
echo "installed into $DST"
echo "agent.cordis.yml takes effect now; restart DSH to remount mobile_plugin.js"
