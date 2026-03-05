import SwiftUI

struct SettingsView: View {
    @Environment(AppState.self) private var state
    @State private var serverURL = ""
    @State private var authToken = ""
    @State private var testResult: String?
    @State private var isTesting = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("Server URL", text: $serverURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)

                    SecureField("Auth Token", text: $authToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Button {
                        state.serverURL = serverURL
                        state.authToken = authToken
                        Task { await state.refreshAll() }
                    } label: {
                        Label("Save", systemImage: "checkmark.circle")
                    }
                }

                Section("Connection Test") {
                    Button {
                        testConnection()
                    } label: {
                        HStack {
                            Label("Test Connection", systemImage: "network")
                            Spacer()
                            if isTesting {
                                ProgressView()
                            }
                        }
                    }
                    .disabled(isTesting)

                    if let result = testResult {
                        Text(result)
                            .font(.caption)
                            .foregroundStyle(result.contains("✅") ? .green : .red)
                    }
                }

                Section("About") {
                    HStack {
                        Text("App")
                        Spacer()
                        Text("Klaw Control v1.0")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Settings")
            .onAppear {
                serverURL = state.serverURL
                authToken = state.authToken
            }
        }
    }

    private func testConnection() {
        isTesting = true
        testResult = nil

        let client = APIClient(baseURL: serverURL, token: authToken)
        Task {
            do {
                let ok = try await client.testConnection()
                testResult = ok ? "✅ Connected successfully" : "⚠️ Server responded but status not ok"
            } catch {
                testResult = "❌ Failed: \(error.localizedDescription)"
            }
            isTesting = false
        }
    }
}
