import SwiftUI

struct DashboardView: View {
    @Environment(AppState.self) private var state

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    // Gateway Health
                    healthCard

                    // Quick Stats
                    statsRow

                    // Channel Status
                    if !state.channels.isEmpty {
                        sectionHeader("Channels")
                        ForEach(state.channels) { channel in
                            ChannelCard(channel: channel)
                        }
                    }

                    // Agents
                    sectionHeader("Agents")
                    if state.agents.isEmpty {
                        Text("No active agents")
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .padding()
                    } else {
                        ForEach(state.agents) { agent in
                            NavigationLink(destination: AgentDetailView(agent: agent)) {
                                AgentCardView(agent: agent)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("Klaw Control")
            .refreshable {
                await state.refreshAll()
            }
            .onAppear {
                state.startAutoRefresh()
            }
            .onDisappear {
                state.stopAutoRefresh()
            }
        }
    }

    private var healthCard: some View {
        HStack {
            Circle()
                .fill(state.isConnected ? .green : .red)
                .frame(width: 12, height: 12)
            Text(state.isConnected ? "Connected" : "Disconnected")
                .font(.headline)
            Spacer()
            if let health = state.gatewayHealth {
                Text(health.status.uppercased())
                    .font(.caption.bold())
                    .foregroundStyle(health.isOk ? .green : .orange)
            }
        }
        .padding()
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var statsRow: some View {
        HStack(spacing: 12) {
            StatBadge(label: "Agents", value: "\(state.agents.count)", icon: "brain.head.profile")
            StatBadge(label: "Channels", value: "\(state.channels.filter(\.connected).count)/\(state.channels.count)", icon: "antenna.radiowaves.left.and.right")
            StatBadge(label: "Terminals", value: "\(state.terminals.filter { $0.isAlive }.count)", icon: "terminal")
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        HStack {
            Text(title)
                .font(.title3.bold())
            Spacer()
        }
    }
}

struct StatBadge: View {
    let label: String
    let value: String
    let icon: String

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(.cyan)
            Text(value)
                .font(.title2.bold().monospacedDigit())
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

struct ChannelCard: View {
    let channel: ChannelStatus

    var body: some View {
        HStack {
            Image(systemName: channel.icon)
                .foregroundStyle(channel.connected ? .green : .red)
                .font(.title3)
            VStack(alignment: .leading, spacing: 2) {
                Text(channel.displayName)
                    .font(.headline)
                if let lastIn = channel.lastMessageIn {
                    Text("Last in: \(lastIn)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Text(channel.connected ? "LIVE" : "DOWN")
                .font(.caption.bold())
                .foregroundStyle(channel.connected ? .green : .red)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(channel.connected ? Color.green.opacity(0.15) : Color.red.opacity(0.15))
                .clipShape(Capsule())
        }
        .padding()
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}
