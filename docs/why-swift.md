# Why Swift for claude-mem-for-all

The reference implementation of `claude-mem-for-all` is a single-file Swift CLI.
This page explains the choice, what it buys, and when a shell script or Python
one-liner would actually be the right call.

## The problem claude-mem-for-all solves

claude-mem's own hooks watch only Claude Code / Codex session JSONLs.
Any other runtime — a Hermes session, a pi agent, a cron job, a hand-written
note — has no path into the same shared store. `claude-mem-for-all` is the bridge:
it takes a learning from any agent and writes it directly into claude-mem's SQLite
store as one `sdk_sessions` row + one `observations` row, provenance-tagged so the
store stays honest about where each memory came from.

This is not a word-count utility. It touches a live database on localhost, owns
dedup keys, parses frontmatter, and must be idempotent across rebuilds and re-runs.
Choosing the implementation language is a tradeoff between "how hard is this to
ship once" and "how trustworthy is this the hundred-and-first time it runs".

## What Swift gives

- **Attributed macOS permission grants.** TCC dialogs name the requesting binary's
  *code identity*, not the interpreter. A Swift binary named `claude-mem-for-all`
  with a stable identifier shows up as itself in System Settings; a runaway `python`
  process shows as "Python", unattributable, indistinguishable from malware.
  This matters the moment the bridge is ever pointed at Reminders, keychain, or
  anything Apple treats as user data. See `Swift Over Bash` canon.
- **Deterministic, local, no runtime.** One static binary on the host. No `npx`,
  no `pip install`, no venv activation, no postinstall scripts, no postinstall
  scripts that quietly rewrite `package.json`. The binary can be co-located with
  the note it's filing and invoked with one line. That matters for cron jobs and
  agent hooks where the environment may not be the one you tested in.
- **Strong typing for the hard parts.** Frontmatter parsing, ISO8601 datings,
  UUIDv5 dedup keys, SQLite3 bindings — all compile-time-checked. The kind of
  data-shape bugs that produce wrong dedup keys (the worst failure mode: two
  different memories sharing one key and the second silently overwrites the first)
  are caught at compile time rather than surfacing as a mystery in the store six
  months later.
- **Cryptographic primitives in stdlib.** `CryptoKit` ships UUIDv5, SHA1, and the
  byte manipulation needed for RFC 4122 without a dependency. The dedup contract
  (byte-identical to Python's `uuid.uuid5(NAMESPACE_URL, …)`) is expressible in
  twelve lines and testable against a known reference.
- **Single-file, single-command build.** One `swiftc -O` invocation. No package
  manager, no manifest, no lockfile drift. That keeps the artifact small enough to
  distribute as a co-located file alongside a project's scripts, and small enough
  that the source itself is readable as documentation.

## Where it's not the right tool

- **Quick ad-hoc one-liner that will never touch anything sensitive and will never
  be re-run.** A `curl | jq` post to `/api/import` is fine for a throwaway.
- **Cross-platform wheel you must ship to Linux and Windows** where you'd rather
  have the ecosystem's installers than a static binary. (claude-mem-for-all targets
  the macOS side of the bridge where the agent runtime is; the store is on localhost.)
- **When you already have a Python service that owns the same database connection**
  and adding another process is worse than adding another import. The Swift CLI is
  for the *external* agent case, not for codifying the same logic twice inside the
  worker.

## The implementation shape

The canonical copy lives at `tools/claude-mem-for-all.swift` in this repo (a
canonical copy is also kept in the multibrain repo for agent-side quick access).
It is structured as:

1. **Checkpoint parser** — reads multibrain `07-Sessions/*.md` frontmatter
   (`---`-delimited YAML), extracts `project`, `type`, `tags`, and derives the
   title from the filename. Falls back cleanly when frontmatter is absent.
2. **UUIDv5 dedup keys** — `content_session_id` derived from the file path; `content_hash`
   derived from session id + title, so re-running on the same note is a no-op
   (`ALREADY PRESENT`). Keys are deterministic so neither the Swift CLI nor the
   Python reference can both deposit the same note twice.
3. **SQLite3 write** — opens the store read-write, inserts the session row and the
   observation row in one transaction-style sequence, records `platform_source`
   and `agent_type` so provenance survives.
4. **Exit contract** — `0` on insert or already-present, `1` on bad input,
   `2` on database error. Nothing ambiguous.

## Why not Python

Python has the ecosystem. For this shape of tool, that ecosystem is mostly cost.

- **Interpreter identity.** The same TCC story applies: an unnamed python blob is
  not a trustworthy identity on macOS.
- **Runtime surface.** A python bridge that touches a SQLite DB and parses markdown
  pulls in a venv, a sqlite3 module, possibly a json library if the environment is
  minimal. On a machine where the note lives, that's a dependency footprint for a
  one-shot tool.
- **Dedup correctness.** Python's `uuid.uuid5` is well-defined, but the *caller*
  carrying the same byte contract is what makes dedup work across two runtimes. A
  Swift implementation that mirrors the RFC gives an independent, testable
  implementation to cross-check against — not an accident of "we used Python" both
  places.

That said, the Python reference (`~/.multibrain/bin/claude-mem-for-all.py`, kept
as reference in the codebase) is the canonical *contract definition* — the Swift
CLI implements the same contract. Both should produce the same dedup keys for the
same input. That's the invariant, not which language wrote it.

## Why not bash

Bash is observation, not implementation. It's right for `ps`, `tail -f`, `ls`.
It is not right for a tool that owns a database write, parses structured text,
and must be idempotent with deterministic keys. The `Swift Over Bash` canon on
this machine exists precisely because the cost of getting the wrong category wrong
is an unattributable process holding a permission grant you did not mean to grant.
