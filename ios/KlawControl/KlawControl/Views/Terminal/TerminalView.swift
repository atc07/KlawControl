import SwiftUI

// Phase 3: WebSocket PTY terminal. For now, this is a UI shell.
struct TerminalView: View {
    @EnvironmentObject private var state: AppState
    let sid: String

    @State private var commandText = ""

    var session: TerminalSession? {
        state.terminals.first(where: { $0.sid == sid })
    }

    var body: some View {
        VStack(spacing: 0) {
            // Terminal output area
            ScrollView {
                Text(TerminalSession.mockOutput)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
            .background(Color(hex: "1C1C1E"))

            // Input bar
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
            .padding(16)
            .background(Color.kcBackground)
        }
        .navigationTitle(session?.name ?? sid)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 4) {
                    Circle()
                        .fill(Color.kcGreen)
                        .frame(width: 8, height: 8)
                    Text("Live")
                        .font(.system(size: 13))
                        .foregroundColor(Color.kcSecondaryLabel)
                }
            }
        }
    }

    private func sendCommand() {
        guard !commandText.isEmpty else { return }
        // Phase 3: send via WebSocket
        commandText = ""
    }
}
