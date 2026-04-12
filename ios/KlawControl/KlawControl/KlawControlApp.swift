import SwiftUI

// MARK: - Color Helper

extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let a, r, g, b: UInt64
        switch hex.count {
        case 3:
            (a, r, g, b) = (255, (int >> 8) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17)
        case 6:
            (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
        case 8:
            (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default:
            (a, r, g, b) = (255, 0, 0, 0)
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue: Double(b) / 255,
            opacity: Double(a) / 255
        )
    }
}

// MARK: - Design System

extension Color {
    static let kcBlue = Color(hex: "007AFF")
    static let kcGreen = Color(hex: "34C759")
    static let kcOrange = Color(hex: "FF9500")
    static let kcRed = Color(hex: "FF3B30")
    static let kcPurple = Color(hex: "5856D6")
    static let kcGray = Color(hex: "8E8E93")
    static let kcBackground = Color(hex: "F2F2F7")
    static let kcLabel = Color(hex: "1C1C1E")
    static let kcSecondaryLabel = Color(hex: "8E8E93")
}

// MARK: - Shared UI Components

struct StatusBadge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .bold))
            .foregroundColor(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(color)
            .clipShape(Capsule())
    }
}

struct CardStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(Color.white)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .shadow(color: .black.opacity(0.04), radius: 8, y: 2)
    }
}

extension View {
    func cardStyle() -> some View {
        modifier(CardStyle())
    }
}

// MARK: - App

@main
struct KlawControlApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                .preferredColorScheme(.light)
                .onOpenURL { url in
                    handleDeepLink(url)
                }
        }
    }

    private func handleDeepLink(_ url: URL) {
        guard url.scheme == "klawcontrol",
              url.host == "pair",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let queryItems = components.queryItems else {
            return
        }

        let urlValue = queryItems.first(where: { $0.name == "url" })?.value ?? ""
        let token = queryItems.first(where: { $0.name == "token" })?.value ?? ""
        let normalizedURL = normalizeServerURL(urlValue)
        guard !normalizedURL.isEmpty else { return }

        appState.serverURL = normalizedURL
        appState.authToken = token
        appState.hasOnboarded = true
    }

    private func normalizeServerURL(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") {
            return trimmed
        }
        return "http://\(trimmed)"
    }
}

// MARK: - Root View

struct RootView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        if state.hasOnboarded {
            MainTabView()
        } else {
            OnboardingView()
        }
    }
}

// MARK: - Onboarding

struct OnboardingView: View {
    @EnvironmentObject private var state: AppState

    @State private var serverURL = ""
    @State private var authToken = ""
    @State private var connectionResult: ConnectionResult?
    @State private var isTesting = false

    enum ConnectionResult {
        case success
        case failure(String)

        var isSuccess: Bool {
            if case .success = self { return true }
            return false
        }

        var message: String {
            switch self {
            case .success: return "Connected"
            case .failure(let value): return value
            }
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    VStack(spacing: 14) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 22)
                                .fill(Color.kcBlue)
                                .frame(width: 88, height: 88)
                            Image(systemName: "terminal")
                                .font(.system(size: 38, weight: .semibold))
                                .foregroundColor(.white)
                        }
                        .shadow(color: Color.kcBlue.opacity(0.3), radius: 12, y: 6)

                        VStack(spacing: 6) {
                            Text("Klaw Control")
                                .font(.system(size: 28, weight: .bold))
                                .foregroundColor(Color.kcLabel)
                            Text("Connect to your OpenClaw server")
                                .font(.system(size: 15))
                                .foregroundColor(Color.kcSecondaryLabel)
                        }
                    }
                    .padding(.top, 36)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("CONNECTION")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(Color.kcSecondaryLabel)
                            .padding(.leading, 16)

                        VStack(spacing: 0) {
                            HStack {
                                Text("Server URL")
                                    .foregroundColor(Color.kcLabel)
                                Spacer()
                                TextField("192.168.1.x:7749", text: $serverURL)
                                    .multilineTextAlignment(.trailing)
                                    .foregroundColor(Color.kcSecondaryLabel)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .keyboardType(.URL)
                            }
                            .padding(16)

                            Divider().padding(.leading, 16)

                            HStack {
                                Text("Auth Token")
                                    .foregroundColor(Color.kcLabel)
                                Spacer()
                                SecureField("kc_...", text: $authToken)
                                    .multilineTextAlignment(.trailing)
                                    .foregroundColor(Color.kcSecondaryLabel)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                            }
                            .padding(16)
                        }
                        .cardStyle()
                    }

                    VStack(spacing: 12) {
                        Button {
                            testConnection()
                        } label: {
                            HStack(spacing: 8) {
                                if isTesting {
                                    ProgressView()
                                        .tint(.white)
                                        .scaleEffect(0.85)
                                } else {
                                    Image(systemName: "network")
                                }
                                Text(isTesting ? "Testing..." : "Test Connection")
                                    .fontWeight(.semibold)
                            }
                            .foregroundColor(.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Color.kcBlue)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .disabled(isTesting || serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                        if let result = connectionResult {
                            HStack(spacing: 6) {
                                Image(systemName: result.isSuccess ? "checkmark.circle" : "xmark.circle")
                                    .foregroundColor(result.isSuccess ? Color.kcGreen : Color.kcRed)
                                Text(result.message)
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundColor(result.isSuccess ? Color.kcGreen : Color.kcRed)
                            }
                        }

                        Button {
                            if !serverURL.isEmpty {
                                state.serverURL = normalizeServerURL(serverURL)
                            }
                            state.authToken = authToken
                            state.hasOnboarded = true
                        } label: {
                            Text(connectionResult?.isSuccess == true ? "Continue" : "Use Demo Data")
                                .font(.system(size: 15, weight: .medium))
                                .foregroundColor(connectionResult?.isSuccess == true ? Color.kcBlue : Color.kcSecondaryLabel)
                        }
                    }

                    VStack(spacing: 12) {
                        HStack {
                            Rectangle()
                                .fill(Color(hex: "E5E5EA"))
                                .frame(height: 1)
                            Text("OR")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundColor(Color.kcSecondaryLabel)
                            Rectangle()
                                .fill(Color(hex: "E5E5EA"))
                                .frame(height: 1)
                        }

                        Button {
                            // Phase 2: QR scanner
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "qrcode.viewfinder")
                                Text("Scan QR Code")
                                    .fontWeight(.semibold)
                            }
                            .foregroundColor(Color.kcBlue)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Color.kcBlue.opacity(0.08))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }

                        Text("Run `openclaw klaw-control pair` on your Mac to pair this device.")
                            .font(.system(size: 12))
                            .foregroundColor(Color.kcSecondaryLabel)
                            .multilineTextAlignment(.center)
                    }

                    Spacer(minLength: 32)
                }
                .padding(.horizontal, 20)
            }
            .background(Color.kcBackground)
            .onAppear {
                serverURL = state.serverURL
                authToken = state.authToken
            }
        }
    }

    private func normalizeServerURL(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") {
            return trimmed
        }
        return "http://\(trimmed)"
    }

    private func testConnection() {
        let normalizedURL = normalizeServerURL(serverURL)
        guard !normalizedURL.isEmpty else { return }

        isTesting = true
        connectionResult = nil

        let client = APIClient(baseURL: normalizedURL, token: authToken)

        Task {
            do {
                let ok = try await client.testConnection()
                if ok {
                    state.serverURL = normalizedURL
                    state.authToken = authToken
                    connectionResult = .success
                } else {
                    connectionResult = .failure("Server responded but status was not ok")
                }
            } catch {
                connectionResult = .failure("Connection failed: \(error.localizedDescription)")
            }
            isTesting = false
        }
    }
}

