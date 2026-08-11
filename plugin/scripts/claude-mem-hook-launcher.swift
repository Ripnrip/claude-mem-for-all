#!/usr/bin/env swift
// claude-mem-hook-launcher.swift — Swift plugin root resolver + worker launcher
//
// Replaces both the inline shell prelude (~1230 chars of escaped JSON) AND
// resolve-plugin-root.sh on Darwin. Does PATH recovery, plugin root
// discovery, cygpath-free path normalization, and worker spawn in one
// typed, testable Swift program.
//
// Usage:
//   claude-mem-hook-launcher [--codex-hook] [--plugin-root <path>] -- <worker args>
//
// When --plugin-root is omitted, discovers the root via the same 3-tier
// fallback chain as the shell resolver:
//   1. $CLAUDE_PLUGIN_ROOT or $PLUGIN_ROOT (host-injected env)
//   2. Cache directories (highest version first, .orphaned_at dirs skipped)
//   3. Marketplace install dir

import Foundation

// MARK: - Types

struct PluginCandidate: Comparable {
  let path: String
  let version: SemVer?

  static func < (lhs: PluginCandidate, rhs: PluginCandidate) -> Bool {
    guard let lv = lhs.version, let rv = rhs.version else {
      // Versioned always beats versionless
      if lhs.version == nil && rhs.version != nil { return true }
      if lhs.version != nil && rhs.version == nil { return false }
      return lhs.path < rhs.path
    }
    return lv < rv
  }

  static func == (lhs: PluginCandidate, rhs: PluginCandidate) -> Bool {
    lhs.path == rhs.path
  }
}

struct SemVer: Comparable {
  let major: Int
  let minor: Int
  let patch: Int
  let isPrerelease: Bool

  static func < (lhs: SemVer, rhs: SemVer) -> Bool {
    if lhs.major != rhs.major { return lhs.major < rhs.major }
    if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
    if lhs.patch != rhs.patch { return lhs.patch < rhs.patch }
    // Release > prerelease at same base
    if lhs.isPrerelease != rhs.isPrerelease { return lhs.isPrerelease }
    return false
  }

  static func == (lhs: SemVer, rhs: SemVer) -> Bool {
    lhs.major == rhs.major && lhs.minor == rhs.minor &&
    lhs.patch == rhs.patch && lhs.isPrerelease == rhs.isPrerelease
  }

  static func parse(_ dirName: String) -> SemVer? {
    // Extract version part before first '-' (e.g. "13.14.0" from "13.14.0-beta")
    let basePart: String
    let isPrerelease: Bool
    if let dashIndex = dirName.firstIndex(of: "-") {
      basePart = String(dirName[..<dashIndex])
      isPrerelease = true
    } else {
      basePart = dirName
      isPrerelease = false
    }

    let parts = basePart.split(separator: ".")
    guard parts.count >= 1 else { return nil }

    let major = Int(parts[0]) ?? 0
    let minor = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
    let patch = parts.count > 2 ? Int(parts[2]) ?? 0 : 0

    return SemVer(major: major, minor: minor, patch: patch, isPrerelease: isPrerelease)
  }
}

// MARK: - Configuration

struct LauncherConfig {
  let pluginRoot: String?     // nil = auto-discover
  let codexHook: Bool
  let workerArgs: [String]
}

enum LauncherError: Error, CustomStringConvertible {
  case usage(String)
  case missingScript(String)
  case notFound
  case childLaunch(String)

  var description: String {
    switch self {
    case .usage(let message):
      return message
    case .missingScript(let path):
      return "claude-mem: required script missing at \(path)"
    case .notFound:
      return "claude-mem: plugin scripts not found"
    case .childLaunch(let message):
      return "claude-mem: \(message)"
    }
  }
}

// MARK: - Argument parsing

func parseArguments(_ args: [String]) throws -> LauncherConfig {
  var pluginRoot: String?
  var codexHook = false
  var workerArgs: [String] = []
  var index = 0

  while index < args.count {
    let arg = args[index]
    switch arg {
    case "--plugin-root":
      index += 1
      guard index < args.count else {
        throw LauncherError.usage("usage: claude-mem-hook-launcher [--plugin-root <path>] [--codex-hook] -- <worker args>")
      }
      pluginRoot = args[index]
    case "--codex-hook":
      codexHook = true
    case "--":
      workerArgs = Array(args[(index + 1)...])
      index = args.count
      continue
    default:
      throw LauncherError.usage("unknown argument: \(arg)")
    }
    index += 1
  }

  guard !workerArgs.isEmpty else {
    throw LauncherError.usage("usage: claude-mem-hook-launcher [--plugin-root <path>] [--codex-hook] -- <worker args>")
  }

  return LauncherConfig(pluginRoot: pluginRoot, codexHook: codexHook, workerArgs: workerArgs)
}

// MARK: - PATH recovery

func loginShellPath(shell: String) -> String {
  let task = Process()
  task.executableURL = URL(fileURLWithPath: shell)
  task.arguments = ["-lc", "printf %s \"$PATH\""]

  let pipe = Pipe()
  let errPipe = Pipe()
  task.standardOutput = pipe
  task.standardError = errPipe

  do {
    try task.run()
    task.waitUntilExit()
  } catch {
    return ""
  }

  guard task.terminationStatus == 0 else {
    return ""
  }

  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  return String(data: data, encoding: .utf8) ?? ""
}

