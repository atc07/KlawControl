import SwiftUI

struct TerminalsListView: View {
    @Environment(AppState.self) private var state
    @State private var showRename: TerminalSession?
    @State private var renameText = ""
    @State private var navigateToSid: String?

    var body: some View {
        NavigationStack {
            List {
                if state.terminals.isEmpty {
                    ContentUnavailableView("No Sessions", systemImage: "terminal", description: Text("Tap + to create a new terminal session"))
                }

                ForEach(state.terminals) { session in
                    NavigationLink(value: session.sid) {
                        HStack {
                            Image(systemName: session.isAlive ? "terminal" : "terminal.fill")
                                .foregroundStyle(session.isAlive ? .green : .gray)
                            VStack(alignment: .leading) {
                                Text(session.name)
                                    .font(.headline)
                                if let pid = session.pid {
                                    Text("PID: \(pid)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            if session.isAlive {
                                Circle()
                                    .fill(.green)
                                    .frame(width: 8, height: 8)
                            }
                        }
                    }
                    .contextMenu {
                        Button {
                            renameText = session.name
                            showRename = session
                        } label: {
                            Label("Rename", systemImage: "pencil")
                        }
                        Button(role: .destructive) {
                            Task {
                                try? await state.api.killTerminal(sid: session.sid)
                                await state.refreshAll()
                            }
                        } label: {
                            Label("Kill", systemImage: "xmark.octagon")
                        }
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task {
                                try? await state.api.killTerminal(sid: session.sid)
                                await state.refreshAll()
                            }
                        } label: {
                            Label("Kill", systemImage: "trash")
                        }
                    }
                }
            }
            .navigationTitle("Terminals")
            .navigationDestination(for: String.self) { sid in
                TerminalView(sid: sid)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task {
                            let response = try await state.api.spawnTerminal()
                            await state.refreshAll()
                            navigateToSid = response.sid
                        }
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .navigationDestination(item: $navigateToSid) { sid in
                TerminalView(sid: sid)
            }
            .alert("Rename Session", isPresented: .init(
                get: { showRename != nil },
                set: { if !$0 { showRename = nil } }
            )) {
                TextField("Name", text: $renameText)
                Button("Rename") {
                    if let session = showRename {
                        Task {
                            try? await state.api.renameTerminal(sid: session.sid, name: renameText)
                            await state.refreshAll()
                        }
                    }
                    showRename = nil
                }
                Button("Cancel", role: .cancel) { showRename = nil }
            }
            .refreshable {
                await state.refreshAll()
            }
        }
    }
}
