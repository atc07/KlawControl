import Foundation

struct ChannelStatus: Codable, Identifiable {
    let id: String
    let connected: Bool
    var lastMessageIn: String?
    var lastMessageOut: String?
    var activeChannels: Int?
    var totalChannels: Int?
    var messagesToday: Int?
    var raw: String?

    enum HealthState {
        case connected
        case warning
        case disconnected
    }

    var displayName: String { id.capitalized }

    var healthState: HealthState {
        if connected { return .connected }
        if lastMessageIn == nil && lastMessageOut == nil { return .disconnected }
        return .warning
    }

    var connectionLabel: String {
        switch healthState {
        case .connected: return "Connected"
        case .warning: return "Warning"
        case .disconnected: return "Disconnected"
        }
    }
}

struct ChannelsResponse: Codable {
    let channels: [ChannelStatus]
}

// MARK: - Mock Data

extension ChannelStatus {
    static let mockData: [ChannelStatus] = [
        ChannelStatus(
            id: "discord",
            connected: true,
            lastMessageIn: "32s ago",
            lastMessageOut: "1m ago",
            activeChannels: 8,
            totalChannels: 12,
            messagesToday: 89,
            raw: nil
        ),
        ChannelStatus(
            id: "telegram",
            connected: false,
            lastMessageIn: "8m ago",
            lastMessageOut: "8m ago",
            activeChannels: 3,
            totalChannels: 5,
            messagesToday: 12,
            raw: nil
        )
    ]
}
