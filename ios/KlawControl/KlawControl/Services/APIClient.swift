import Foundation

struct APIClient {
    let baseURL: String
    let token: String

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        let normalizedBaseURL = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        guard let url = URL(string: "\(normalizedBaseURL)\(path)") else {
            throw URLError(.badURL)
        }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 10

        if !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let (data, response) = try await URLSession.shared.data(for: req)

        if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode >= 400 {
            throw URLError(.init(rawValue: httpResponse.statusCode))
        }

        return data
    }

    func getStatus() async throws -> GatewayHealth {
        let data = try await request("/api/status")
        return try JSONDecoder().decode(GatewayHealth.self, from: data)
    }

    func getChannels() async throws -> [ChannelStatus] {
        let data = try await request("/api/channels")
        let response = try JSONDecoder().decode(ChannelsResponse.self, from: data)
        return response.channels
    }

    func getAgents() async throws -> [AgentSession] {
        let data = try await request("/api/agents")
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let response = try decoder.decode(AgentsResponse.self, from: data)
        return response.sessions ?? []
    }

    func getTerminals() async throws -> [TerminalSession] {
        let data = try await request("/api/terminals")
        let response = try JSONDecoder().decode(TerminalsResponse.self, from: data)
        return response.terminals
    }

    func spawnTerminal(name: String? = nil) async throws -> SpawnResponse {
        var body: [String: Any] = [:]
        if let name { body["name"] = name }
        let data = try await request("/api/terminals", method: "POST", body: body.isEmpty ? nil : body)
        return try JSONDecoder().decode(SpawnResponse.self, from: data)
    }

    func renameTerminal(sid: String, name: String) async throws {
        _ = try await request("/api/terminals/\(sid)", method: "PATCH", body: ["name": name])
    }

    func killTerminal(sid: String) async throws {
        _ = try await request("/api/terminals/\(sid)", method: "DELETE")
    }

    func steerAgent(id: String, message: String) async throws {
        _ = try await request("/api/agents/\(id)/steer", method: "POST", body: ["message": message])
    }

    func killAgent(id: String) async throws {
        _ = try await request("/api/agents/\(id)/kill", method: "POST")
    }

    func testConnection() async throws -> Bool {
        let status = try await getStatus()
        return status.isOk
    }
}
