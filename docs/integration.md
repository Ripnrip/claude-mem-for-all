# Integration guide — every agent, one memory store

`claude-mem-for-all` is the bridge from any agent's session into the shared
claude-mem SQLite store. This page is the per-agent recipe: how to wire each
runtime so its learnings land in the store with honest provenance, how to make
it idempotent, and where each path breaks.

The canonical CLI lives at `tools/claude-mem-for-all.swift` in this repo (a
co-located copy is in the multibrain repo for agent-side quick access). Build
once: `swiftc -O -o claude-mem-for-all tools/claude-mem-for-all.swift`. Use
the same binary everywhere — the dedup contract is byte-identical across callers
only when they share the same implementation.

## The shape of every deposit

Every call produces one `sdk_sessions` row + one `observations` row in the
claude-mem store:

```
sdk_sessions
  content_session_id  — UUIDv5 from session key (stable per note)
  memory_session_id   — UUIDv5 (same namespace)
  project             — agent/project slug
  user_prompt         — short description of why this exists
  started_at / started_at_epoch
  completed_at / completed_at_epoch
  status = 'completed'
  platform_source     — the agent's identity, e.g. 'hermes', 'pi', 'aider'
  (agent_type optional — finer granularity if the agent distinguishes)

observations
  memory_session_id   — matches sdk_sessions.memory_session_id
  project
  text                — short title/subtitle
  type                — 'feature' / 'milestone' / 'lesson' / ...
  title               — human-readable
  subtitle            — same or a one-liner
  facts               — JSON array (optional)
  narrative           — the body (up to 4000 chars)
  concepts            — JSON array of tags
  files_modified      — JSON array of touched files (optional)
  created_at / created_at_epoch
  content_hash        — UUIDv5(sessionKey + title) — dedup key
  agent_type          — optional
```

The **dedup key** is `content_hash`. Two deposits with the same session key and
the same title collide. Two deposits from different agents with the same title
do *not* collide — they coexist as separate rows under different session ids.
That's intentional: if Hermes and pi both learn "dark mode is preferred",
that's two learnings, not one overwritten. If the *same* agent re-runs on the
same note, it's a no-op (`ALREADY PRESENT`).

## The two call shapes

### File-based (for checkpoint notes)

```
claude-mem-for-all --file /path/to/checkpoint.md
```

The CLI parses multibrain `07-Sessions/*.md` frontmatter — `project`, `type`,
`tags` under the `---` block — and derives the title from the filename. Falls
back to filename-based title when frontmatter is absent. Reads the body up to
4000 chars as the narrative. Platform source defaults to the caller's identity
(`pi`, `hermes`, …); override with `--platform`.

```
claude-mem-for-all --file ~/Developer/multibrain/07-Sessions/2026-09-06--codenotch-build-install--hermes.md
# → INSERTED observations.id=5823 (platform_source=pi, project=misc)
# → On re-run: ALREADY PRESENT (observations.id=5823) — skipping (idempotent)
```

**This is the primary path.** A session finishes, writes its checkpoint note,
runs the CLI once. Done.

### Inline (for agents without checkpoint notes)

```
claude-mem-for-all \
  --project myagent \
  --title "User prefers dark mode in settings" \
  --narrative "Observed during session xyz: user switched to dark mode and did \
not switch back. Likelihood they want it default = high." \
  --facts "dark-mode,preference" \
  --concepts "preferences,ui" \
  --files Settings.swift,ThemeCoordinator.swift \
  --platform hermes
```

Use this when the agent doesn't write checkpoint notes and you want a learning
in the store without inventing a markdown file first. Keep `narrative` under
4000 chars; the CLI trims.

### Dry-run

```
claude-mem-for-all --file checkpoint.md --dry-run
# [dry-run] project=misc platform=pi title=2026-09-06 — codenotch-build-install — hermes
#   concepts=[misc] files=5 narrative=2108c
```

Parses and prints what it *would* deposit. No write. Useful before wiring into
an agent's hook to sanity-check frontmatter parsing.

## Hooks-closed agents: Claude Code

**What already works:** claude-mem's own hooks watch Claude Code sessions
automatically — SessionStart → session-init → observations on every tool use →
summarize on stop. You do not need `claude-mem-for-all` for Claude Code's own
sessions; that's the core product.

**When to use the CLI from Claude Code:** when the *session itself* is not a
claude-mem session — e.g. the agent is running in a Claude Code *instance* but
you want a learning attributed as a different `platform_source`, or the learning
is offline (post-mortem, review, a build result) and not part of a live session's
tool-use stream.

Recipe: write the checkpoint note as the session's normal output artifact, then
call the CLI as the last step of the session (or as a post-session hook). The
note is the source of truth; the CLI is the transporter into the shared store.

Do not double-deposit. If the session's tool-use stream already produces claude-mem
observations for the same content, pick one path or the other — not both. The
dedup key will save you from a collision, but two rows asserting the same fact
under different session ids is noise, not provenance.

## Hooks-closed agents: Codex

Same shape as Claude Code. Codex's SessionStart hooks are already wired (dual-hook
design — worker bootstrap + memory injection). The CLI is for the same cases as
Claude Code: offline, cross-attributed, or post-session learnings that don't belong
in the live tool-use stream.

## Hooks-open agents: Cursor

Cursor hooks are not claude-mem's to own. The fork's Cursor marketplace
(`claude-mem-cursor/`) ships independent hooks, but that's the *Cursor-side*
integration — the agent running inside Cursor still needs a path into the shared
store for learnings that aren't part of Cursor's hook contract.

