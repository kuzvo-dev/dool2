// dool2-hands (macOS): Dool2 PC screen control helper (docs/architecture.md 5.2, ADR 0013)
//
// Started by the Dool2 daemon; exchanges one-line JSON over stdin/stdout.
//   → {"id":1,"cmd":"snapshot","args":{"bundleId":"com.tinyspeck.slackmacgap"}}
//   ← {"id":1,"ok":true,"result":{...}}  or  {"id":1,"ok":false,"error":"..."}
//
// It makes no decisions. The daemon decides which apps may be controlled and which buttons are risky.
// But browsers, password managers and Dool2 itself are blocked here too (so a daemon mistake cannot cross that line).
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

// ── Blocked apps ─────────────────────────────────────────────

/** Apps never controlled regardless of daemon settings (browsers only via browser tools, password managers, Dool2 itself) */
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

// ── Apps ─────────────────────────────────────────────────

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

/** Installed apps (to look up bundle ids by name). /Applications, /System/Applications, ~/Applications */
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
      var row: [String: Any] = ["bundleId": id, "name": fm.displayName(atPath: path).replacingOccurrences(of: ".app", with: "")]
      // While downloading from the App Store, an empty app with only the icon and info appears first (no executable). Do not report it as installed
      if !hasExecutable(b) { row["installing"] = true }
      out.append(row)
    }
  }
  return out
}

/** An app is fully installed only once it has an executable (an App Store app still installing has only Info.plist and the icon) */
func hasExecutable(_ b: Bundle) -> Bool {
  guard let exe = b.executableURL else { return false }
  return FileManager.default.isExecutableFile(atPath: exe.path)
}

func openApp(_ bundleId: String) async throws -> [String: Any] {
  try checkAllowed(bundleId)
  guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
    throw fail("이 앱이 설치돼 있지 않아요: \(bundleId)")
  }
  if let b = Bundle(url: url), !hasExecutable(b) {
    throw fail("아직 설치 중이에요(앱스토어에서 받는 중): \(bundleId). 받기가 끝난 뒤 다시 여세요")
  }
  let cfg = NSWorkspace.OpenConfiguration()
  cfg.activates = true
  _ = try await NSWorkspace.shared.openApplication(at: url, configuration: cfg)
  // Wait briefly for a window to appear (up to 8 seconds)
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

// ── Accessibility tree ─────────────────────────────────────────

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

/** Same Korean role words as the browser tools, e.g. [e12 <button> "<Send>"] (read by the daemon and the AI) */
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
  let winFrame = frame(win)
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
      else if let f = frame(el), let wf = winFrame, wf.width > 0, wf.height > 0, f.width > 0 {
        // Icon buttons without text (e.g. the chat type buttons in KakaoTalk new chat): give the position in the window so it can be matched with the screenshot
        let x = Int(((f.midX - wf.minX) / wf.width * 100).rounded())
        let y = Int(((f.midY - wf.minY) / wf.height * 100).rounded())
        line += " 이름 없음 · 창 왼쪽에서 \(x)% 위에서 \(y)%"
      }
      if role == "AXTextField" || role == "AXTextArea" || role == "AXComboBox" {
        // Never output the value of a password field
        if sub != "AXSecureTextField", let v = text(el, kAXValueAttribute) {
          line += " 값: \"\(v.prefix(120).replacingOccurrences(of: "\"", with: "'"))\""
        }
      }
      if role == "AXCheckBox" || sub == "AXSwitch" {
        line += ((attr(el, kAXValueAttribute) as? Int) ?? 0) == 1 ? " 켜짐" : " 꺼짐"
      }
      if (attr(el, kAXEnabledAttribute) as? Bool) == false { line += " (못 누름)" }
      add(line + "]")
      // Read the text inside rows and cells too, to know what they are
      if role != "AXRow" && role != "AXCell" { return }
    } else if role == "AXImage", let nm = name {
      add("(그림: \(nm.prefix(60)))")
    } else if ["AXWindow", "AXSheet", "AXGroup", "AXTabGroup", "AXToolbar"].contains(role), let nm = text(el, kAXTitleAttribute) {
      add("## \(nm.prefix(80))")
    }
    for c in kids(el) { walk(c, depth + 1) }
  }
  walk(win, 0)
  // Also read popups (popovers such as the + menu), other windows and open menus: reading only the front window made their items unclickable (11-23 KakaoTalk new chat menu)
  let appEl = AXUIElementCreateApplication(app.processIdentifier)
  for w in (attr(appEl, kAXWindowsAttribute) as? [AXUIElement]) ?? [] where !CFEqual(w, win) {
    if truncated { break }
    add("## (다른 창) \(text(w, kAXTitleAttribute) ?? "")")
    walk(w, 0)
  }
  for c in kids(appEl) where text(c, kAXRoleAttribute) == "AXMenu" {
    if truncated { break }
    add("## (열린 메뉴)")
    walk(c, 0)
  }
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

// ── Input ───────────────────────────────────────────────

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

/** Typing Korean as key presses confuses the input method. Put it on the clipboard, paste, then restore the original clipboard */
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
    // Use the accessibility "press" action when available (does not move the mouse)
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

