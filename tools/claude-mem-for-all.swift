#!/usr/bin/env swift
// claude-mem-for-all — deposit ANY agent session's learning into claude-mem.
// Swift rewrite of ~/.multibrain/bin/claude-mem-for-all.py (kept as reference).
//
// claude-mem's observer only watches Codex/Claude Code session JSONLs. This bridge
// takes a learning from any runtime (pi, hermes, a manual note, …) and writes it
// directly into the claude-mem SQLite store as one sdk_sessions row + one
// observations row, tagged with platform_source so provenance stays honest.
//
// Idempotent via deterministic UUIDv5 content hashes — byte-identical to the
// Python bridge's uuid.uuid5 keys, so rows inserted by either version dedup.
//
// Usage:
//   claude-mem-for-all --file ~/Developer/multibrain/07-Sessions/<checkpoint>.md
//   claude-mem-for-all --project emerge --title "..." --narrative "..." \
//       --facts "a,b" --concepts "x,y" --files "p1,p2" [--platform pi] [--agent pi]
//
// Exit: 0 inserted-or-already-present · 1 bad input · 2 db error

import Foundation
import CryptoKit
import SQLite3

// SQLITE_TRANSIENT isn't exported by Swift's SQLite3 module — recreate it
let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

let dbPath = ProcessInfo.processInfo.environment["CLAUDE_MEM_DATA_DIR"].map { "\($0)/claude-mem.db" }
    ?? NSHomeDirectory() + "/.claude-mem/claude-mem.db"

// MARK: - uuid5 (RFC 4122, byte-compatible with Python uuid.uuid5 / NAMESPACE_URL)

func uuid5String(_ name: String) -> String {
    var digest = Insecure.SHA1()
    // NAMESPACE_URL = 6ba7b811-9dad-11d1-80b4-00c04fd430c8
    digest.update(data: Data([0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1,
                              0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]))
    digest.update(data: Data(name.utf8))
    var b = Array(digest.finalize().prefix(16))
    b[6] = (b[6] & 0x0F) | 0x50   // version 5
    b[8] = (b[8] & 0x3F) | 0x80   // RFC 4122 variant
    let hex = b.map { String(format: "%02x", $0) }.joined()
    let h = hex.startIndex
    func s(_ from: Int, _ to: Int) -> String { String(hex[hex.index(h, offsetBy: from)..<hex.index(h, offsetBy: to)]) }
    return "\(s(0, 8))-\(s(8, 12))-\(s(12, 16))-\(s(16, 20))-\(s(20, 32))"
}

// MARK: - Checkpoint parsing (multibrain 07-Sessions frontmatter)

struct Checkpoint {
    var project = "misc"
    var title = ""
    var type = "feature"
    var concepts: [String] = []
    var narrative = ""
    var files: [String] = []
}

func regexRange(_ pattern: String, in text: String, dotAll: Bool = true) -> Range<String.Index>? {
    let opts: NSRegularExpression.Options = dotAll ? [.dotMatchesLineSeparators] : []
    guard let re = try? NSRegularExpression(pattern: pattern, options: opts) else { return nil }
    let ns = text as NSString
    guard let m = re.firstMatch(in: text, options: [], range: NSRange(location: 0, length: ns.length)) else { return nil }
    return Range(m.range, in: text)
}

func parseCheckpoint(path: String) -> Checkpoint? {
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
    var cp = Checkpoint()
    var body = text
    if let r = regexRange("^---\\n(.*?)\\n---\\n?", in: text) {
        for line in text[r].split(separator: "\n") where line.contains(":") {
            let kv = line.split(separator: ":", maxSplits: 1)
            guard kv.count == 2 else { continue }
            let k = kv[0].trimmingCharacters(in: .whitespaces)
            let v = kv[1].trimmingCharacters(in: .whitespaces)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\"[]"))
            switch k {
            case "project": cp.project = v.isEmpty ? "misc" : v
            case "type": cp.type = v.isEmpty ? "feature" : v
            case "tags": cp.concepts = v.split(whereSeparator: { ", ".contains($0) }).map(String.init).filter { !$0.isEmpty }
            default: break
            }
        }
        body = String(text[r.upperBound...])
    }
    let stem = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
    cp.title = stem.replacingOccurrences(of: "--", with: " — ")
    if let fr = regexRange("## Files touched\\s*\\n(.*?)(\\n#|\\Z)", in: body) {
        for line in body[fr].split(separator: "\n") where line.hasPrefix("- ") {
            let entry = line.dropFirst(2).trimmingCharacters(in: .whitespaces)
            let file = entry.split(separator: " ").first.map(String.init) ?? entry
            cp.files.append(file.trimmingCharacters(in: CharacterSet(charactersIn: "`")))
        }
        body = String(body[..<fr.lowerBound])
    }
    cp.narrative = String(body.trimmingCharacters(in: .whitespacesAndNewlines).prefix(4000))
    if cp.concepts.isEmpty { cp.concepts = [cp.project] }
    return cp
}