// MARK: - Main Tab View

struct MainTabView: View {
    @EnvironmentObject private var state: AppState
    @State private var selectedTab = 0
    @State private var showingVoiceSheet = false

    var body: some View {
        ZStack(alignment: .bottom) {
            Group {
                switch selectedTab {
                case 0: DashboardView()
                case 1: ChannelsView()
                case 2: TerminalsListView()
                case 3: SettingsView()
                default: DashboardView()
                }
            }
            .safeAreaInset(edge: .bottom) {
                Color.clear.frame(height: 83)
            }

            CustomTabBar(selectedTab: $selectedTab, showingVoiceSheet: $showingVoiceSheet)
        }
        .ignoresSafeArea(edges: .bottom)
        .onAppear {
            state.startAutoRefresh()
        }
        .onDisappear {
            state.stopAutoRefresh()
        }
        .sheet(isPresented: $showingVoiceSheet) {
            VoicePlaceholderSheet()
                .presentationDetents([.fraction(0.3)])
                .presentationDragIndicator(.visible)
        }
    }
}

// MARK: - Custom Tab Bar

struct CustomTabBar: View {
    @Binding var selectedTab: Int
    @Binding var showingVoiceSheet: Bool

    var body: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(Color(hex: "E5E5EA"))
                .frame(height: 0.5)

            HStack(spacing: 0) {
                TabBarButton(icon: "chart.bar", label: "Dashboard", tag: 0, selectedTab: $selectedTab)
                TabBarButton(icon: "bubble.left.and.bubble.right", label: "Channels", tag: 1, selectedTab: $selectedTab)

                Button {
                    showingVoiceSheet = true
                } label: {
                    ZStack {
                        Circle()
                            .fill(Color.kcBlue)
                            .frame(width: 56, height: 56)
                            .shadow(color: Color.kcBlue.opacity(0.35), radius: 8, y: 4)
                        Image(systemName: "mic.fill")
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundColor(.white)
                    }
                }
                .frame(maxWidth: .infinity)
                .offset(y: -10)

                TabBarButton(icon: "terminal", label: "Terminal", tag: 2, selectedTab: $selectedTab)
                TabBarButton(icon: "gearshape", label: "Settings", tag: 3, selectedTab: $selectedTab)
            }
            .frame(height: 49)
            .background(Color.white)

            Color.white
                .frame(height: 34)
        }
        .background(Color.white)
    }
}

struct VoicePlaceholderSheet: View {
    var body: some View {
        VStack(spacing: 16) {
            Circle()
                .fill(Color.kcBlue.opacity(0.12))
                .frame(width: 68, height: 68)
                .overlay {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 28, weight: .semibold))
                        .foregroundColor(Color.kcBlue)
                }

            VStack(spacing: 6) {
                Text("Voice control is not ready yet")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundColor(Color.kcLabel)
                Text("The mic button now explains the feature instead of acting like a broken control.")
                    .font(.system(size: 14))
                    .foregroundColor(Color.kcSecondaryLabel)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(24)
        .presentationBackground(Color.kcBackground)
    }
}

struct TabBarButton: View {
    let icon: String
    let label: String
    let tag: Int
    @Binding var selectedTab: Int

    private var isSelected: Bool {
        selectedTab == tag
    }

    var body: some View {
        Button {
            selectedTab = tag
        } label: {
            VStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.system(size: 22))
                Text(label)
                    .font(.system(size: 10))
            }
            .foregroundColor(isSelected ? Color.kcBlue : Color.kcGray)
            .frame(maxWidth: .infinity)
        }
    }
}
