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
