// dool2-hands (맥): 두리 PC 화면 제어 도우미 (docs/architecture.md 5.2, ADR 0013)
//
// 두리 본체가 띄워서 표준 입출력으로 한 줄 JSON을 주고받는다.
//   → {"id":1,"cmd":"snapshot","args":{"bundleId":"com.tinyspeck.slackmacgap"}}
//   ← {"id":1,"ok":true,"result":{...}}  또는  {"id":1,"ok":false,"error":"..."}
//
// 판단은 하지 않는다. 어떤 앱을 다뤄도 되는지, 어떤 버튼이 위험한지는 본체가 정한다.
// 다만 브라우저·비밀번호 관리자·두리 자신은 여기서도 막는다 (본체가 실수해도 넘지 않게).
import ApplicationServices
import Cocoa
import ScreenCaptureKit

setvbuf(stdout, nil, _IOLBF, 0)

struct HandsError: Error {
  let message: String
}

func fail(_ m: String) -> HandsError { HandsError(message: m) }

func reply(_ id: Any, ok: Bool, _ payload: Any) {
  var obj: [String: Any] = ["id": id, "ok": ok]
  if ok { obj["result"] = payload } else { obj["error"] = payload }
  guard let data = try? JSONSerialization.data(withJSONObject: obj),
    let s = String(data: data, encoding: .utf8)
  else { return }
  FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
}

// ── 막는 앱 ─────────────────────────────────────────────

/** 본체 설정과 상관없이 절대 다루지 않는 앱 (브라우저는 브라우저 도구로만, 비밀번호 관리자, 두리 자신) */
let hardBlocked: [String] = [
  "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary", "com.google.chrome.for.testing",
  "com.apple.Safari", "company.thebrowser.Browser", "com.microsoft.edgemac", "org.mozilla.firefox",
  "com.brave.Browser", "com.naver.Whale", "com.operasoftware.Opera",
  "com.1password.1password", "com.agilebits.onepassword7", "com.apple.Passwords", "com.apple.keychainaccess",
  "com.bitwarden.desktop", "com.dool2.app",
]

func checkAllowed(_ bundleId: String) throws {
  if hardBlocked.contains(bundleId) || bundleId.hasPrefix("com.dool2.") {
    throw fail("이 앱(\(bundleId))은 화면 제어로 다루지 않아요")
  }
}

// ── 앱 ─────────────────────────────────────────────────

func runningApp(_ bundleId: String) -> NSRunningApplication? {
  NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
}

func appsList() -> [[String: Any]] {
  NSWorkspace.shared.runningApplications
    .filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil }
    .map {
      [
        "bundleId": $0.bundleIdentifier ?? "",
        "name": $0.localizedName ?? "",
        "pid": Int($0.processIdentifier),
        "active": $0.isActive,
      ]
    }
}

/** 설치된 앱 (이름으로 번들 id를 찾으려고). /Applications, /System/Applications, ~/Applications */
func installedApps() -> [[String: Any]] {
  let fm = FileManager.default
  let dirs = [
    "/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
    (NSHomeDirectory() as NSString).appendingPathComponent("Applications"),
  ]
  var out: [[String: Any]] = []
  for d in dirs {
    guard let items = try? fm.contentsOfDirectory(atPath: d) else { continue }
    for it in items where it.hasSuffix(".app") {
      let path = (d as NSString).appendingPathComponent(it)
      guard let b = Bundle(path: path), let id = b.bundleIdentifier else { continue }
      out.append(["bundleId": id, "name": fm.displayName(atPath: path).replacingOccurrences(of: ".app", with: "")])
    }
  }
  return out
}

func openApp(_ bundleId: String) async throws -> [String: Any] {
  try checkAllowed(bundleId)
  guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
    throw fail("이 앱이 설치돼 있지 않아요: \(bundleId)")
  }
  let cfg = NSWorkspace.OpenConfiguration()
  cfg.activates = true
  _ = try await NSWorkspace.shared.openApplication(at: url, configuration: cfg)
  // 창이 뜰 때까지 잠깐 기다린다 (최대 8초)
  for _ in 0..<40 {
    if let app = runningApp(bundleId), app.isFinishedLaunching, focusedWindow(app.processIdentifier) != nil { break }
    try await Task.sleep(nanoseconds: 200_000_000)
  }
  return ["bundleId": bundleId, "opened": true]
}

func activate(_ bundleId: String) async throws -> NSRunningApplication {
  try checkAllowed(bundleId)
  guard let app = runningApp(bundleId) else { throw fail("이 앱이 켜져 있지 않아요. 먼저 app_open으로 여세요") }
  if !app.isActive {
    app.activate()
    try await Task.sleep(nanoseconds: 250_000_000)
  }
  return app
}

