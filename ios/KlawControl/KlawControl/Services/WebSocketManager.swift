import Foundation

@MainActor
final class WebSocketManager: ObservableObject {
    @Published var output: String = ""
    @Published var isConnected = false
    @Published var lastError: String?

    private var task: URLSessionWebSocketTask?
    private let session = URLSession(configuration: .default)
    private var receiveTask: Task<Void, Never>?
    private var currentConnectionID: String?

    func connect(baseURL: String, token: String, sid: String) {
        let connectionID = "\(baseURL)|\(sid)|\(token)"
        guard currentConnectionID != connectionID || !isConnected else { return }

        disconnect()

        guard let url = websocketURL(baseURL: baseURL, token: token, sid: sid) else {
            lastError = "Invalid terminal connection URL."
            return
        }

        output = ""
        let webSocketTask = session.webSocketTask(with: url)
        task = webSocketTask
        currentConnectionID = connectionID
        webSocketTask.resume()

        isConnected = true
        lastError = nil

        receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }
    }

    func send(_ text: String) {
        guard let task else { return }

        Task {
            do {
                try await task.send(.string(text))
            } catch {
                await MainActor.run {
                    self.lastError = error.localizedDescription
                    self.isConnected = false
                }
            }
        }
    }

    func sendResize(cols: Int, rows: Int) {
        let json = "{\"type\":\"resize\",\"cols\":\(cols),\"rows\":\(rows)}"
        send(json)
    }

    func disconnect() {
        receiveTask?.cancel()
        receiveTask = nil

        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        isConnected = false
        currentConnectionID = nil
    }

    func clearOutput() {
        output = ""
    }

    private func websocketURL(baseURL: String, token: String, sid: String) -> URL? {
        let normalizedBaseURL: String
        if baseURL.hasPrefix("http://") || baseURL.hasPrefix("https://") {
            normalizedBaseURL = baseURL
        } else {
            normalizedBaseURL = "http://\(baseURL)"
        }

        guard var components = URLComponents(string: normalizedBaseURL) else { return nil }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/api/terminals/\(sid)/ws"
        if !token.isEmpty {
            components.queryItems = [URLQueryItem(name: "token", value: token)]
        }
        return components.url
    }

    private func receiveLoop() async {
        guard let task else { return }

        do {
            while !Task.isCancelled {
                let message = try await task.receive()
                switch message {
                case .string(let text):
                    append(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        append(text)
                    }
                @unknown default:
                    break
                }
            }
        } catch {
            guard !Task.isCancelled else { return }
            isConnected = false
            lastError = error.localizedDescription
        }
    }

    private func append(_ text: String) {
        output += text
        if output.count > 100_000 {
            output = String(output.suffix(80_000))
        }
    }
}
