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

    var isMain: Bool { kind == "main" }
    var isActive: Bool { status == "active" }

    var kindIcon: String {
        switch kind {
        case "main": return "brain"
        case "sub-agent": return "gear"
        case "cron": return "clock.arrow.circlepath"
        default: return "cpu"
        }
    }

    var statusBadgeText: String {
        switch status {
        case "active": return isMain ? "ACTIVE" : "RUNNING"
        case "completed": return "DONE"
        case "failed": return "FAILED"
        default: return status.uppercased()
        }
    }

    var uptimeString: String? {
        guard let start = startedAt else { return nil }
        let interval = Date().timeIntervalSince(start)
        let hours = Int(interval) / 3600
        let minutes = (Int(interval) % 3600) / 60
        if hours > 0 {
            return "Uptime: \(hours)h \(minutes)m"
        }
        return "Uptime: \(minutes)m"
    }
}

struct AgentsResponse: Codable {
    let sessions: [AgentSession]?
    let raw: String?
}

// MARK: - Mock Data

extension AgentSession {
    static let mockData: [AgentSession] = [
        AgentSession(
            id: "main-1",
            label: "main-agent",
            kind: "main",
            status: "active",
            task: "Coordinating active automation runs",
            model: "claude-opus-4-6",
            startedAt: Date().addingTimeInterval(-15_780),
            lastActivity: Date()
        ),
        AgentSession(
            id: "sub-1",
            label: "planner",
            kind: "sub-agent",
            status: "active",
            task: "Planning next execution step",
            model: nil,
            startedAt: Date().addingTimeInterval(-3_600),
            lastActivity: Date()
        ),
        AgentSession(
            id: "sub-2",
            label: "inspector",
            kind: "sub-agent",
            status: "active",
            task: "Analyzing command output",
            model: nil,
            startedAt: Date().addingTimeInterval(-1_800),
            lastActivity: Date()
        ),
        AgentSession(
            id: "sub-3",
            label: "validator",
            kind: "sub-agent",
            status: "completed",
            task: "Finished verification pass",
            model: nil,
            startedAt: Date().addingTimeInterval(-7_200),
            lastActivity: Date().addingTimeInterval(-600)
        )
    ]
}
