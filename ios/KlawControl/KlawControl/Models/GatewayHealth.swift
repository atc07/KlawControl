import Foundation

struct GatewayHealth: Codable {
    let status: String
    var raw: String?
    var uptime: Double?
    var version: String?
    var checkedAt: String?

    var isOk: Bool { status == "ok" }

    var uptimeFormatted: String {
        guard let uptime else { return "-" }
        let days = Int(uptime) / 86_400
        let hours = (Int(uptime) % 86_400) / 3_600
        let minutes = (Int(uptime) % 3_600) / 60
        if days > 0 { return "\(days)d \(hours)h \(minutes)m" }
        if hours > 0 { return "\(hours)h \(minutes)m" }
        return "\(minutes)m"
    }
}

// MARK: - Mock Data

extension GatewayHealth {
    static let mock = GatewayHealth(
        status: "ok",
        raw: nil,
        uptime: 307_320,
        version: "1.0.0",
        checkedAt: nil
    )
}
