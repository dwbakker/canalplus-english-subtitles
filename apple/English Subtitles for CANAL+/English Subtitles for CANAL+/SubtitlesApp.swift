//
//  SubtitlesApp.swift
//  English Subtitles for CANAL+
//
//  The app that carries the Safari extension. Its window is a setup checklist: turn the
//  extension on in Safari, and download French and English for Apple's on-device translator
//  (the extension can't show the download prompt itself).
//

import SwiftUI
import SafariServices
import Translation

let extensionBundleIdentifier = "io.github.dwbakker.canalplus-subtitles.Extension"
private let french = Locale.Language(identifier: "fr")
private let english = Locale.Language(identifier: "en")

@main
struct SubtitlesApp: App {
    var body: some Scene {
        WindowGroup {
            SetupView()
                .frame(width: 480)
        }
        .windowResizability(.contentSize)
        .windowStyle(.hiddenTitleBar)
    }
}

struct SetupView: View {
    @State private var extensionOn: Bool?
    @State private var languages: LanguageAvailability.Status?
    @State private var download: TranslationSession.Configuration?
    @State private var downloadError: String?

    var body: some View {
        ZStack {
            Backdrop()
            VStack(alignment: .leading, spacing: 18) {
                header
                GlassEffectContainer(spacing: 12) {
                    VStack(spacing: 12) {
                        StepCard(number: 1, title: "Turn on the extension in Safari",
                                 detail: "Safari → Settings → Extensions → English Subtitles for CANAL+. Allow it on canalplus.com, akamaized.net and, for Claude, api.anthropic.com.",
                                 done: extensionOn == true) {
                            Button("Open Safari Settings", action: openSafariSettings)
                                .buttonStyle(.glassProminent)
                        }
                        StepCard(number: 2, title: "Download French and English",
                                 detail: downloadDetail,
                                 done: languages == .installed) {
                            if languages == .supported {
                                Button("Download", action: startDownload)
                                    .buttonStyle(.glassProminent)
                            }
                        }
                        StepCard(number: 3, title: "Watch with English subtitles",
                                 detail: "In the extension's popup, choose Apple (free, on this Mac) or Claude (your API key). Then pick “Anglais” in the CANAL+ subtitle menu.",
                                 done: nil) { EmptyView() }
                    }
                }
            }
            .padding(28)
        }
        .task { await refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await refresh() }
        }
        // Presents the system download prompt for the language pack, then translates nothing.
        .translationTask(download) { session in
            do {
                try await session.prepareTranslation()
                downloadError = nil
            } catch {
                downloadError = error.localizedDescription
            }
            await refresh()
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            AppGlyph()
            VStack(alignment: .leading, spacing: 2) {
                Text("English Subtitles for CANAL+")
                    .font(.title2.weight(.semibold))
                Text("French subtitles, translated in Safari")
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.top, 8)
    }

    private var downloadDetail: String {
        if let downloadError { return "The download didn't finish: \(downloadError)" }
        switch languages {
        case .installed: return "Ready. Apple's translator works on this Mac, offline and free."
        case .supported: return "Needed for the free Apple translator. About 100 MB, once."
        case .unsupported: return "French to English isn't available on this Mac. Use Claude instead."
        default: return "Checking…"
        }
    }

    private func startDownload() {
        if download == nil {
            download = TranslationSession.Configuration(source: french, target: english)
        } else {
            download?.invalidate() // runs the task again
        }
    }

    private func openSafariSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in }
    }

    private func refresh() async {
        languages = await LanguageAvailability().status(from: french, to: english)
        extensionOn = await withCheckedContinuation { continuation in
            SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { state, _ in
                continuation.resume(returning: state?.isEnabled)
            }
        }
    }
}

/// One checklist step on a Liquid Glass card.
struct StepCard<Action: View>: View {
    let number: Int
    let title: String
    let detail: String
    let done: Bool?
    @ViewBuilder var action: () -> Action

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            ZStack {
                Circle().fill(done == true ? AnyShapeStyle(Color.green.gradient) : AnyShapeStyle(.white.opacity(0.18)))
                if done == true {
                    Image(systemName: "checkmark").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                } else {
                    Text("\(number)").font(.system(size: 13, weight: .semibold, design: .rounded))
                }
            }
            .frame(width: 28, height: 28)

            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(detail).font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if done != true {
                    action().padding(.top, 4)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
    }
}

/// The colour behind the glass, so it has something to refract (matches the extension popup).
struct Backdrop: View {
    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.05, green: 0.06, blue: 0.14), Color(red: 0.11, green: 0.06, blue: 0.16)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            Circle().fill(Color(red: 0.17, green: 0.36, blue: 1.0)).frame(width: 300).blur(radius: 70).offset(x: -170, y: -190)
            Circle().fill(Color(red: 0.76, green: 0.21, blue: 0.5)).frame(width: 260).blur(radius: 70).offset(x: 190, y: 40)
            Circle().fill(Color(red: 0.06, green: 0.61, blue: 0.54)).frame(width: 280).blur(radius: 70).offset(x: -40, y: 260)
        }
        .ignoresSafeArea()
    }
}

struct AppGlyph: View {
    var body: some View {
        Text("EN")
            .font(.system(size: 17, weight: .bold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: 52, height: 52)
            .background(
                LinearGradient(colors: [Color(red: 0.24, green: 0.55, blue: 1), Color(red: 0.48, green: 0.36, blue: 1), Color(red: 1, green: 0.37, blue: 0.64)],
                               startPoint: .topLeading, endPoint: .bottomTrailing),
                in: .rect(cornerRadius: 15)
            )
            .shadow(color: .blue.opacity(0.35), radius: 10, y: 4)
    }
}