// ── 접근성 트리 ─────────────────────────────────────────

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func text(_ el: AXUIElement, _ name: String) -> String? {
  guard let s = attr(el, name) as? String else { return nil }
  let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
  return t.isEmpty ? nil : t
}

func kids(_ el: AXUIElement) -> [AXUIElement] {
  (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func frame(_ el: AXUIElement) -> CGRect? {
  guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
  var pt = CGPoint.zero
  var sz = CGSize.zero
  // swiftlint:disable force_cast
  AXValueGetValue(p as! AXValue, .cgPoint, &pt)
  AXValueGetValue(s as! AXValue, .cgSize, &sz)
  return CGRect(origin: pt, size: sz)
}

func focusedWindow(_ pid: pid_t) -> AXUIElement? {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 3)
  if let w = attr(app, kAXFocusedWindowAttribute) { return (w as! AXUIElement) }
  return (attr(app, kAXWindowsAttribute) as? [AXUIElement])?.first
}

/** 브라우저 도구와 같은 말: [e12 버튼 "보내기"] */
func roleName(_ role: String, _ subrole: String?) -> String? {
  if subrole == "AXSecureTextField" { return "비밀번호칸" }
  if subrole == "AXSearchField" { return "검색칸" }
  if subrole == "AXSwitch" { return "스위치" }
  if subrole == "AXTabButton" { return "탭" }
  switch role {
  case "AXButton", "AXMenuButton", "AXDisclosureTriangle": return "버튼"
  case "AXTextField", "AXTextArea", "AXComboBox": return "입력칸"
  case "AXCheckBox": return "체크박스"
  case "AXRadioButton": return "라디오"
  case "AXPopUpButton": return "선택 상자"
  case "AXMenuItem", "AXMenuBarItem": return "메뉴"
  case "AXLink": return "링크"
  case "AXRow", "AXCell": return "항목"
  default: return nil
  }
}

var refs: [String: AXUIElement] = [:]
var refsApp = ""

func snapshot(_ bundleId: String, maxChars: Int) async throws -> [String: Any] {
  try checkAllowed(bundleId)
  guard AXIsProcessTrusted() else { throw fail("손쉬운 사용 권한이 필요해요") }
  guard let app = runningApp(bundleId) else { throw fail("이 앱이 켜져 있지 않아요. 먼저 app_open으로 여세요") }
  guard let win = focusedWindow(app.processIdentifier) else { throw fail("이 앱에 열린 창이 없어요") }
  refs = [:]
  refsApp = bundleId
  var lines: [String] = []
  var size = 0
  var nodes = 0
  var n = 0
  var truncated = false
  func add(_ s: String) {
    if size + s.count > maxChars {
      truncated = true
      return
    }
    lines.append(s)
    size += s.count + 1
  }
  func walk(_ el: AXUIElement, _ depth: Int) {
    if truncated || nodes > 2500 || depth > 40 { return }
    nodes += 1
    let role = text(el, kAXRoleAttribute) ?? ""
    let sub = text(el, kAXSubroleAttribute)
    let name = text(el, kAXTitleAttribute) ?? text(el, kAXDescriptionAttribute)
      ?? text(el, "AXPlaceholderValue") ?? text(el, kAXHelpAttribute)
    if role == "AXStaticText" {
      if let v = text(el, kAXValueAttribute) ?? name { add(String(v.prefix(300))) }
    } else if let kr = roleName(role, sub) {
      n += 1
      let ref = "e\(n)"
      refs[ref] = el
      var line = "[\(ref) \(kr)"
      if let nm = name { line += " \"\(nm.prefix(80).replacingOccurrences(of: "\"", with: "'"))\"" }
      if role == "AXTextField" || role == "AXTextArea" || role == "AXComboBox" {
        // 비밀번호 칸 값은 절대 내보내지 않는다
        if sub != "AXSecureTextField", let v = text(el, kAXValueAttribute) {
          line += " 값: \"\(v.prefix(120).replacingOccurrences(of: "\"", with: "'"))\""
        }
      }
      if role == "AXCheckBox" || sub == "AXSwitch" {
        line += ((attr(el, kAXValueAttribute) as? Int) ?? 0) == 1 ? " 켜짐" : " 꺼짐"
      }
      if (attr(el, kAXEnabledAttribute) as? Bool) == false { line += " (못 누름)" }
      add(line + "]")
      // 행·셀 안의 글자도 읽어야 무엇인지 안다
      if role != "AXRow" && role != "AXCell" { return }
    } else if role == "AXImage", let nm = name {
      add("(그림: \(nm.prefix(60)))")
    } else if ["AXWindow", "AXSheet", "AXGroup", "AXTabGroup", "AXToolbar"].contains(role), let nm = text(el, kAXTitleAttribute) {
      add("## \(nm.prefix(80))")
    }
    for c in kids(el) { walk(c, depth + 1) }
  }
  walk(win, 0)
  return [
    "app": app.localizedName ?? bundleId,
    "bundleId": bundleId,
    "window": text(win, kAXTitleAttribute) ?? "",
    "text": lines.joined(separator: "\n"),
    "truncated": truncated,
  ]
}

