import SwiftUI

struct AgentCardView: View {
    let agent: AgentSession

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: agent.kindIcon)
                .font(.title2)
                .foregroundStyle(.cyan)
                .frame(width: 40)

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(agent.label ?? agent.id)
                        .font(.headline)
                        .lineLimit(1)
                    Spacer()
                    statusBadge
                }
                if let task = agent.task {
                    Text(task)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                HStack {
                    if let model = agent.model {
                        Text(model)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    Spacer()
                    Text(agent.kind)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding()
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var statusBadge: some View {
        Text(agent.status.uppercased())
            .font(.caption2.bold())
            .foregroundStyle(statusColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(statusColor.opacity(0.15))
            .clipShape(Capsule())
    }

    private var statusColor: Color {
        switch agent.status {
        case "active": .green
        case "completed": .blue
        case "failed": .red
        default: .gray
        }
    }
}