// MARK: - Args

var args = Array(CommandLine.arguments.dropFirst())
func value(for flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    let v = args[i + 1]; args.removeSubrange(i...i + 1); return v
}
func flag(_ name: String) -> Bool {
    guard let i = args.firstIndex(of: name) else { return false }
    args.remove(at: i); return true
}

let dryRun = flag("--dry-run")
let help = flag("-h") || flag("--help")
let fileArg = value(for: "--file")
let projectArg = value(for: "--project")
let titleArg = value(for: "--title")
let narrativeArg = value(for: "--narrative")
let subtitleArg = value(for: "--subtitle")
let conceptsArg = value(for: "--concepts")
let filesArg = value(for: "--files")
let typeArg = value(for: "--type") ?? "feature"
let platform = value(for: "--platform") ?? "pi"
let agent = value(for: "--agent") ?? "pi"

if help || (fileArg == nil && (projectArg == nil || titleArg == nil || narrativeArg == nil)) {
    if !help { FileHandle.standardError.write(Data("error: provide --file OR --project/--title/--narrative\n".utf8)) }
    print("""
    claude-mem-for-all — deposit any agent session's learning into claude-mem (Swift)

      --file <checkpoint.md>     multibrain 07-Sessions note (parses frontmatter + body)
      --project/--title/--narrative   inline deposit (--subtitle, --concepts, --files optional)
      --platform <tag>           platform_source (default pi)   --agent <tag> (default pi)
      --type <observation type>  default feature
      --dry-run                  parse + print, insert nothing
    """)
    exit(help ? 0 : 1)
}

// MARK: - Build the record

var cp: Checkpoint
var sessionKey: String
if let f = fileArg {
    guard let parsed = parseCheckpoint(path: f) else {
        FileHandle.standardError.write(Data("error: file not found or unreadable: \(f)\n".utf8)); exit(1)
    }
    cp = parsed
    sessionKey = "\(platform)://\((f as NSString).lastPathComponent)"
} else {
    cp = Checkpoint()
    cp.project = projectArg!; cp.title = titleArg!; cp.type = typeArg
    cp.narrative = narrativeArg!
    cp.concepts = (conceptsArg?.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } ?? []).filter { !$0.isEmpty }
    cp.files = (filesArg?.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } ?? []).filter { !$0.isEmpty }
    if cp.concepts.isEmpty { cp.concepts = [cp.project] }
    sessionKey = "\(platform)://inline/\(cp.project)/\(abs(cp.title.hashValue))"
}

let memSid = uuid5String(sessionKey)
let contentHash = uuid5String(sessionKey + cp.title)
let nowISO = ISO8601DateFormatter().string(from: Date())
let nowEpoch = Int(Date().timeIntervalSince1970)

if dryRun {
    print("[dry-run] project=\(cp.project) platform=\(platform) title=\(String(cp.title.prefix(60)))")
    print("  concepts=\(cp.concepts) files=\(cp.files.count) narrative=\(cp.narrative.count)c")
    exit(0)
}

guard FileManager.default.fileExists(atPath: dbPath) else {
    FileHandle.standardError.write(Data("error: claude-mem DB not found at \(dbPath)\n".utf8)); exit(2)
}

// MARK: - SQLite

var db: OpaquePointer?
guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else {
    FileHandle.standardError.write(Data("error: cannot open db\n".utf8)); exit(2)
}
defer { sqlite3_close(db) }

func exitDbErr() -> Never {
    let msg = sqlite3_errmsg(db).map(String.init(cString:)) ?? "unknown"
    FileHandle.standardError.write(Data("db error: \(msg)\n".utf8)); exit(2)
}

