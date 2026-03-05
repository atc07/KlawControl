import Foundation
import SwiftUI

@Observable
final class AppState {
    var serverURL: String {
        get { UserDefaults.standard.string(forKey: "serverURL") ?? "http://192.168.1.100:7749" }
        set { UserDefaults.standard.set(newValue, forKey: "serverURL") }
    }

    var authToken: String {
        get { UserDefaults.standard.string(forKey: "authToken") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "authToken") }
    }

    var agents: [AgentSession] = []
    var channels: [ChannelStatus] = []
    var terminals: [TerminalSession] = []
    var gatewayHealth: GatewayHealth?
    var isConnected = false
    var lastError: String?

    private var refreshTimer: Timer?

    var api: APIClient {
        APIClient(baseURL: serverURL, token: authToken)
    }

    func startAutoRefresh() {
        stopAutoRefresh()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { await self.refreshAll() }
        }
        Task { await refreshAll() }
    }

    func stopAutoRefresh() {
        refreshTimer?.invalidate()
        refreshTimer = nil
    }

    @MainActor
    func refreshAll() async {
        let client = api

        async let statusResult = client.getStatus()
        async let channelsResult = client.getChannels()
        async let terminalsResult = client.getTerminals()
        async let agentsResult = client.getAgents()

        if let health = try? await statusResult {
            gatewayHealth = health
            isConnected = true
            lastError = nil
        }

        if let ch = try? await channelsResult {
            channels = ch
        }

        if let terms = try? await terminalsResult {
            terminals = terms
        }

        if let ags = try? await agentsResult {
            agents = ags
        }
    }
}
