import Foundation

struct ChannelStatus: Codable, Identifiable {
    let id: String
    let connected: Bool
    var lastMessageIn: String?
    var lastMessageOut: String?
    var raw: String?

    var icon: String {
        switch id.lowercased() {
        case "discord": return "message.badge.waveform"
        case "telegram": return "paperplane"
        case "signal": return "shield"
        default: return "antenna.radiowaves.left.and.right"
        }
    }

    var displayName: String {
        id.capitalized
    }
}

struct ChannelsResponse: Codable {
    let channels: [ChannelStatus]
}
