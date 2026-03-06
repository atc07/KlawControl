import Foundation

@MainActor
final class WebSocketManager: ObservableObject {
    @Published var output: String = ""
    @Published var isConnected = false

    private var task: URLSessionWebSocketTask?
    private var session = URLSession(configuration: .default)

    func connect(baseURL: String, token: String, sid: String) {
        let wsURL = baseURL
            .replacingOccurrences(of: "http://", with: "ws://")
            .replacingOccurrences(of: "https://", with: "wss://")

        let tokenParam = token.isEmpty ? "" : "?token=\(token)"
        guard let url = URL(string: "\(wsURL)/api/terminals/\(sid)/ws\(tokenParam)") else { return }

        task = session.webSocketTask(with: url)
        task?.resume()
        isConnected = true
        receiveLoop()
    }

    func send(_ text: String) {
        task?.send(.string(text)) { _ in }
    }

    func sendResize(cols: Int, rows: Int) {
        let json = "{\"type\":\"resize\",\"cols\":\(cols),\"rows\":\(rows)}"
        task?.send(.string(json)) { _ in }
    }

    func disconnect() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        isConnected = false
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    Task { @MainActor in
                        self.output += text
                        if self.output.count > 100_000 {
                            self.output = String(self.output.suffix(80_000))
                        }
                    }
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        Task { @MainActor in
                            self.output += text
                        }
                    }
                @unknown default:
                    break
                }
                self.receiveLoop()
            case .failure:
                Task { @MainActor in
                    self.isConnected = false
                }
            }
        }
    }
}
