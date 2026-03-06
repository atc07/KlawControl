import Foundation
import Security
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    private enum StorageKey {
        static let serverURL = "serverURL"
        static let hasOnboarded = "hasOnboarded"
    }

    private let tokenStore = KeychainTokenStore(
        service: Bundle.main.bundleIdentifier ?? "com.openclaw.KlawControl",
        account: "authToken"
    )

    @Published var serverURL: String {
        didSet {
            let trimmed = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
            if serverURL != trimmed {
                serverURL = trimmed
                return
            }
            UserDefaults.standard.set(trimmed, forKey: StorageKey.serverURL)
        }
    }

    @Published var authToken: String {
        didSet {
            let trimmed = authToken.trimmingCharacters(in: .whitespacesAndNewlines)
            if authToken != trimmed {
                authToken = trimmed
                return
            }
            if trimmed.isEmpty {
                tokenStore.delete()
            } else {
                tokenStore.save(trimmed)
            }
        }
    }

    @Published var hasOnboarded: Bool {
        didSet {
            UserDefaults.standard.set(hasOnboarded, forKey: StorageKey.hasOnboarded)
        }
    }

    // Live data (pre-seeded with mock data)
    @Published var agents: [AgentSession] = AgentSession.mockData
    @Published var channels: [ChannelStatus] = ChannelStatus.mockData
    @Published var terminals: [TerminalSession] = TerminalSession.mockData
    @Published var gatewayHealth: GatewayHealth? = GatewayHealth.mock

    // Stats
    @Published var messagesToday: Int = 147
    @Published var totalTokens: Int = 2_100_000

    @Published var isConnected = false
    @Published var lastError: String?

    private var refreshTimer: Timer?

    init() {
        self.serverURL = UserDefaults.standard.string(forKey: StorageKey.serverURL) ?? ""
        self.authToken = tokenStore.read() ?? ""
        self.hasOnboarded = UserDefaults.standard.bool(forKey: StorageKey.hasOnboarded)
    }

    var normalizedServerURL: String {
        let trimmed = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        return trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") ? trimmed : "http://\(trimmed)"
    }

    var api: APIClient {
        APIClient(baseURL: normalizedServerURL, token: authToken)
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

    func refreshAll() async {
        guard !normalizedServerURL.isEmpty else { return }
        let client = api

        async let statusResult = client.getStatus()
        async let channelsResult = client.getChannels()
        async let terminalsResult = client.getTerminals()
        async let agentsResult = client.getAgents()

        if let health = try? await statusResult {
            gatewayHealth = health
            isConnected = true
            lastError = nil
        } else {
            isConnected = false
        }

        if let channelData = try? await channelsResult {
            channels = channelData
        }

        if let terminalData = try? await terminalsResult {
            terminals = terminalData
        }

        if let agentData = try? await agentsResult {
            agents = agentData
        }
    }
}

private struct KeychainTokenStore {
    let service: String
    let account: String

    func read() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else {
            return nil
        }
        return value
    }

    func save(_ value: String) {
        guard let data = value.data(using: .utf8) else { return }
        SecItemDelete(baseQuery as CFDictionary)

        var query = baseQuery
        query[kSecValueData as String] = data
        SecItemAdd(query as CFDictionary, nil)
    }

    func delete() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}
