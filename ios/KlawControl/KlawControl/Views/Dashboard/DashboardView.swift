import SwiftUI

struct DashboardView: View {
    @EnvironmentObject private var state: AppState

    private var mainAgent: AgentSession? {
        state.agents.first(where: { $0.kind == "main" }) ?? state.agents.first
    }

    private var subAgents: [AgentSession] {
        state.agents.filter { $0.kind == "sub-agent" }
    }

    private var hasConfiguredServer: Bool {
        !state.normalizedServerURL.isEmpty
    }

    private var totalAgentCount: Int {
        state.agents.count
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    connectionBanner
                    healthPillsRow
                    statsCard
                    mainAgentSection
                    subAgentsSection
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 16)
            }
            .background(Color.kcBackground)
            .navigationTitle("Dashboard")
            .navigationBarTitleDisplayMode(.large)
            .refreshable {
                await state.refreshAll()
            }
        }
    }

    private var healthPillsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                HealthPill(name: "Gateway", state: state.gatewayHealth?.isOk == true ? .connected : .disconnected)
                HealthPill(name: "Discord", state: channelHealth(for: "discord"))
                HealthPill(name: "Telegram", state: channelHealth(for: "telegram"))
            }
            .padding(.vertical, 2)
        }
    }

    private var statsCard: some View {
        HStack(spacing: 0) {
            StatBox(value: formatNumber(state.messagesToday), label: "MESSAGES")
            Rectangle()
                .fill(Color(hex: "E5E5EA"))
                .frame(width: 0.5)
            StatBox(value: "\(totalAgentCount)", label: "AGENTS")
            Rectangle()
                .fill(Color(hex: "E5E5EA"))
                .frame(width: 0.5)
            StatBox(
                value: state.totalTokens.map(formatTokens) ?? "--",
                label: "TOKENS",
                valueColor: state.totalTokens == nil ? Color.kcSecondaryLabel : Color.kcBlue
            )
        }
        .frame(height: 88)
        .cardStyle()
    }

    private var mainAgentSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("MAIN AGENT")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(Color.kcSecondaryLabel)
                Spacer()
                if let agent = mainAgent {
                    StatusBadge(text: agent.statusBadgeText, color: badgeColor(for: agent))
                }
            }

            if let agent = mainAgent {
                NavigationLink(destination: AgentDetailView(agent: agent)) {
                    MainAgentCard(agent: agent)
                }
                .buttonStyle(.plain)
            } else {
                Text("No main agent running")
                    .foregroundColor(Color.kcSecondaryLabel)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .cardStyle()
            }
        }
    }

    @ViewBuilder
    private var connectionBanner: some View {
        if hasConfiguredServer && !state.isConnected {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "wifi.exclamationmark")
                    .foregroundColor(Color.kcOrange)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Server unavailable")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(Color.kcLabel)
                    Text(state.lastError ?? "Check the host, port, or auth token in Settings.")
                        .font(.system(size: 13))
                        .foregroundColor(Color.kcSecondaryLabel)
                }
                Spacer()
            }
            .padding(14)
            .cardStyle()
        }
    }

    private var subAgentsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("SUB-AGENTS")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(Color.kcSecondaryLabel)
                Spacer()
                let active = subAgents.filter(\.isActive).count
                Text("\(active) active")
                    .font(.system(size: 13))
                    .foregroundColor(Color.kcSecondaryLabel)
            }

            if subAgents.isEmpty {
                Text("No sub-agents running")
                    .foregroundColor(Color.kcSecondaryLabel)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .cardStyle()
            } else {
                SubAgentsList(agents: subAgents)
            }
        }
    }

    private func badgeColor(for agent: AgentSession) -> Color {
        switch agent.status {
        case "active":
            return agent.isMain ? Color.kcGreen : Color.kcBlue
        case "completed":
            return Color.kcGray
        case "failed":
            return Color.kcRed
        default:
            return Color.kcGray
        }
    }

    private func formatNumber(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fK", Double(n) / 1_000) }
        return "\(n)"
    }

    private func formatTokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.0fK", Double(n) / 1_000) }
        return "\(n)"
    }

    private func channelHealth(for id: String) -> ChannelStatus.HealthState {
        if let channel = state.channels.first(where: { $0.id.caseInsensitiveCompare(id) == .orderedSame }) {
            return channel.healthState
        }
        return state.isConnected ? .warning : .disconnected
    }
}

// MARK: - Health Pill

struct HealthPill: View {
    let name: String
    let state: ChannelStatus.HealthState

    private var dotColor: Color {
        switch state {
        case .connected: return Color.kcGreen
        case .warning: return Color.kcOrange
        case .disconnected: return Color.kcRed
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)
            Text(name)
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(Color.kcLabel)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(Color.white)
        .clipShape(Capsule())
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }
}

// MARK: - Stat Box

struct StatBox: View {
    let value: String
    let label: String
    var valueColor: Color = Color.kcBlue

    var body: some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.system(size: 26, weight: .bold, design: .rounded))
                .foregroundColor(valueColor)
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(Color.kcSecondaryLabel)
                .tracking(0.5)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Main Agent Card

struct MainAgentCard: View {
    let agent: AgentSession

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(Color.kcOrange)
                    .frame(width: 40, height: 40)
                Image(systemName: "brain")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(.white)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(agent.label ?? agent.id)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(Color.kcLabel)
                if let uptime = agent.uptimeString {
                    Text(uptime)
                        .font(.system(size: 13))
                        .foregroundColor(Color.kcSecondaryLabel)
                }
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(Color(hex: "C7C7CC"))
        }
        .padding(16)
        .cardStyle()
    }
}

// MARK: - Sub-Agents List

struct SubAgentsList: View {
    let agents: [AgentSession]

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(agents.enumerated()), id: \.element.id) { index, agent in
                NavigationLink(destination: AgentDetailView(agent: agent)) {
                    SubAgentRow(agent: agent, index: index)
                }
                .buttonStyle(.plain)
                if index < agents.count - 1 {
                    Rectangle()
                        .fill(Color(hex: "F2F2F7"))
                        .frame(height: 1)
                        .padding(.leading, 68)
                }
            }
        }
        .cardStyle()
    }
}

struct SubAgentRow: View {
    let agent: AgentSession
    let index: Int

    private let iconConfigs: [(icon: String, color: Color)] = [
        ("gear", Color.kcBlue),
        ("magnifyingglass", Color.kcPurple),
        ("checkmark", Color.kcGreen)
    ]

    private var iconConfig: (icon: String, color: Color) {
        iconConfigs[index % iconConfigs.count]
    }

    private var statusColor: Color {
        switch agent.status {
        case "active": return Color.kcBlue
        case "completed": return Color.kcGray
        case "failed": return Color.kcRed
        default: return Color.kcGray
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(iconConfig.color)
                    .frame(width: 40, height: 40)
                Image(systemName: iconConfig.icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(.white)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(agent.label ?? agent.id)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(Color.kcLabel)
                if let task = agent.task {
                    Text(task)
                        .font(.system(size: 13))
                        .foregroundColor(Color.kcSecondaryLabel)
                        .lineLimit(1)
                }
            }

            Spacer()

            StatusBadge(text: agent.statusBadgeText, color: statusColor)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}