/** Types text as key presses (no clipboard: a password must never stay on the clipboard) */
func typeUnicode(_ s: String) {
  let src = CGEventSource(stateID: .hidSystemState)
  for ch in s.utf16 {
    var c = ch
    let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
    let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
    down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
    up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
    down?.post(tap: .cghidEventTap)
    usleep(8_000)
    up?.post(tap: .cghidEventTap)
    usleep(8_000)
  }
}

/** Clicks the field, clears it and types */
func focusAndClear(_ el: AXUIElement) async throws {
  AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  if let f = frame(el), f.width > 0 { postMouseClick(CGPoint(x: f.midX, y: f.midY)) }
  try await Task.sleep(nanoseconds: 150_000_000)
  try postKey("a", ["cmd"])
  try postKey("Backspace", [])
  try await Task.sleep(nanoseconds: 80_000_000)
}

/**
 * Fill login fields: puts the ID and password the daemon took from the vault into the login fields of the current
 * window (the values never pass through the AI). The password goes only into a password field (AXSecureTextField),
 * the ID into the text field above it. Does not click the login button (Dool2 reads the screen and clicks it)
 */
func fillLogin(_ args: [String: Any]) async throws -> [String: Any] {
  let bundleId = args["bundleId"] as? String ?? ""
  guard AXIsProcessTrusted() else { throw fail("손쉬운 사용 권한이 필요해요") }
  let user = args["username"] as? String ?? ""
  guard let password = args["password"] as? String, !password.isEmpty else { throw fail("넣을 비밀번호가 없어요") }
  let app = try await activate(bundleId)
  guard let win = focusedWindow(app.processIdentifier) else { throw fail("이 앱에 열린 창이 없어요") }
  var fields: [AXUIElement] = []
  var secure: AXUIElement?
  var nodes = 0
  func walk(_ el: AXUIElement, _ depth: Int) {
    if nodes > 2500 || depth > 40 { return }
    nodes += 1
    let role = text(el, kAXRoleAttribute) ?? ""
    let sub = text(el, kAXSubroleAttribute)
    if (attr(el, kAXEnabledAttribute) as? Bool) != false {
      if sub == "AXSecureTextField" {
        if secure == nil { secure = el }
        return
      }
      if (role == "AXTextField" || role == "AXComboBox") && sub != "AXSearchField" { fields.append(el) }
    }
    for c in kids(el) { walk(c, depth + 1) }
  }
  walk(win, 0)
  guard let pw = secure else { throw fail("이 창에 비밀번호 칸이 보이지 않아요. 로그인 화면인지 screen_read로 확인해 주세요") }
  let pwY = frame(pw)?.minY ?? .greatestFiniteMagnitude
  let userField = fields.last(where: { (frame($0)?.minY ?? 0) < pwY }) ?? fields.first
  var filledUser = false
  if !user.isEmpty, let uf = userField {
    try await focusAndClear(uf)
    // Paste the ID (email or phone number) so the Korean input method does not catch it (not a password, so the clipboard is fine)
    try await paste(user)
    try await Task.sleep(nanoseconds: 150_000_000)
    filledUser = true
  }
  try await focusAndClear(pw)
  typeUnicode(password)
  return ["username": filledUser, "password": true]
}

/** Where typed text goes now (tells whether Enter sends in a messenger: in a search field or list it does not) */
func focusedInfo(_ args: [String: Any]) async throws -> [String: Any] {
  let bundleId = args["bundleId"] as? String ?? ""
  try checkAllowed(bundleId)
  guard AXIsProcessTrusted() else { throw fail("손쉬운 사용 권한이 필요해요") }
  guard let app = runningApp(bundleId) else { throw fail("이 앱이 켜져 있지 않아요") }
  let appEl = AXUIElementCreateApplication(app.processIdentifier)
  guard let f = attr(appEl, kAXFocusedUIElementAttribute) else { return ["role": ""] }
  let el = f as! AXUIElement
  return ["role": text(el, kAXRoleAttribute) ?? "", "subrole": text(el, kAXSubroleAttribute) ?? ""]
}

func pressKey(_ args: [String: Any]) async throws -> [String: Any] {
  let bundleId = args["bundleId"] as? String ?? ""
  guard AXIsProcessTrusted() else { throw fail("손쉬운 사용 권한이 필요해요") }
  _ = try await activate(bundleId)
  try postKey(args["key"] as? String ?? "", args["modifiers"] as? [String] ?? [])
  return ["pressed": args["key"] as? String ?? ""]
}

// ── Screen capture ───────────────────────────────────────────

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

// ── Status and permissions ───────────────────────────────────────────

func status() -> [String: Any] {
  let session = CGSessionCopyCurrentDictionary() as? [String: Any]
  return [
    "accessibility": AXIsProcessTrusted(),
    "screenRecording": CGPreflightScreenCaptureAccess(),
    "locked": (session?["CGSSessionScreenIsLocked"] as? Bool) ?? false,
    "platform": "mac",
  ]
}

/** Opens the system permission prompt (the user has to turn it on) */
func requestPermissions() -> [String: Any] {
  let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  _ = AXIsProcessTrustedWithOptions(opts)
  if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
  return status()
}

// ── Commands ───────────────────────────────────────────────

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
  case "fill_login": return try await fillLogin(args)
  case "focused": return try await focusedInfo(args)
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
  // Exit when the daemon exits (stdin closes)
  exit(0)
}
app.run()
