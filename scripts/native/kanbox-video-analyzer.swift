import Foundation
import AVFoundation
import Speech

struct TranscriptSegment: Codable {
    let start: Double
    let duration: Double
    let text: String
}

struct AnalysisResult: Codable {
    let duration: Double
    let transcriptSegments: [TranscriptSegment]
    let speechError: String?
}

struct AudioChunk {
    let url: URL
    let start: Double
    let duration: Double
}

func waitUntil(_ condition: @escaping () -> Bool, timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    return condition()
}

func speechAuthorization() -> SFSpeechRecognizerAuthorizationStatus {
    var status = SFSpeechRecognizer.authorizationStatus()
    guard status == .notDetermined else { return status }
    var finished = false
    SFSpeechRecognizer.requestAuthorization { value in
        status = value
        finished = true
    }
    _ = waitUntil({ finished }, timeout: 60)
    return status
}

func extractAudioChunks(videoURL: URL, duration: Double) -> ([AudioChunk], String?) {
    let asset = AVURLAsset(url: videoURL)
    guard !asset.tracks(withMediaType: .audio).isEmpty else {
        return ([], "视频没有可识别的音轨")
    }

    let chunkLength = 50.0
    var chunks: [AudioChunk] = []
    var start = 0.0
    while start < duration {
        let chunkDuration = min(chunkLength, duration - start)
        guard let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
            return (chunks, "系统无法读取视频音轨")
        }
        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("kanbox-\(UUID().uuidString).m4a")
        exporter.outputURL = outputURL
        exporter.outputFileType = .m4a
        exporter.shouldOptimizeForNetworkUse = false
        exporter.timeRange = CMTimeRange(
            start: CMTime(seconds: start, preferredTimescale: 600),
            duration: CMTime(seconds: chunkDuration, preferredTimescale: 600)
        )
        var finished = false
        exporter.exportAsynchronously { finished = true }
        guard waitUntil({ finished }, timeout: 180) else {
            exporter.cancelExport()
            return (chunks, "提取视频音轨超时")
        }
        guard exporter.status == .completed else {
            return (chunks, exporter.error?.localizedDescription ?? "提取视频音轨失败")
        }
        chunks.append(AudioChunk(url: outputURL, start: start, duration: chunkDuration))
        start += chunkLength
    }
    return (chunks, nil)
}

func transcribe(audioURL: URL, duration: Double, offset: Double) -> ([TranscriptSegment], String?) {
    let authorization = speechAuthorization()
    guard authorization == .authorized else {
        return ([], "没有获得本地语音识别权限")
    }
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")) else {
        return ([], "系统没有中文语音识别器")
    }
    guard recognizer.supportsOnDeviceRecognition else {
        return ([], "这台 Mac 不支持中文离线语音识别")
    }

    let request = SFSpeechURLRecognitionRequest(url: audioURL)
    request.shouldReportPartialResults = false
    request.requiresOnDeviceRecognition = true
    request.taskHint = .dictation
    request.addsPunctuation = true
    request.contextualStrings = ["AI", "ChatCut", "Codex", "Claude Code", "小红书"]

    var segments: [TranscriptSegment] = []
    var recognitionError: String?
    var finished = false
    let task = recognizer.recognitionTask(with: request) { result, error in
        if let result = result, result.isFinal {
            segments = result.bestTranscription.segments.compactMap { segment in
                let text = segment.substring.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return nil }
                return TranscriptSegment(
                    start: offset + segment.timestamp,
                    duration: segment.duration,
                    text: text
                )
            }
            finished = true
        }
        if let error = error {
            recognitionError = error.localizedDescription
            finished = true
        }
    }

    let timeout = min(max(duration * 2 + 60, 120), 600)
    if !waitUntil({ finished }, timeout: timeout) {
        task.cancel()
        return (segments, "本地语音识别超时")
    }
    task.finish()
    return (segments, recognitionError)
}

func shouldInsertSpace(_ existing: String, _ token: String) -> Bool {
    guard let previous = existing.unicodeScalars.last, let next = token.unicodeScalars.first else {
        return false
    }
    let letters = CharacterSet.letters
    return previous.isASCII && next.isASCII
        && letters.contains(previous) && letters.contains(next)
}