func recoverPath() -> String {
  let env = ProcessInfo.processInfo.environment
  let currentPath = env["PATH"] ?? ""

  // Recover login shell PATH if current PATH is minimal
  if let shell = env["SHELL"], !shell.isEmpty {
    let recovered = loginShellPath(shell: shell)
    if !recovered.isEmpty {
      // Merge: recovered paths first, then current, deduped
      var seen = Set<String>()
      var ordered: [String] = []
      for p in (recovered + ":" + currentPath).split(separator: ":") {
        let val = String(p)
        guard !val.isEmpty else { continue }
        if seen.insert(val).inserted {
          ordered.append(val)
        }
      }
      return ordered.joined(separator: ":")
    }
  }

  return currentPath
}

// MARK: - Plugin root discovery

func configDir() -> String {
  let env = ProcessInfo.processInfo.environment
  if let cfg = env["CLAUDE_CONFIG_DIR"], !cfg.isEmpty {
    return cfg
  }
  return NSHomeDirectory() + "/.claude"
}

func pluginScriptsDir(_ root: String) -> String {
  // If root contains plugin/scripts, use as-is; otherwise append
  let scriptsCandidate = root + "/plugin/scripts"
  let fm = FileManager.default
  if fm.fileExists(atPath: scriptsCandidate + "/bun-runner.js") {
    return root + "/plugin"
  }
  return root
}

func hasRequiredScripts(_ root: String) -> Bool {
  let fm = FileManager.default
  let scripts = root + "/scripts"
  return fm.fileExists(atPath: scripts + "/bun-runner.js") &&
         fm.fileExists(atPath: scripts + "/worker-service.cjs")
}

func discoverCacheCandidates(cacheRoot: String) -> [PluginCandidate] {
  let fm = FileManager.default
  let cachePath = cacheRoot + "/plugins/cache/thedotmack/claude-mem"

  guard let entries = try? fm.contentsOfDirectory(atPath: cachePath) else {
    return []
  }

  return entries
    .filter { $0.first?.isNumber == true }  // version dirs start with digit
    .compactMap { name -> PluginCandidate? in
      let fullPath = cachePath + "/" + name
      var isDir: ObjCBool = false
      guard fm.fileExists(atPath: fullPath, isDirectory: &isDir), isDir.boolValue else { return nil }

      // Skip orphaned dirs
      let orphanMarker = fullPath + "/.orphaned_at"
      if fm.fileExists(atPath: orphanMarker) { return nil }

      let version = SemVer.parse(name)
      return PluginCandidate(path: fullPath, version: version)
    }
    .sorted(by: >)  // highest version first
}

func discoverPluginRoot() -> String? {
  let env = ProcessInfo.processInfo.environment
  let cfgDir = configDir()

  // Build candidate list in priority order
  var candidates: [PluginCandidate] = []

  // 1. Environment-injected roots
  for key in ["CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT"] {
    if let val = env[key], !val.isEmpty {
      candidates.append(PluginCandidate(path: val, version: nil))
    }
  }

  // 2. Cache directories (version-sorted)
  candidates.append(contentsOf: discoverCacheCandidates(cacheRoot: cfgDir))

  // 3. Marketplace install dir
  let marketplacePath = cfgDir + "/plugins/marketplaces/thedotmack/plugin"
  candidates.append(PluginCandidate(path: marketplacePath, version: nil))

  // Find first candidate with required scripts
  for candidate in candidates {
    let resolved = pluginScriptsDir(candidate.path)
    if hasRequiredScripts(resolved) {
      return resolved
    }
  }

  return nil
}

// MARK: - Worker launch

func runLauncher(config: LauncherConfig) throws -> Int32 {
  // Resolve plugin root
  let pluginRoot: String
  if let explicit = config.pluginRoot {
    pluginRoot = explicit
  } else {
    guard let discovered = discoverPluginRoot() else {
      throw LauncherError.notFound
    }
    pluginRoot = discovered
  }

  let scriptsDir = pluginRoot + "/scripts"
  let bunRunner = scriptsDir + "/bun-runner.js"
  let workerService = scriptsDir + "/worker-service.cjs"

  // Validate scripts exist
  let fm = FileManager.default
  guard fm.fileExists(atPath: bunRunner) else {
    throw LauncherError.missingScript(bunRunner)
  }
  guard fm.fileExists(atPath: workerService) else {
    throw LauncherError.missingScript(workerService)
  }

  // Prepare environment
  var environment = ProcessInfo.processInfo.environment
  environment["PATH"] = recoverPath()
  environment["CLAUDE_MEM_PLUGIN_ROOT"] = pluginRoot

  if config.codexHook {
    environment["CLAUDE_MEM_CODEX_HOOK"] = "1"
  }

  // Launch worker
  let task = Process()
  task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  task.arguments = ["node", bunRunner, workerService] + config.workerArgs
  task.environment = environment
  task.standardInput = FileHandle.standardInput
  task.standardOutput = FileHandle.standardOutput
  task.standardError = FileHandle.standardError

  try task.run()
  task.waitUntilExit()
  return task.terminationStatus
}

// MARK: - Entry point

do {
  let config = try parseArguments(Array(CommandLine.arguments.dropFirst()))
  let status = try runLauncher(config: config)
  exit(status)
} catch let error as LauncherError {
  FileHandle.standardError.write(Data((error.description + "\n").utf8))
  exit(1)
} catch {
  FileHandle.standardError.write(Data((String(describing: error) + "\n").utf8))
  exit(1)
}
