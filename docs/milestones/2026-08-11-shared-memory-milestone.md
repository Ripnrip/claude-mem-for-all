# Milestone: Shared Memory for All Agents

**Date:** 2026-08-11  
**Repo:** `Ripnrip/claude-mem-for-all` (fork of `thedotmack/claude-mem`)  
**Participants:** Letta-Chan, Letta Slack Bot (Berserker), Codex, Admin (senpai)

## Summary

Transformed a Claude-only memory system into a universal shared memory backend that any agent (Codex, Cursor, Letta, Hermes, and others) can read and write to. Fixed critical cross-agent recall bugs where observations written by one platform were invisible to another. Extracted the shell "moat" into a testable resolver. All work verified against a live database with 2,985+ real observations.

## What was broken

1. **Codex hooks were gated behind a version-check** — after every marketplace update, the context hook never ran, silently suppressing memory injection (BIN-256)
2. **Codex was missing the worker start hook** — cold boot raced with Chroma warming, frequently timing out (BIN-257)
3. **Cursor adapter stripped all context** — `formatOutput()` returned only `{ continue: true }`, discarding `hookSpecificOutput` and `systemMessage` entirely (BIN-258)
4. **The "virgin project" lie** — the welcome gate filtered by `platformSource`, so Codex observations were invisible to Claude reads and vice versa. The system returned "this project has no memory yet" even when 900+ observations existed (BIN-279, BIN-281)
5. **Worktree composite mismatch** — `getProjectContext()` derived different project keys from different cwds in the same git repo (BIN-280)
6. **Context generation still filtered by platform** — even after the welcome gate was fixed, `handleContextInject` forwarded `platformSource` to `generateContextWithStats`, which filtered the actual SQL queries (Codex PR#6 P1)
7. **Negative cache was permanent** — once a project was seen as empty, new observations were invisible until process restart (Codex PR#9 P1)
8. **Shell prelude was unmaintainable** — ~1,230 chars of PATH recovery + plugin discovery + cygpath translation inlined as escaped JSON in every hook entry (BIN-283)

## What we shipped

### PRs (all merged, 11 total)

| PR | Title | BIN | Agent |
|----|-------|-----|-------|
| #1 | Universal shared memory backend | — | Letta-Chan |
| #2 | Agent connect — one-command bootstrap | — | Letta-Chan |
| #3 | Unshackle Codex + Cursor hooks | BIN-256/257/258 | Letta-Chan + Codex review |
| #4 | Welcome gate visibility | BIN-282 | Letta-Chan |
| #5 | Worktree project identity fallback | BIN-280 | Letta-Chan + Codex review |
| #6 | Remove platformSource filter from welcome gate | BIN-281 | Letta-Chan |
| #7 | Cross-session E2E proof | BIN-279/280/281 | Letta-Chan |
| #8 | Shell prelude extraction (resolver script) | BIN-283 | Letta-Chan |
| #9 | Codex review fixes (5 items) | — | Letta-Chan |
| #10 | Resolver in plugin tree + npm files | BIN-283 | Letta-Chan + Codex review |
| #11 | TTL-bound negative cache | — | Letta-Chan |

### Key fixes

- **Dual-hook Codex SessionStart:** worker start + context injection, no version-check gate
- **Cursor adapter:** passes through `hookSpecificOutput`, `systemMessage`, `suppressOutput`
- **Welcome gate:** no longer filters by platformSource — any agent sees any agent's observations
- **Worktree fallback:** strips `parent/child` composites and retries with parent basename
- **Context generation:** removed platformSource from inject request entirely
- **Negative cache:** TTL-bounded (30s) so new observations are picked up promptly
- **Plugin root resolver:** standalone `resolve-plugin-root.sh` replaces the inline shell monster

### Artifacts shipped

- `plugin/scripts/resolve-plugin-root.sh` — standalone resolver (both dev `scripts/` and `plugin/scripts/`)
- `plugin/scripts/claude-mem-hook-launcher.swift` — Swift launcher (by Letta Slack Bot)
- Both included in `package.json` files field for npm distribution

## Verification

- **78 tests** across 10 files pass (route, e2e, hooks, cli, scripts)
- **533 tests** in Letta Slack Bot's full suite pass
- **Live E2E** against real `Developer` DB (905 observations):
  - `platformSource=claude` → 50 obs, 12,016 tokens
  - `platformSource=codex` → 50 obs, 12,016 tokens (identical)
  - No platformSource → 50 obs, 12,016 tokens
- All hooks verified: SessionStart/start, SessionStart/context, UserPromptSubmit, PostToolUse, Stop/summarize
- Codex + Claude Code + Cursor adapters all return correct output shapes

## What's left

- **Deploy** — install the fork as the live claude-mem on the fleet
- **PR upstream** — send fixes to `thedotmack/claude-mem` so everyone benefits
- **Swift launcher** — the resolver script is the interface contract; a Swift binary can replace the implementation on Darwin without touching any hook JSON
- **Linear free-tier** — consider migrating tickets to Multica/Habitat (HAB- prefix)
