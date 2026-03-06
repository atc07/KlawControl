import Foundation

struct TerminalSession: Codable, Identifiable {
    let sid: String
    var name: String
    let pid: Int?
    let startedAt: String?
    let alive: Bool?
    var exitCode: Int?
    var exitedAt: String?

    var id: String { sid }

    var isAlive: Bool { alive ?? true }
}

struct TerminalsResponse: Codable {
    let terminals: [TerminalSession]
}

struct SpawnResponse: Codable {
    let sid: String
    let name: String
    let pid: Int
    let startedAt: String
}

// MARK: - Mock Data

extension TerminalSession {
    static let mockData: [TerminalSession] = [
        TerminalSession(sid: "session-1", name: "session-1", pid: 1234, startedAt: nil, alive: true, exitCode: nil, exitedAt: nil),
        TerminalSession(sid: "session-2", name: "session-2", pid: 5678, startedAt: nil, alive: true, exitCode: nil, exitedAt: nil)
    ]

    static let mockOutput = """
$ klaw status
Gateway: connected
Agents: 4 active sessions
Channels: discord online, telegram warning

$ klaw logs --tail 5
[10:30:04] session planner started
[10:30:12] session inspector completed scan
[10:30:20] terminal session opened
[10:30:26] notification sync complete
[10:30:32] waiting for command

$ 
"""
}