func element(_ ref: String, _ bundleId: String) throws -> AXUIElement {
  guard refsApp == bundleId, let el = refs[ref] else {
    throw fail("\(ref)를 찾지 못했어요. 화면을 다시 읽어(screen_read) 주세요")
  }
  return el
}

// ── 입력 ───────────────────────────────────────────────

func postMouseClick(_ p: CGPoint) {
  let src = CGEventSource(stateID: .hidSystemState)
  CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(40_000)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(40_000)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
}

let keyCodes: [String: CGKeyCode] = [
  "Enter": 36, "Return": 36, "Tab": 48, "Space": 49, "Backspace": 51, "Delete": 117, "Escape": 53,
  "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126, "Home": 115, "End": 119,
  "PageUp": 116, "PageDown": 121,
  "a": 0, "c": 8, "v": 9, "x": 7, "z": 6, "f": 3, "n": 45, "w": 13, "s": 1, "k": 40, "l": 37,
]

func postKey(_ key: String, _ mods: [String]) throws {
  guard let code = keyCodes[key] else { throw fail("모르는 키예요: \(key)") }
  var flags: CGEventFlags = []
  for m in mods {
    switch m {
    case "cmd", "command", "meta": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt", "option": flags.insert(.maskAlternate)
    case "ctrl", "control": flags.insert(.maskControl)
    default: throw fail("모르는 보조 키예요: \(m)")
    }
  }
  let src = CGEventSource(stateID: .hidSystemState)
  let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
  let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
  down?.flags = flags
  up?.flags = flags
  down?.post(tap: .cghidEventTap)
  usleep(30_000)
  up?.post(tap: .cghidEventTap)
}

/** 한글은 키 입력으로 치면 입력기가 꼬인다. 클립보드에 넣고 붙여 넣은 뒤 원래 클립보드를 되돌린다 */
func paste(_ s: String) async throws {
  let pb = NSPasteboard.general
  let saved: [[NSPasteboard.PasteboardType: Data]] = (pb.pasteboardItems ?? []).map { item in
    var d: [NSPasteboard.PasteboardType: Data] = [:]
    for t in item.types { if let v = item.data(forType: t) { d[t] = v } }
    return d
  }
  pb.clearContents()
  pb.setString(s, forType: .string)
  try postKey("v", ["cmd"])
  try await Task.sleep(nanoseconds: 350_000_000)
  pb.clearContents()
  let items = saved.map { d -> NSPasteboardItem in
    let it = NSPasteboardItem()
    for (t, v) in d { it.setData(v, forType: t) }
    return it
  }
  if !items.isEmpty { pb.writeObjects(items) }
}

func click(_ args: [String: Any]) async throws -> [String: Any] {
  let bundleId = args["bundleId"] as? String ?? ""
  guard AXIsProcessTrusted() else { throw fail("손쉬운 사용 권한이 필요해요") }
  _ = try await activate(bundleId)
  if let ref = args["ref"] as? String {
    let el = try element(ref, bundleId)
    // 접근성 "누르기"가 되면 그걸로 (마우스를 움직이지 않는다)
    if AXUIElementPerformAction(el, kAXPressAction as CFString) == .success {
      return ["via": "press"]
    }
    guard let f = frame(el), f.width > 0 else { throw fail("\(ref)의 위치를 알 수 없어요") }
    postMouseClick(CGPoint(x: f.midX, y: f.midY))
    return ["via": "mouse"]
  }
  guard let x = args["x"] as? Double, let y = args["y"] as? Double else { throw fail("누를 곳(ref 또는 x·y)이 없어요") }
  postMouseClick(CGPoint(x: x, y: y))
  return ["via": "mouse"]
}

