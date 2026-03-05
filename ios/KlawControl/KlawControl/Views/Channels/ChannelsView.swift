import SwiftUI

struct ChannelsView: View {
    @Environment(AppState.self) private var state

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    // Gateway health
                    if let health = state.gatewayHealth {
                        HStack {
                            Image(systemName: health.isOk ? "checkmark.shield" : "exclamationmark.shield")
                                .font(.title2)
                                .foregroundStyle(health.isOk ? .green : .orange)
                            VStack(alignment: .leading) {
                                Text("Gateway")
                                    .font(.headline)
                                Text(health.status)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                        }
                        .padding()
                        .background(.ultraThinMaterial)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }

                    // Channels
                    if state.channels.isEmpty {
                        ContentUnavailableView("No Channels", systemImage: "antenna.radiowaves.left.and.right", description: Text("Connect to your Klaw Control server"))
                    } else {
                        ForEach(state.channels) { channel in
                            ChannelDetailCard(channel: channel)
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("Channels")
            .refreshable {
                await state.refreshAll()
            }
        }
    }
}

struct ChannelDetailCard: View {
    let channel: ChannelStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: channel.icon)
                    .font(.title2)
                    .foregroundStyle(channel.connected ? .green : .red)
                Text(channel.displayName)
                    .font(.title3.bold())
                Spacer()
                Circle()
                    .fill(channel.connected ? .green : .red)
                    .frame(width: 10, height: 10)
            }

            if let lastIn = channel.lastMessageIn {
                HStack {
                    Text("Last In")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(lastIn)
                }
                .font(.caption)
            }

            if let lastOut = channel.lastMessageOut {
                HStack {
                    Text("Last Out")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(lastOut)
                }
                .font(.caption)
            }
        }
        .padding()
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}
