import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var state: AppState

    @State private var serverURL = ""
    @State private var authToken = ""
    @State private var connectionResult: ConnectionResult?
    @State private var isTesting = false

    @AppStorage("pref_notifications_errors") private var notifyErrors = true
    @AppStorage("pref_notifications_agent_done") private var notifyAgentDone = true

    enum ConnectionResult {
        case success
        case failure(String)

        var icon: String {
            switch self {
            case .success: return "checkmark.circle"
            case .failure: return "xmark.circle"
            }
        }

        var color: Color {
            switch self {
            case .success: return Color.kcGreen
            case .failure: return Color.kcRed
            }
        }

        var text: String {
            switch self {
            case .success: return "Connected"
            case .failure(let message): return message
            }
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    connectionSection
                    voiceSection
                    notificationsSection
                    aboutSection
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 16)
            }
            .background(Color.kcBackground)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.large)
            .onAppear {
                serverURL = state.serverURL
                authToken = state.authToken
            }
        }
    }

    private var connectionSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("CONNECTION")

            VStack(spacing: 0) {
                labeledField(title: "Server URL") {
                    TextField("192.168.1.x:7749", text: $serverURL)
                        .multilineTextAlignment(.trailing)
                        .foregroundColor(Color.kcSecondaryLabel)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }

                divider

                labeledField(title: "Auth Token") {
                    SecureField("kc_...", text: $authToken)
                        .multilineTextAlignment(.trailing)
                        .foregroundColor(Color.kcSecondaryLabel)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            }
            .cardStyle()

            HStack(spacing: 10) {
                Button {
                    saveConnection()
                } label: {
                    Label("Save", systemImage: "checkmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(Color.kcBlue)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }

                Button {
                    testConnection()
                } label: {
                    HStack(spacing: 6) {
                        if isTesting {
                            ProgressView()
                                .tint(Color.kcBlue)
                                .scaleEffect(0.85)
                        } else {
                            Image(systemName: "network")
                        }
                        Text("Test")
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .foregroundColor(Color.kcBlue)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(Color.kcBlue.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .disabled(isTesting)
            }

            if let result = connectionResult {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: result.icon)
                        .padding(.top, 1)
                    Text(result.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(result.color)
                .padding(.top, 2)
            }
        }
    }

    private var voiceSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("VOICE")

            HStack(spacing: 12) {
                ZStack {
                    Circle()
                        .fill(Color.kcBlue.opacity(0.15))
                        .frame(width: 36, height: 36)
                    Image(systemName: "mic")
                        .foregroundColor(Color.kcBlue)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text("Voice controls")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(Color.kcLabel)
                    Text("Phase 4 placeholder")
                        .font(.system(size: 13))
                        .foregroundColor(Color.kcSecondaryLabel)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(Color(hex: "C7C7CC"))
            }
            .padding(16)
            .cardStyle()
        }
    }

    private var notificationsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("NOTIFICATIONS")

            VStack(spacing: 0) {
                Toggle(isOn: $notifyErrors) {
                    Text("Connection errors")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(Color.kcLabel)
                }
                .tint(Color.kcBlue)
                .padding(16)

                divider

                Toggle(isOn: $notifyAgentDone) {
                    Text("Agent run completed")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(Color.kcLabel)
                }
                .tint(Color.kcBlue)
                .padding(16)
            }
            .cardStyle()
        }
    }

    private var aboutSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("ABOUT")

            VStack(spacing: 0) {
                valueRow(title: "App", value: "Klaw Control")
                divider
                valueRow(title: "Version", value: appVersion)
            }
            .cardStyle()
        }
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(Color.kcSecondaryLabel)
            .padding(.leading, 4)
    }

    private var divider: some View {
        Rectangle()
            .fill(Color(hex: "E5E5EA"))
            .frame(height: 0.5)
            .padding(.leading, 16)
    }

    private func labeledField<Content: View>(title: String, @ViewBuilder field: () -> Content) -> some View {
        HStack {
            Text(title)
                .foregroundColor(Color.kcLabel)
            Spacer()
            field()
        }
        .padding(16)
    }

    private func valueRow(title: String, value: String) -> some View {
        HStack {
            Text(title)
                .foregroundColor(Color.kcLabel)
            Spacer()
            Text(value)
                .foregroundColor(Color.kcSecondaryLabel)
        }
        .font(.system(size: 15))
        .padding(16)
    }

    private var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        return "\(version) (\(build))"
    }

    private func normalizeServerURL(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") {
            return trimmed
        }
        return "http://\(trimmed)"
    }

    private func saveConnection() {
        state.serverURL = normalizeServerURL(serverURL)
        state.authToken = authToken
        Task { await state.refreshAll() }
    }

    private func testConnection() {
        let normalizedURL = normalizeServerURL(serverURL)
        guard !normalizedURL.isEmpty else {
            connectionResult = .failure("Enter a server URL")
            return
        }

        isTesting = true
        connectionResult = nil

        let client = APIClient(baseURL: normalizedURL, token: authToken)
        Task {
            do {
                let ok = try await client.testConnection()
                if ok {
                    state.serverURL = normalizedURL
                    state.authToken = authToken
                    await state.refreshAll()
                    connectionResult = .success
                } else {
                    connectionResult = .failure("Server responded but status was not ok")
                }
            } catch {
                connectionResult = .failure("Failed: \(error.localizedDescription)")
            }
            isTesting = false
        }
    }
}
