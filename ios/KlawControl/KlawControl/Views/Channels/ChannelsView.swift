import SwiftUI

struct ChannelsView: View {
    @EnvironmentObject private var state: AppState

    private var displayedChannels: [ChannelStatus] {
        let discord = state.channels.first(where: { $0.id.lowercased() == "discord" }) ?? ChannelStatus.mockData[0]
        let telegram = state.channels.first(where: { $0.id.lowercased() == "telegram" }) ?? ChannelStatus.mockData[1]
        return [discord, telegram]
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    ForEach(displayedChannels) { channel in
                        ChannelCard(channel: channel)
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
}

// MARK: - Channel Card

struct ChannelCard: View {
    let channel: ChannelStatus

    private var platformIcon: String {
        switch channel.id.lowercased() {
        case "discord": return "bubble.left.and.bubble.right"
        case "telegram": return "paperplane"
        default: return "antenna.radiowaves.left.and.right"
        }
    }

    private var platformColor: Color {
        switch channel.id.lowercased() {
        case "discord": return Color(hex: "5865F2")
        case "telegram": return Color(hex: "2AABEE")
        default: return Color.kcBlue
        }
    }

    private var connectionColor: Color {
        switch channel.healthState {
        case .connected: return Color.kcGreen
        case .warning: return Color.kcOrange
        case .disconnected: return Color.kcRed
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(platformColor)
                        .frame(width: 48, height: 48)
                    Image(systemName: platformIcon)
                        .font(.system(size: 21, weight: .semibold))
                        .foregroundColor(.white)
                }

                Text(channel.displayName)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(Color.kcLabel)

                Spacer()

                HStack(spacing: 5) {
                    Circle()
                        .fill(connectionColor)
                        .frame(width: 8, height: 8)
                    Text(channel.connectionLabel)
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
                ChannelStatCell(label: "LAST IN", value: channel.lastMessageIn ?? "-")
                ChannelStatCell(label: "LAST OUT", value: channel.lastMessageOut ?? "-")
                ChannelStatCell(
                    label: "ACTIVE CHANNELS",
                    value: channel.activeChannels.map { "\($0)/\(channel.totalChannels ?? $0)" } ?? "-"
                )
                ChannelStatCell(
                    label: "MESSAGES TODAY",
                    value: channel.messagesToday.map(String.init) ?? "-",
                    valueColor: Color.kcBlue
                )
            }
            .background(Color(hex: "F2F2F7"))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
        }
        .cardStyle()
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