// Idempotency: content_hash OR (project AND title)
var stmt: OpaquePointer?
guard sqlite3_prepare_v2(db, "SELECT id FROM observations WHERE content_hash=?1 OR (project=?2 AND title=?3)", -1, &stmt, nil) == SQLITE_OK else { exitDbErr() }
sqlite3_bind_text(stmt, 1, contentHash, -1, SQLITE_TRANSIENT)
sqlite3_bind_text(stmt, 2, cp.project, -1, SQLITE_TRANSIENT)
sqlite3_bind_text(stmt, 3, cp.title, -1, SQLITE_TRANSIENT)
if sqlite3_step(stmt) == SQLITE_ROW {
    let id = sqlite3_column_int64(stmt, 0)
    sqlite3_finalize(stmt)
    print("ALREADY PRESENT (observations.id=\(id)) — skipping (idempotent)")
    exit(0)
}
sqlite3_finalize(stmt)

let subtitle = subtitleArg ?? cp.title
func jsonArray(_ items: [String]) -> String {
    "[" + items.map { "\"\($0.replacingOccurrences(of: "\"", with: "\\\""))\"" }.joined(separator: ",") + "]"
}
let conceptsJSON = jsonArray(cp.concepts)
let filesJSON = jsonArray(cp.files)

func bindAndStep(_ sql: String, _ bind: (OpaquePointer) -> Void) {
    var st: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK, let st else { exitDbErr() }
    bind(st)
    if sqlite3_step(st) != SQLITE_DONE { exitDbErr() }
    sqlite3_finalize(st)
}

bindAndStep("""
INSERT OR REPLACE INTO sdk_sessions
 (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status, platform_source)
VALUES (?1,?2,?3,?4,?5,?6,'completed',?7)
""") { st in
    sqlite3_bind_text(st, 1, sessionKey, -1, SQLITE_TRANSIENT)
    sqlite3_bind_text(st, 2, memSid, -1, SQLITE_TRANSIENT)
    sqlite3_bind_text(st, 3, cp.project, -1, SQLITE_TRANSIENT)
    sqlite3_bind_text(st, 4, cp.title, -1, SQLITE_TRANSIENT)
    sqlite3_bind_text(st, 5, nowISO, -1, SQLITE_TRANSIENT)
    sqlite3_bind_int64(st, 6, Int64(nowEpoch))
    sqlite3_bind_text(st, 7, platform, -1, SQLITE_TRANSIENT)
}

bindAndStep("""
INSERT INTO observations
 (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts,
  files_modified, created_at, created_at_epoch, content_hash, agent_type)
VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
""") { st in
    sqlite3_bind_text(st, 1, memSid, -1, SQLITE_TRANSIENT)
    sqlite3_bind_text(st, 2, cp.project, -1, SQLITE_TRANSIENT)
    sqlite3_bind_text(st, 3, subtitle, -1, SQLITE_TRANSIENT)
    sqlite3_bind_text(st, 4, cp.type, -1, SQLITE_TRANSIENT)
    sqlite3_bind_text(st, 5, cp.title, -1, SQLITE_TRANSIENT)
    sqlite3_bind_text(st, 6, subtitle, -1, SQLITE_TRANSIENT)
    sqlite3_bind_text(st, 7, "[]", -1, SQLITE_TRANSIENT)
    sqlite3_bind_text(st, 8, cp.narrative, -1, SQLITE_TRANSIENT)
    sqlite3_bind_text(st, 9, conceptsJSON, -1, SQLITE_TRANSIENT)
    sqlite3_bind_text(st, 10, filesJSON, -1, SQLITE_TRANSIENT)
    sqlite3_bind_text(st, 11, nowISO, -1, SQLITE_TRANSIENT)
    sqlite3_bind_int64(st, 12, Int64(nowEpoch))
    sqlite3_bind_text(st, 13, contentHash, -1, SQLITE_TRANSIENT)
    sqlite3_bind_text(st, 14, agent, -1, SQLITE_TRANSIENT)
}

let newId = sqlite3_last_insert_rowid(db)
print("INSERTED observations.id=\(newId) (platform_source=\(platform), project=\(cp.project))")
print("  title: \(cp.title)")
exit(0)