Recipe: if Cursor's own hooks cover the session, trust them. If you're running
an agent *inside* Cursor that produces a checkpoint or a learned fact, call the
CLI with `--platform cursor` (or the specific agent name if Cursor distinguishes).
Don't assume Cursor's hook surface covers every kind of learning — it covers the
session, not the post-session.

## Hooks-open agents: Antigravity

Same as Cursor: Antigravity has its own hook surface in the fork, but the CLI is
for learnings that live *outside* Antigravity's hook contract. Call with
`--platform antigravity` when that's what ran.

## External agents: Hermes

Hermes sessions produce checkpoint notes in `multibrain/07-Sessions/`. The
primary recipe:

1. Session finishes, writes checkpoint note.
2. Knowledge-sync skill fans the note out: vault copy, twinkie/Changelog, qdrant,
   claude-mem via `claude-mem-for-all --file <checkpoint.md>`.

That's it. The `--platform` is `hermes` by default (the CLI derives platform
source from the caller's identity; if invoked from Hermes, it's `hermes`).

**Don't** also write Hermes learnings inline via `--narrative` when you have a
checkpoint note — the note is the artifact, the CLI is the transporter. Pick one
source of truth.

## External agents: pi

pi doesn't (yet) have a hook contract into claude-mem. The recipe is the same as
Hermes: pi writes a checkpoint or a learned-fact note, then calls the CLI with
`--platform pi`. If pi writes structured learnings (not markdown), use the inline
form with `--project pi --title … --narrative …`.

## External agents: Aider

Aider sessions are scriptable. Recipe: after an Aider session, if there's a
learned fact worth persisting, call the CLI inline with `--platform aider`. If
Aider produces a session log or diff you want to persist as a milestone, write a
short markdown checkpoint and use the file form.

## External agents: scripts and cron

The CLI is *specifically* designed for this. A cron job that runs a build, a test
suite, a migration, a deploy — any of those can produce a learning worth storing.

Recipe:

1. Script does its work.
2. If it produced a verifiable result worth remembering, write a one-line markdown
   checkpoint (or use `--narrative` inline) with the outcome.
3. Call `claude-mem-for-all --file <checkpoint.md> --platform <cron-or-script-name>`.

The CLI is idempotent, so a cron job that re-runs every hour on the same note
does nothing harmful on the second and subsequent runs. That's the whole point of
the dedup contract: the store reflects *what was learned*, not *how many times
the script ran*.

## The CLAUDE_MEM_ALLOW_ANY_AGENT flag

The store has a setting `CLAUDE_MEM_ALLOW_ANY_AGENT` (default `true`) that
preserves each connecting agent's own identity as `platform_source` instead of
collapsing unknown agents to `claude`. The CLI sets `platform_source` explicitly
via `--platform` (defaulting to the caller), so this flag mostly affects agents
that connect through the HTTP API without the CLI.

Make sure it's enabled if you want per-agent attribution. If it's disabled, agents
you haven't whitelisted collapse to `claude`, and the provenance story breaks.

## What not to do

- **Don't call both the file form and the inline form for the same learning.**
  Pick the source of truth.
- **Don't call the CLI from an agent's hook on every tool use.** That's the
  claude-mem hook's job for the agents it watches. The CLI is for the learnings
  that live *outside* the tool-use stream.
- **Don't invent platform_source slugs that collide with known aliases.** Known
  aliases (`claude`, `codex`, `cursor`) are normalized. If you write `--platform
  claude` from an agent that isn't actually Claude Code, you're lying to the store
  and the provenance story is broken.
- **Don't write a learning with empty or missing `platform_source`.** The store
  falls back to `claude`, which is the wrong attribution for an external agent.
  Always pass `--platform`.
- **Don't depend on the CLI being present in `$PATH` in every environment.** The
  canonical build is a static binary; ship it alongside the scripts that call it,
  or build it at deploy time. Don't assume `which claude-mem-for-all` works
  everywhere.

## Verification

After wiring an agent, verify:

```bash
# The note landed
sqlite3 ~/.claude-mem/claude-mem.db \
  "SELECT id, project, platform_source, title, datetime(created_at_epoch,'unixepoch','localtime') \
   FROM observations WHERE title LIKE '%<slug>%' LIMIT 1"

# Dedup works
claude-mem-for-all --file checkpoint.md
# first run: INSERTED observations.id=N
# second run: ALREADY PRESENT (observations.id=N) — skipping

# API search finds it (eventually — FTS is immediate, ranking may lag)
curl -s "http://localhost:37877/api/search?q=<unique phrase from narrative>"
```

If the note doesn't show up in search, FTS is the proof, not the API ranking.
Direct DB query is the ground truth.

## Adding a new agent

The recipe for a new agent you're integrating:

1. Decide whether it produces checkpoint notes (file form) or inline learnings
   (inline form).
2. Decide the `platform_source` slug — short, lowercase, hyphenated, unique to
   that agent. `myagent`, not `MyAgent` or `my-agent-that-runs-on-tuesdays`.
3. Wire the call into the agent's post-session or post-learning step.
4. Verify with the SQLite query above — the `platform_source` column is the proof.
5. If the agent is going to be a regular producer of learnings, add it to the
   known-agents list in whatever docs surface agent identities (this page, the
   universal-memory doc, the docs.json nav).
