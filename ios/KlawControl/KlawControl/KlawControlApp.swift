import SwiftUI

@main
struct KlawControlApp: App {
    @State private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(appState)
                .preferredColorScheme(.dark)
        }
    }
}

struct ContentView: View {
    var body: some View {
        TabView {
            DashboardView()
                .tabItem {
                    Label("Dashboard", systemImage: "gauge.with.dots.needle.33percent")
                }

            ChannelsView()
                .tabItem {
                    Label("Channels", systemImage: "antenna.radiowaves.left.and.right")
                }

            TerminalsListView()
                .tabItem {
                    Label("Terminal", systemImage: "terminal")
                }

            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
        }
        .tint(.cyan)
    }
}
