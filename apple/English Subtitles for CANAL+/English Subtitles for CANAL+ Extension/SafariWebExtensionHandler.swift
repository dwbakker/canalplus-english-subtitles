//
//  SafariWebExtensionHandler.swift
//  English Subtitles for CANAL+ Extension
//
//  Receives browser.runtime.sendNativeMessage() calls from background.js and translates
//  subtitle lines with Apple's on-device translator (Translation framework).
//
//  Request:  { type: "translate", items: [{ id, text }] }
//  Response: { ok: true, translations: { id: english } }
//            { ok: false, error: "...", retryable: Bool }
//

import SafariServices
import Translation
import os.log

private let log = Logger(subsystem: "io.github.dwbakker.canalplus-subtitles", category: "translate")

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey] as? [String: Any]
        nonisolated(unsafe) let context = context
        Task {
            let reply = await Self.handle(message)
            let response = NSExtensionItem()
            response.userInfo = [SFExtensionMessageKey: reply]
            context.completeRequest(returningItems: [response], completionHandler: nil)
        }
    }

    static func handle(_ message: [String: Any]?) async -> [String: Any] {
        guard message?["type"] as? String == "translate",
              let items = message?["items"] as? [[String: Any]] else {
            return ["ok": false, "error": "Unknown request"]
        }
        let requests = items.compactMap { item -> TranslationSession.Request? in
            guard let id = item["id"] as? String, let text = item["text"] as? String else { return nil }
            return TranslationSession.Request(sourceText: text, clientIdentifier: id)
        }
        if requests.isEmpty { return ["ok": true, "translations": [String: String]()] }

        // Downloading languages needs UI, which an extension can't show; the app does that.
        switch await LanguageAvailability().status(from: Languages.french, to: Languages.english) {
        case .installed:
            break
        case .supported:
            return ["ok": false, "error": "Open the English Subtitles for CANAL+ app and download French and English first."]
        default:
            return ["ok": false, "error": "French to English translation isn't available on this Mac."]
        }

        do {
            let session = TranslationSession(installedSource: Languages.french, target: Languages.english)
            let responses = try await session.translations(from: requests)
            var out: [String: String] = [:]
            for response in responses {
                if let id = response.clientIdentifier { out[id] = response.targetText }
            }
            return ["ok": true, "translations": out]
        } catch {
            log.error("translation failed: \(error.localizedDescription, privacy: .public)")
            return ["ok": false, "error": "Apple translation failed: \(error.localizedDescription)", "retryable": true]
        }
    }
}

enum Languages {
    static let french = Locale.Language(identifier: "fr")
    static let english = Locale.Language(identifier: "en")
}
