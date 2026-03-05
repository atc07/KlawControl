import SwiftUI

struct AgentDetailView: View {
    @Environment(AppState.self) private var state
    let agent: AgentSession
    @State private var steerMessage = ""
    @State private var showKillConfirm = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // Header
                HStack {
                    Image(systemName: agent.kindIcon)
                        .font(.largeTitle)
                        .foregroundStyle(.cyan)
                    VStack(alignment: .leading) {
                        Text(agent.label ?? agent.id)
                            .font(.title2.bold())
                        Text(agent.kind)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }

                // Info
                infoRow("Status", agent.status)
                if let model = agent.model {
                    infoRow("Model", model)
                }
                if let task = agent.task {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Task")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(task)
                            .font(.body)
                    }
                }

                Divider()

                // Steer
                VStack(alignment: .leading, spacing: 8) {
                    Text("Send Message")
                        .font(.headline)
                    HStack {
                        TextField("Message...", text: $steerMessage)
                            .textFieldStyle(.roundedBorder)
                        Button("Send") {
                            Task {
                                try? await state.api.steerAgent(id: agent.id, message: steerMessage)
                                steerMessage = ""
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.cyan)
                        .disabled(steerMessage.isEmpty)
                    }
                }

                // Kill
                if agent.isActive {
                    Button(role: .destructive) {
                        showKillConfirm = true
                    } label: {
                        Label("Kill Agent", systemImage: "xmark.octagon")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .confirmationDialog("Kill this agent?", isPresented: $showKillConfirm) {
                        Button("Kill", role: .destructive) {
                            Task { try? await state.api.killAgent(id: agent.id) }
                        }
                    }
                }
            }
            .padding()
        }
        .navigationTitle("Agent Detail")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .bold()
        }
    }
}
