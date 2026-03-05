import Foundation

struct AgentSession: Codable, Identifiable {
    let id: String
    var label: String?
    let kind: String          // "main" | "sub-agent" | "cron"
    let status: String        // "active" | "completed" | "failed"
    var task: String?
    var model: String?
    let startedAt: Date?
    var lastActivity: Date?

    var isActive: Bool { status == "active" }

    var kindIcon: String {
        switch kind {
        case "main": return "brain.head.profile"
        case "sub-agent": return "person.2"
        case "cron": return "clock"
        default: return "questionmark.circle"
        }
    }

    var statusColor: String {
        switch status {
        case "active": return "green"
        case "completed": return "blue"
        case "failed": return "red"
        default: return "gray"
        }
    }
}

struct AgentsResponse: Codable {
    let sessions: [AgentSession]?
    let raw: String?
}