func typeText(_ args: [String: Any]) async throws -> [String: Any] {
  let bundleId = args["bundleId"] as? String ?? ""
  guard AXIsProcessTrusted() else { throw fail("손쉬운 사용 권한이 필요해요") }
  guard let s = args["text"] as? String, !s.isEmpty else { throw fail("넣을 글자가 없어요") }
  _ = try await activate(bundleId)
  if let ref = args["ref"] as? String {
    let el = try element(ref, bundleId)
    if text(el, kAXSubroleAttribute) == "AXSecureTextField" { throw fail("비밀번호 칸에는 넣지 않아요. 사용자에게 넘겨 주세요") }
    AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    try await Task.sleep(nanoseconds: 120_000_000)
  }
  try await paste(String(s.prefix(4000)))
  return ["typed": s.count]
}

func pressKey(_ args: [String: Any]) async throws -> [String: Any] {
  let bundleId = args["bundleId"] as? String ?? ""
  guard AXIsProcessTrusted() else { throw fail("손쉬운 사용 권한이 필요해요") }
  _ = try await activate(bundleId)
  try postKey(args["key"] as? String ?? "", args["modifiers"] as? [String] ?? [])
  return ["pressed": args["key"] as? String ?? ""]
}

// ── 화면 캡처 ───────────────────────────────────────────

func screenshot(_ args: [String: Any]) async throws -> [String: Any] {
  let bundleId = args["bundleId"] as? String ?? ""
  try checkAllowed(bundleId)
  guard CGPreflightScreenCaptureAccess() else { throw fail("화면 기록 권한이 필요해요") }
  guard let app = runningApp(bundleId) else { throw fail("이 앱이 켜져 있지 않아요") }
  let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
  let wins = content.windows.filter {
    $0.owningApplication?.processID == app.processIdentifier && $0.windowLayer == 0 && $0.frame.width > 80
  }
  guard let w = wins.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
    throw fail("이 앱의 창이 화면에 없어요")
  }
  let maxWidth = min(max(args["maxWidth"] as? Double ?? 1280, 320), 1600)
  let scale = min(1, maxWidth / w.frame.width)
  let cfg = SCStreamConfiguration()
  cfg.width = Int(w.frame.width * scale)
  cfg.height = Int(w.frame.height * scale)
  cfg.showsCursor = false
  let img = try await SCScreenshotManager.captureImage(
    contentFilter: SCContentFilter(desktopIndependentWindow: w), configuration: cfg)
  let rep = NSBitmapImageRep(cgImage: img)
  guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.6]) else {
    throw fail("화면을 저장하지 못했어요")
  }
  return [
    "mime": "image/jpeg", "data": jpeg.base64EncodedString(),
    "window": w.title ?? "", "width": cfg.width, "height": cfg.height,
  ]
}

// ── 상태·권한 ───────────────────────────────────────────

func status() -> [String: Any] {
  let session = CGSessionCopyCurrentDictionary() as? [String: Any]
  return [
    "accessibility": AXIsProcessTrusted(),
    "screenRecording": CGPreflightScreenCaptureAccess(),
    "locked": (session?["CGSSessionScreenIsLocked"] as? Bool) ?? false,
    "platform": "mac",
  ]
}

/** 시스템 권한 창을 띄운다 (사용자가 직접 켜야 한다) */
func requestPermissions() -> [String: Any] {
  let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  _ = AXIsProcessTrustedWithOptions(opts)
  if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
  return status()
}

// ── 명령 ───────────────────────────────────────────────

@MainActor
func run(_ cmd: String, _ args: [String: Any]) async throws -> Any {
  switch cmd {
  case "status": return status()
  case "request": return requestPermissions()
  case "apps": return appsList()
  case "installed": return installedApps()
  case "open": return try await openApp(args["bundleId"] as? String ?? "")
  case "snapshot":
    return try await snapshot(args["bundleId"] as? String ?? "", maxChars: args["maxChars"] as? Int ?? 12000)
  case "click": return try await click(args)
  case "type": return try await typeText(args)
  case "key": return try await pressKey(args)
  case "screenshot": return try await screenshot(args)
  default: throw fail("모르는 명령이에요: \(cmd)")
  }
}

func handle(_ line: String) {
  guard let data = line.data(using: .utf8),
    let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let id = obj["id"], let cmd = obj["cmd"] as? String
  else { return }
  let args = obj["args"] as? [String: Any] ?? [:]
  Task { @MainActor in
    do {
      reply(id, ok: true, try await run(cmd, args))
    } catch let e as HandsError {
      reply(id, ok: false, e.message)
    } catch {
      reply(id, ok: false, error.localizedDescription)
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
DispatchQueue.global().async {
  while let line = readLine() { handle(line) }
  // 본체가 끝나면(입력이 닫히면) 같이 끝난다
  exit(0)
}
app.run()
