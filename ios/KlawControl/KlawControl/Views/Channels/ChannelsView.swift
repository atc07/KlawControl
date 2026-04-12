import SwiftUI

struct ChannelsView: View {
    @EnvironmentObject private var state: AppState

    struct ChannelDefinition: Identifiable {
        let id: String
        let title: String
        let icon: String
        let color: Color
    }

    private let supportedChannels: [ChannelDefinition] = [
        ChannelDefinition(id: "discord", title: "Discord", icon: "bubble.left.and.bubble.right", color: Color(hex: "5865F2")),
        ChannelDefinition(id: "telegram", title: "Telegram", icon: "paperplane", color: Color(hex: "2AABEE"))
    ]

    private var hasConfiguredServer: Bool {
        !state.normalizedServerURL.isEmpty
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    if hasConfiguredServer && !state.isConnected {
                        disconnectedBanner
                    }

                    ForEach(supportedChannels) { definition in
                        ChannelCard(
                            definition: definition,
                            channel: state.channels.first(where: { $0.id.caseInsensitiveCompare(definition.id) == .orderedSame }),
                            serverReachable: state.isConnected
                        )
                    }

                    if let health = state.gatewayHealth {
                        GatewayHealthSection(health: health)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 16)
            }
            .background(Color.kcBackground)
            .navigationTitle("Channels")
            .navigationBarTitleDisplayMode(.large)
            .refreshable {
                await state.refreshAll()
            }
        }
    }

    private var disconnectedBanner: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "antenna.radiowaves.left.and.right.slash")
                .foregroundColor(Color.kcOrange)
            VStack(alignment: .leading, spacing: 4) {
                Text("Channel data unavailable")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(Color.kcLabel)
                Text(state.lastError ?? "Reconnect to load live channel health.")
                    .font(.system(size: 13))
                    .foregroundColor(Color.kcSecondaryLabel)
            }
            Spacer()
        }
        .padding(14)
        .cardStyle()
    }
}

// MARK: - Channel Card

struct ChannelCard: View {
    let definition: ChannelsView.ChannelDefinition
    let channel: ChannelStatus?
    let serverReachable: Bool

    private var connectionColor: Color {
        guard let channel else {
            return serverReachable ? Color.kcOrange : Color.kcRed
        }

        switch channel.healthState {
        case .connected: return Color.kcGreen
        case .warning: return Color.kcOrange
        case .disconnected: return Color.kcRed
        }
    }

    private var connectionLabel: String {
        if let channel {
            return channel.connectionLabel
        }
        return serverReachable ? "Unavailable" : "Offline"
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(definition.color)
                        .frame(width: 48, height: 48)
                    Image(systemName: definition.icon)
                        .font(.system(size: 21, weight: .semibold))
                        .foregroundColor(.white)
                }

                Text(definition.title)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(Color.kcLabel)

                Spacer()

                HStack(spacing: 5) {
                    Circle()
                        .fill(connectionColor)
                        .frame(width: 8, height: 8)
                    Text(connectionLabel)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(connectionColor)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(connectionColor.opacity(0.1))
                .clipShape(Capsule())
            }
            .padding(16)

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 1) {
                ChannelStatCell(label: "LAST IN", value: channel?.lastMessageIn ?? "--")
                ChannelStatCell(label: "LAST OUT", value: channel?.lastMessageOut ?? "--")
                ChannelStatCell(label: "ACTIVE CHANNELS", value: activeChannelSummary)
                ChannelStatCell(
                    label: "MESSAGES TODAY",
                    value: channel?.messagesToday.map(String.init) ?? "--",
                    valueColor: channel?.messagesToday == nil ? Color.kcSecondaryLabel : Color.kcBlue
                )
            }
            .background(Color(hex: "F2F2F7"))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal, 16)
            .padding(.bottom, 16)

            if channel == nil {
                Text(serverReachable ? "Channel not reported by the server." : "Reconnect to load this channel.")
                    .font(.system(size: 12))
                    .foregroundColor(Color.kcSecondaryLabel)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
            }
        }
        .cardStyle()
    }

    private var activeChannelSummary: String {
        guard let channel else { return "--" }
        if let active = channel.activeChannels {
            return "\(active)/\(channel.totalChannels ?? active)"
        }
        return "--"
    }
}

struct ChannelStatCell: View {
    let label: String
    let value: String
    var valueColor: Color = Color.kcLabel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(Color.kcSecondaryLabel)
                .tracking(0.3)
            Text(value)
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(valueColor)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color.white)
    }
}

// MARK: - Gateway Health Section

struct GatewayHealthSection: View {
    let health: GatewayHealth

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("GATEWAY HEALTH")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(Color.kcSecondaryLabel)
                .padding(.leading, 4)

            VStack(spacing: 0) {
                row(title: "Status", value: health.isOk ? "Healthy" : "Degraded", valueColor: health.isOk ? Color.kcGreen : Color.kcOrange)
                divider
                row(title: "Uptime", value: health.uptimeFormatted, valueColor: Color.kcSecondaryLabel)

                if let version = health.version {
                    divider
                    row(title: "Version", value: version, valueColor: Color.kcSecondaryLabel)
                }
            }
            .cardStyle()
        }
    }

    private var divider: some View {
        Rectangle()
            .fill(Color(hex: "E5E5EA"))
            .frame(height: 0.5)
            .padding(.leading, 16)
    }

    private func row(title: String, value: String, valueColor: Color) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 16))
                .foregroundColor(Color.kcLabel)
            Spacer()
            Text(value)
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(valueColor)
        }
        .padding(16)
    }
}