func groupTranscriptSegments(_ tokens: [TranscriptSegment]) -> [TranscriptSegment] {
    guard !tokens.isEmpty else { return [] }
    var groups: [TranscriptSegment] = []
    var start = tokens[0].start
    var end = tokens[0].start
    var text = ""

    func flush() {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleaned.isEmpty {
            groups.append(TranscriptSegment(start: start, duration: max(0, end - start), text: cleaned))
        }
        text = ""
    }

    for token in tokens.sorted(by: { $0.start < $1.start }) {
        let gap = token.start - end
        if !text.isEmpty && (gap > 0.9 || end - start >= 9 || text.count >= 64) {
            flush()
            start = token.start
        }
        if text.isEmpty { start = token.start }
        if shouldInsertSpace(text, token.text) { text += " " }
        text += token.text
        end = max(end, token.start + token.duration)
    }
    flush()
    return groups
}

struct ExtractAudioResult: Codable {
    let audioPath: String?
    let duration: Double
    let error: String?
}

func extractFullAudio(videoURL: URL, outputURL: URL) -> String? {
    let asset = AVURLAsset(url: videoURL)
    guard !asset.tracks(withMediaType: .audio).isEmpty else {
        return "视频没有可识别的音轨"
    }
    guard let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
        return "系统无法读取视频音轨"
    }
    exporter.outputURL = outputURL
    exporter.outputFileType = .m4a
    exporter.shouldOptimizeForNetworkUse = false
    var finished = false
    exporter.exportAsynchronously { finished = true }
    guard waitUntil({ finished }, timeout: 300) else {
        exporter.cancelExport()
        return "提取视频音轨超时"
    }
    guard exporter.status == .completed else {
        return exporter.error?.localizedDescription ?? "提取视频音轨失败"
    }
    return nil
}

func printJSON<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    guard let data = try? encoder.encode(value), let output = String(data: data, encoding: .utf8) else {
        print("{\"error\":\"分析结果编码失败\"}")
        return
    }
    print(output)
}

func printJSON(_ result: AnalysisResult) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    guard let data = try? encoder.encode(result), let output = String(data: data, encoding: .utf8) else {
        print("{\"speechError\":\"本地分析结果编码失败\",\"duration\":0,\"transcriptSegments\":[]}")
        return
    }
    print(output)
}

guard CommandLine.arguments.count >= 2 else {
    printJSON(AnalysisResult(
        duration: 0,
        transcriptSegments: [],
        speechError: "缺少视频文件路径"
    ))
    exit(0)
}

// 模式一：--extract-audio <video> <output.m4a> —— 仅提取音轨文件（供在线大模型转写），不本地识别
if CommandLine.arguments[1] == "--extract-audio" && CommandLine.arguments.count >= 4 {
    let videoURL = URL(fileURLWithPath: CommandLine.arguments[2])
    let outputURL = URL(fileURLWithPath: CommandLine.arguments[3])
    let asset = AVURLAsset(url: videoURL)
    let rawDuration = CMTimeGetSeconds(asset.duration)
    let duration = rawDuration.isFinite && rawDuration > 0 ? rawDuration : 0
    if let extractError = extractFullAudio(videoURL: videoURL, outputURL: outputURL) {
        printJSON(ExtractAudioResult(audioPath: nil, duration: duration, error: extractError))
    } else {
        printJSON(ExtractAudioResult(audioPath: outputURL.path, duration: duration, error: nil))
    }
    exit(0)
}

let videoURL = URL(fileURLWithPath: CommandLine.arguments[1])
let asset = AVURLAsset(url: videoURL)
let rawDuration = CMTimeGetSeconds(asset.duration)
let duration = rawDuration.isFinite && rawDuration > 0 ? rawDuration : 0
let (audioChunks, audioError) = extractAudioChunks(videoURL: videoURL, duration: duration)
var rawSegments: [TranscriptSegment] = []
var speechErrors: [String] = []
if let audioError = audioError { speechErrors.append(audioError) }
for chunk in audioChunks {
    let (segments, error) = transcribe(audioURL: chunk.url, duration: chunk.duration, offset: chunk.start)
    rawSegments.append(contentsOf: segments)
    if let error = error { speechErrors.append(error) }
    try? FileManager.default.removeItem(at: chunk.url)
}
let transcriptSegments = groupTranscriptSegments(rawSegments)
let speechError = speechErrors.isEmpty ? nil : speechErrors.joined(separator: "；")
printJSON(AnalysisResult(
    duration: duration,
    transcriptSegments: transcriptSegments,
    speechError: speechError
))
