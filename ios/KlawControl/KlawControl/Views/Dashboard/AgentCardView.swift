import SwiftUI

struct AgentCardView: View {
    let agent: AgentSession

    private var iconColor: Color {
        agent.isMain ? Color.kcOrange : Color.kcBlue
    }

    private var iconName: String {
        agent.isMain ? "brain" : "gear"
    }

    private var statusColor: Color {
        switch agent.status {
        case "active": return agent.isMain ? Color.kcGreen : Color.kcBlue
        case "completed": return Color.kcGray
        case "failed": return Color.kcRed
        default: return Color.kcGray
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(iconColor)
                    .frame(width: 40, height: 40)
                Image(systemName: iconName)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(.white)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(agent.label ?? agent.id)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(Color.kcLabel)
                    .lineLimit(1)
                if let task = agent.task {
                    Text(task)
                        .font(.system(size: 13))
                        .foregroundColor(Color.kcSecondaryLabel)
                        .lineLimit(1)
                } else if let uptime = agent.uptimeString {
                    Text(uptime)
                        .font(.system(size: 13))
                        .foregroundColor(Color.kcSecondaryLabel)
                }
            }

            Spacer()

            StatusBadge(text: agent.statusBadgeText, color: statusColor)
        }
        .padding(16)
        .cardStyle()
    }
}
