# Key differences

What `claude-mem-for-all` is, and isn't, compared to the things it competes with.

## vs upstream claude-mem

claude-mem's hooks watch only **Claude Code / Codex** session JSONLs. They compress
tool usage into observations automatically, and inject relevant context into future
sessions of the same agent. That's the core product.

claude-mem-for-all is the **external agent bridge**. It is not a hook. It does not
watch a JSONL, it does not run as a pre/post hook inside another agent's session.
It is a one-shot CLI (`claude-mem-for-all --file checkpoint.md`) that deposits
a learning from any runtime into the same SQLite store claude-mem owns, tagged with
`platform_source` and `agent_type` so provenance survives. The destination is the
same store; the path in is different.

The fork adds three things on top of upstream:

- **`claude-mem-for-all` CLI** — the bridge itself (Swift, idempotent).
- **Swift hook launcher (BIN-283)** — Darwin dispatch for plugin hooks with node
  fallback, replacing unnamed interpreter processes for the TCC reason.
- **Dual-hook Codex SessionStart (BIN-253/254)** — worker bootstrap and memory
  injection as separate hooks; the version-check.js gate is gone.

Everything else in the fork is merged upstream work (Cursor/Grok-bot marketplaces,
Observation TV, cmem-pro-headless docs, Antigravity CLI Phase B, server feature
work).

## vs a hand-rolled Python bridge

A Python script that `pip install`s its dependencies, opens the same SQLite file,
and inserts the same rows is the obvious alternative. The difference is not "can
it work" but "what does it cost to trust it across one hundred runs":

| Concern | Swift CLI | Python bridge |
|---|---|---|
| Identity on macOS | named binary, attributable | unnamed interpreter, unattributable |
| Runtime deps | none (static binary) | venv, modules, environment |
| Dedup contract | RFC 4122 UUIDv5 in CryptoKit, testable against a known reference | uuid.uuid5, correct but coupled to one runtime |
| Build | one `swiftc -O` | `pip install` / venv / interpreter availability |
| Single-file distribution | yes (co-located with scripts) | no (script + deps) |
| Reading the source | one file, compile-time-checked shapes | import tree, runtime surprises possible |

Neither is magic. Both insert into SQLite. The Swift CLI is the case where the
ecosystem cost of Python is higher than the ecosystem benefit, for a one-shot tool
that touches a local database and must be idempotent.

## vs a curl one-liner

`curl -X POST http://localhost:37877/v1/memories …` works for a throwaway.
It's a fine choice for a one-off that will never be re-run and never touches
anything sensitive. It's the wrong choice for a bridge tool that:

- Must be idempotent (dedup by content hash, not by "did we curl this yet").
- Must preserve provenance (`platform_source`, `agent_type`) rather than whatever
  the HTTP endpoint defaults unknown agents to.
- Must be invocable from cron, from agent hooks, from a shell script, without a
  running HTTP server on the machine in every environment.

The CLI version does all three. The curl one-liner does none of them. Pick by
the job, not by preference.

## vs writing directly to SQLite

You absolutely can open `~/.claude-mem/claude-mem.db` yourself and insert rows.
The CLI is not a gate. It exists so that:

- The dedup contract (which rows collide, which keys collide) is published once
  and followed by anyone who calls the CLI, rather than re-derived by each writer.
- The frontmatter parser for multibrain checkpoints is written once, tested once,
  and reused rather than re-implemented per agent.
- The exit contract (0 insert / 0 already-present / 1 bad input / 2 db error) is
  stable, so a wrapper can rely on it without parsing unstructured text.

Writing directly is fine if you're the only writer and you've read the schema.
Use the CLI if you want the dedup/parse/contract already done.
