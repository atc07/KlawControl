import Foundation

struct GatewayHealth: Codable {
    let status: String
    var raw: String?
    var uptime: Double?
    var version: String?
    var checkedAt: String?

    var isOk: Bool { status == "ok" }
}
