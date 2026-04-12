import SwiftUI

struct TerminalsListView: View {
    @EnvironmentObject private var state: AppState
    @StateObject private var webSocket = WebSocketManager()
    @State private var selectedSid: String?
    @State private var commandText = ""
    @State private var terminalError: String?
    @State private var isCreatingTerminal = false
    @State private var isRenamingTerminal = false
    @State private var renameValue = ""
    @State private var pendingTerminalToClose: TerminalSession?

    var selectedSession: TerminalSession? {
        guard let sid = selectedSid else { return state.terminals.first }
        return state.terminals.first(where: { $0.sid == sid }) ?? state.terminals.first
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                sessionTabs

                VStack(spacing: 12) {
                    statusBanner
                    terminalView
                    commandInput
                }
                .padding(16)

                Spacer()
            }
            .background(Color.kcBackground)
            .navigationTitle("Terminal")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            Task { await createTerminal() }
                        } label: {
                            Label("New Session", systemImage: "plus")
                        }

                        if let selectedSession {
                            Button {
                                renameValue = selectedSession.name
                                isRenamingTerminal = true
                            } label: {
                                Label("Rename Session", systemImage: "pencil")
                            }

                            Button(role: .destructive) {
                                pendingTerminalToClose = selectedSession
                            } label: {
                                Label("Close Session", systemImage: "trash")
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .alert("Rename Session", isPresented: $isRenamingTerminal) {
                TextField("Session name", text: $renameValue)
                Button("Cancel", role: .cancel) {}
                Button("Save") {
                    Task { await renameSelectedTerminal() }
                }
            } message: {
                Text("Use a clear label so it is easy to switch between sessions.")
            }
            .confirmationDialog("Close this terminal session?", isPresented: Binding(
                get: { pendingTerminalToClose != nil },
                set: { if !$0 { pendingTerminalToClose = nil } }
            )) {
                Button("Close Session", role: .destructive) {
                    Task { await closeSelectedTerminal() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The backing PTY will be terminated.")
            }
            .task {
                await synchronizeSelectionAndConnection()
            }
            .onChange(of: state.terminals.map(\.sid)) {
                Task { await synchronizeSelectionAndConnection() }
            }
            .onChange(of: state.normalizedServerURL) {
                Task { await synchronizeSelectionAndConnection(forceReconnect: true) }
            }
            .onChange(of: selectedSid) {
                Task { await synchronizeSelectionAndConnection(forceReconnect: true) }
            }
        }
    }

    private var sessionTabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(state.terminals) { session in
                    TerminalPillTab(
                        name: session.name,
                        isSelected: session.sid == (selectedSid ?? state.terminals.first?.sid)
                    ) {
                        selectedSid = session.sid
                    }
                }

                Button {
                    Task { await createTerminal() }
                } label: {
                    HStack(spacing: 6) {
                        if isCreatingTerminal {
                            ProgressView()
                                .scaleEffect(0.8)
                        } else {
                            Image(systemName: "plus")
                        }
                        Text("New")
                    }
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(Color.kcLabel)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .background(Color.white)
                    .clipShape(Capsule())
                    .overlay(
                        Capsule()
                            .stroke(Color(hex: "E5E5EA"), lineWidth: 1)
                    )
                }
                .disabled(isCreatingTerminal || state.normalizedServerURL.isEmpty)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .background(Color.kcBackground)
    }

    private var terminalView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Group {
                    if let emptyStateMessage {
                        Text(emptyStateMessage)
                            .foregroundColor(Color.white.opacity(0.7))
                    } else {
                        Text(webSocket.output.isEmpty ? "Waiting for terminal output..." : webSocket.output)
                            .foregroundColor(.white)
                    }
                }
                .font(.system(size: 13, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)

                Color.clear
                    .frame(height: 1)
                    .id("terminal-bottom")
            }
            .onChange(of: webSocket.output) {
                withAnimation(.easeOut(duration: 0.12)) {
                    proxy.scrollTo("terminal-bottom", anchor: .bottom)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 340)
        .background(Color(hex: "1C1C1E"))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private var commandInput: some View {
        HStack(spacing: 10) {
            HStack(spacing: 6) {
                Text(">")
                    .font(.system(size: 15, design: .monospaced))
                    .foregroundColor(Color.kcSecondaryLabel)
                TextField("Enter command...", text: $commandText)
                    .font(.system(size: 15, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.send)
                    .onSubmit { sendCommand() }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color.white)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.04), radius: 4, y: 2)

            Button(action: sendCommand) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(.white)
                    .frame(width: 44, height: 44)
                    .background(Color.kcBlue)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .disabled(commandText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || selectedSession == nil || !webSocket.isConnected)
        }
        .opacity(selectedSession == nil ? 0.6 : 1)
    }

    @ViewBuilder
    private var statusBanner: some View {
        if let message = terminalStatusMessage {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: terminalStatusIcon)
                    .foregroundColor(terminalStatusColor)
                VStack(alignment: .leading, spacing: 4) {
                    Text(terminalStatusTitle)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(Color.kcLabel)
                    Text(message)
                        .font(.system(size: 13))
                        .foregroundColor(Color.kcSecondaryLabel)
                }
                Spacer()
            }
            .padding(14)
            .cardStyle()
        }
    }

    private var terminalStatusTitle: String {
        if state.normalizedServerURL.isEmpty { return "Connect a server" }
        if terminalError != nil { return "Terminal action failed" }
        if webSocket.lastError != nil && !webSocket.isConnected { return "Terminal disconnected" }
        if selectedSession == nil { return "No sessions yet" }
        if let selectedSession, !selectedSession.isAlive { return "Session ended" }
        return "Live terminal ready"
    }

    private var terminalStatusMessage: String? {
        if state.normalizedServerURL.isEmpty {
            return "Add your Klaw Control server in Settings before opening a terminal."
        }
        if let terminalError {
            return terminalError
        }
        if let lastError = webSocket.lastError, !webSocket.isConnected {
            return lastError
        }
        if selectedSession == nil {
            return state.isConnected ? "Create a session to start an interactive shell." : (state.lastError ?? "Reconnect to load terminal sessions.")
        }
        if let selectedSession, !selectedSession.isAlive {
            return "This session has exited. Create a new one or close it."
        }
        return nil
    }

    private var terminalStatusIcon: String {
        if state.normalizedServerURL.isEmpty { return "link.badge.plus" }
        if terminalError != nil || (webSocket.lastError != nil && !webSocket.isConnected) { return "exclamationmark.triangle" }
        if selectedSession == nil { return "terminal" }
        if let selectedSession, !selectedSession.isAlive { return "xmark.circle" }
        return "checkmark.circle"
    }

    private var terminalStatusColor: Color {
        if state.normalizedServerURL.isEmpty { return Color.kcBlue }
        if terminalError != nil || (webSocket.lastError != nil && !webSocket.isConnected) { return Color.kcOrange }
        if let selectedSession, !selectedSession.isAlive { return Color.kcRed }
        return Color.kcGreen
    }

    private var emptyStateMessage: String? {
        if state.normalizedServerURL.isEmpty {
            return "Connect to a server in Settings to use live terminals."
        }
        if selectedSession == nil {
            return "No terminal session selected."
        }
        return nil
    }

    private func sendCommand() {
        let trimmed = commandText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        webSocket.send("\(trimmed)\r")
        commandText = ""
    }

    private func synchronizeSelectionAndConnection(forceReconnect: Bool = false) async {
        if let selectedSid, state.terminals.contains(where: { $0.sid == selectedSid }) == false {
            self.selectedSid = state.terminals.first?.sid
        }

        if self.selectedSid == nil {
            self.selectedSid = state.terminals.first?.sid
        }

        guard let sid = self.selectedSid, !state.normalizedServerURL.isEmpty else {
            webSocket.disconnect()
            if selectedSession == nil {
                webSocket.clearOutput()
            }
            return
        }

        if forceReconnect {
            webSocket.disconnect()
        }

        webSocket.connect(baseURL: state.normalizedServerURL, token: state.authToken, sid: sid)
    }

    private func createTerminal() async {
        guard !state.normalizedServerURL.isEmpty else {
            terminalError = "Add a server URL first."
            return
        }

        isCreatingTerminal = true
        terminalError = nil

        do {
            let created = try await state.api.spawnTerminal()
            await state.refreshAll()
            selectedSid = created.sid
            await synchronizeSelectionAndConnection(forceReconnect: true)
        } catch {
            terminalError = error.localizedDescription
        }

        isCreatingTerminal = false
    }

    private func renameSelectedTerminal() async {
        guard let selectedSession else { return }

        let trimmed = renameValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        terminalError = nil

        do {
            try await state.api.renameTerminal(sid: selectedSession.sid, name: trimmed)
            await state.refreshAll()
        } catch {
            terminalError = error.localizedDescription
        }
    }

    private func closeSelectedTerminal() async {
        guard let session = pendingTerminalToClose ?? selectedSession else { return }

        terminalError = nil

        do {
            try await state.api.killTerminal(sid: session.sid)
            if session.sid == selectedSid {
                webSocket.disconnect()
                webSocket.clearOutput()
            }
            await state.refreshAll()
            selectedSid = state.terminals.first(where: { $0.sid != session.sid })?.sid
            pendingTerminalToClose = nil
            await synchronizeSelectionAndConnection(forceReconnect: true)
        } catch {
            terminalError = error.localizedDescription
        }
    }
}

struct TerminalPillTab: View {
    let name: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(name)
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(isSelected ? .white : Color.kcLabel)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(isSelected ? Color.kcBlue : Color.white)
                .clipShape(Capsule())
                .overlay(
                    Capsule()
                        .stroke(isSelected ? Color.clear : Color(hex: "E5E5EA"), lineWidth: 1)
                )
        }
    }
}
