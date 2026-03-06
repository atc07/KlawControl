import SwiftUI

struct TerminalsListView: View {
    @EnvironmentObject private var state: AppState
    @State private var selectedSid: String?
    @State private var commandText = ""

    var selectedSession: TerminalSession? {
        guard let sid = selectedSid else { return state.terminals.first }
        return state.terminals.first(where: { $0.sid == sid }) ?? state.terminals.first
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Session pill tabs
                sessionTabs

                // Terminal body + input
                VStack(spacing: 12) {
                    // Dark terminal view
                    terminalView

                    // Command input
                    commandInput
                }
                .padding(16)

                Spacer()
            }
            .background(Color.kcBackground)
            .navigationTitle("Terminal")
            .navigationBarTitleDisplayMode(.large)
        }
    }

    // MARK: - Session Tabs

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

                // New tab button
                Button {
                    // Phase 3: spawn new terminal
                } label: {
                    Text("+ New")
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
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .background(Color.kcBackground)
    }

    // MARK: - Terminal View

    private var terminalView: some View {
        ScrollView {
            Text(TerminalSession.mockOutput)
                .font(.system(size: 13, design: .monospaced))
                .foregroundColor(.white)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 340)
        .background(Color(hex: "1C1C1E"))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    // MARK: - Command Input

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
            .disabled(commandText.isEmpty)
        }
    }

    private func sendCommand() {
        guard !commandText.isEmpty else { return }
        // Phase 3: send via WebSocket
        commandText = ""
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
