#!/usr/bin/env bash
# resolve-plugin-root.sh — Standalone plugin root resolver for claude-mem hooks.
#
# Extracted from the inline shell prelude in hook-shell-template.ts (BIN-283).
# Previously, ~1230 chars of PATH recovery + plugin discovery + cygpath
# translation was inlined into every hook JSON entry as an escaped string.
# This script replaces that monster with one clean invocation.
#
# Usage:
#   source "$(dirname "$0")/resolve-plugin-root.sh"
#   node "$CLAUDE_MEM_PLUGIN_ROOT/scripts/bun-runner.js" "$CLAUDE_MEM_PLUGIN_ROOT/scripts/worker-service.cjs" <args>
#
# Or, to just resolve and echo the root (for debugging):
#   bash resolve-plugin-root.sh
#
# Exits 1 if no plugin root is found.
#
# The fallback chain ORDER is contractual (mirrors resolveWorkerScript in
# src/shared/worker-utils.ts and the old inline prelude):
#   1. ${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}   (host-injected env)
#   2. cache directories (highest version first, .orphaned_at dirs skipped)
#   3. $_C/plugins/marketplaces/thedotmack/plugin (marketplace install)

# Note: no `set -e` here — the while-read pipeline's final `read` returns
# non-zero when the pipe closes, which under `set -e` would kill the script
# even though resolution succeeded. Errors are handled explicitly below.

# --- PATH recovery -----------------------------------------------------------
# Hosts like Codex launch hooks with a minimal env that doesn't source
# .zshrc/.bashrc. Recover the login shell's PATH so `node` and `bun` resolve.
_HP=$(printenv PATH 2>/dev/null || true)
if [ -z "$_HP" ] && [ -n "${SHELL:-}" ]; then
  _HP=$("$SHELL" -lc 'printf %s "$PATH"' 2>/dev/null || true)
fi
_HP=$(printf '%s' "$_HP" | tr ' ' ':')
export PATH="${_HP:+$_HP:}$PATH"

# --- Plugin root discovery ---------------------------------------------------
_C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
_E="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
_F=
_P=$({
  # 1. Host-injected env
  [ -n "$_E" ] && printf '%s\n' "$_E"

  # 2. Cache directories: version-sorted (newest first), skip orphaned dirs
  for _V in "$_C/plugins/cache/thedotmack/claude-mem"/[0-9]*/; do
    [ -d "$_V" ] || continue
    [ -e "${_V}.orphaned_at" ] && continue
    _B=${_V%/}
    _B=${_B##*/}
    # Parse version into zero-padded sort key: major.minor.patch + prerelease flag
    case "$_B" in (*-*) _G=0;; (*) _G=1;; esac
    _N=${_B%%-*}
    _M1=${_N%%.*}
    case "$_N" in (*.*) _T=${_N#*.};; (*) _T=0;; esac
    _M2=${_T%%.*}
    case "$_T" in (*.*) _U=${_T#*.};; (*) _U=0;; esac
    _M3=${_U%%.*}
    _M1=${_M1%%[!0-9]*}
    _M2=${_M2%%[!0-9]*}
    _M3=${_M3%%[!0-9]*}
    printf '%08d%08d%08d%d %s\n' "${_M1:-0}" "${_M2:-0}" "${_M3:-0}" "$_G" "$_V"
  done 2>/dev/null | sort -r | sed 's/^[^ ]* //'

  # 3. Marketplace install dir
  printf '%s\n' "$_C/plugins/marketplaces/thedotmack/plugin"
} | while IFS= read -r _R; do
  _R="${_R%/}"
  [ -d "$_R/plugin/scripts" ] && _Q="$_R/plugin" || _Q="$_R"
  [ -f "$_Q/scripts/bun-runner.js" ] && [ -f "$_Q/scripts/worker-service.cjs" ] && [ -z "$_F" ] && {
    _F=1
    printf '%s\n' "$_Q"
  }
done)

if [ -z "$_P" ]; then
  echo "claude-mem: plugin scripts not found" >&2
  exit 1
fi

# --- Cygwin/Windows path normalization --------------------------------------
command -v cygpath >/dev/null 2>&1 && {
  _W=$(cygpath -w "$_P" 2>/dev/null)
  [ -n "$_W" ] && _P="$_W"
}

# --- Export for callers ------------------------------------------------------
export CLAUDE_MEM_PLUGIN_ROOT="$_P"

# If sourced, the caller gets CLAUDE_MEM_PLUGIN_ROOT in their env.
# If executed directly, print the resolved path.
if [ "${BASH_SOURCE[0]:-$0}" != "${0}" ]; then
  return 0 2>/dev/null || exit 0
else
  printf '%s\n' "$_P"
  exit 0
fi
