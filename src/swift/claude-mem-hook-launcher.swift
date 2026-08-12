#!/usr/bin/env swift

import Foundation

struct LauncherConfig {
  let pluginRoot: String
  let codexHook: Bool
  let workerArgs: [String]
}

enum LauncherError: Error, CustomStringConvertible {
  case usage(String)
  case missingScript(String)
  case childLaunch(String)

  var description: String {
    switch self {
    case .usage(let message):
      return message
    case .missingScript(let path):
      return "claude-mem hook launcher: required script missing at \(path)"
    case .childLaunch(let message):
      return "claude-mem hook launcher: \(message)"
    }
  }
}

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
        throw LauncherError.usage("usage: claude-mem-hook-launcher.swift --plugin-root <path> [--codex-hook] -- <worker args>")
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

  guard let pluginRoot = pluginRoot, !pluginRoot.isEmpty else {
    throw LauncherError.usage("usage: claude-mem-hook-launcher.swift --plugin-root <path> [--codex-hook] -- <worker args>")
  }
  guard !workerArgs.isEmpty else {
    throw LauncherError.usage("claude-mem hook launcher: missing worker args after --")
  }

  return LauncherConfig(pluginRoot: pluginRoot, codexHook: codexHook, workerArgs: workerArgs)
}

func loginShellPath(shell: String) throws -> String {
  let task = Process()
  task.executableURL = URL(fileURLWithPath: shell)
  task.arguments = ["-lc", "printf %s \"$PATH\""]

  let output = Pipe()
  let error = Pipe()
  task.standardOutput = output
  task.standardError = error

  try task.run()
  task.waitUntilExit()

  guard task.terminationStatus == 0 else {
    let data = error.fileHandleForReading.readDataToEndOfFile()
    let message = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "PATH recovery failed"
    throw LauncherError.childLaunch(message)
  }

  let data = output.fileHandleForReading.readDataToEndOfFile()
  return String(data: data, encoding: .utf8) ?? ""
}

func mergePath(recovered: String, current: String) -> String {
  var ordered: [String] = []
  var seen = Set<String>()

  for path in (recovered + ":" + current).split(separator: ":") {
    let value = String(path)
    guard !value.isEmpty else { continue }
    if seen.insert(value).inserted {
      ordered.append(value)
    }
  }

  return ordered.joined(separator: ":")
}

func prepareEnvironment(codexHook: Bool) throws -> [String: String] {
  var environment = ProcessInfo.processInfo.environment

  if let shell = environment["SHELL"], !shell.isEmpty {
    let recoveredPath = try loginShellPath(shell: shell)
    let currentPath = environment["PATH"] ?? ""
    environment["PATH"] = mergePath(recovered: recoveredPath, current: currentPath)
  }

  if codexHook {
    environment["CLAUDE_MEM_CODEX_HOOK"] = "1"
  }

  return environment
}

func validateScript(_ path: String) throws {
  guard FileManager.default.fileExists(atPath: path) else {
    throw LauncherError.missingScript(path)
  }
}

func runLauncher(config: LauncherConfig) throws -> Int32 {
  let pluginScripts = URL(fileURLWithPath: config.pluginRoot).appendingPathComponent("scripts")
  let bunRunner = pluginScripts.appendingPathComponent("bun-runner.js").path
  let workerService = pluginScripts.appendingPathComponent("worker-service.cjs").path

  try validateScript(bunRunner)
  try validateScript(workerService)

  let task = Process()
  task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  task.arguments = ["node", bunRunner, workerService] + config.workerArgs
  task.environment = try prepareEnvironment(codexHook: config.codexHook)
  task.standardInput = FileHandle.standardInput
  task.standardOutput = FileHandle.standardOutput
  task.standardError = FileHandle.standardError

  try task.run()
  task.waitUntilExit()
  return task.terminationStatus
}

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
