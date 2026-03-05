import SwiftUI

struct TerminalView: View {
    @Environment(AppState.self) private var state
    @State private var wsManager = WebSocketManager()
    @State private var inputText = ""
    @FocusState private var inputFocused: Bool
    let sid: String

    var body: some View {
        VStack(spacing: 0) {
            // Terminal output
            ScrollViewReader { proxy in
                ScrollView {
                    Text(wsManager.output)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.green)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .textSelection(.enabled)
                        .id("terminal-bottom")
                }
                .background(.black)
                .onChange(of: wsManager.output) {
                    withAnimation {
                        proxy.scrollTo("terminal-bottom", anchor: .bottom)
                    }
                }
            }

            // Input bar
            HStack(spacing: 8) {
                // Quick keys
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        quickKey("Tab", "\t")
                        quickKey("Esc", "\u{1b}")
                        quickKey("↑", "\u{1b}[A")
                        quickKey("↓", "\u{1b}[B")
                        quickKey("^C", "\u{03}")
                        quickKey("^D", "\u{04}")
                        quickKey("^Z", "\u{1a}")
                        quickKey("^L", "\u{0c}")
                    }
                    .padding(.horizontal, 4)
                }
                .frame(height: 32)
            }
            .background(.ultraThinMaterial)

            HStack {
                TextField("$", text: $inputText)
                    .font(.system(.body, design: .monospaced))
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($inputFocused)
                    .onSubmit {
                        sendInput()
                    }

                Button {
                    sendInput()
                } label: {
                    Image(systemName: "return")
                        .font(.title3)
                }
                .buttonStyle(.borderedProminent)
                .tint(.cyan)
            }
            .padding(8)
            .background(.ultraThinMaterial)
        }
        .navigationTitle("Terminal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Circle()
                    .fill(wsManager.isConnected ? .green : .red)
                    .frame(width: 10, height: 10)
            }
        }
        .onAppear {
            wsManager.connect(baseURL: state.serverURL, token: state.authToken, sid: sid)
            inputFocused = true
        }
        .onDisappear {
            wsManager.disconnect()
        }
    }

    private func sendInput() {
        guard !inputText.isEmpty else {
            wsManager.send("\r")
            return
        }
        wsManager.send(inputText + "\r")
        inputText = ""
    }

    private func quickKey(_ label: String, _ value: String) -> some View {
        Button(label) {
            wsManager.send(value)
        }
        .font(.system(.caption, design: .monospaced))
        .buttonStyle(.bordered)
        .tint(.secondary)
    }
}
