import { describe, expect, it } from 'vitest'
import { uiaEl } from './in-memory-backend.js'
import { buildSnapshot } from './snapshot.js'

// A parseRefs-style ref grammar, the same shape @dool2/page-bridge uses: an optional frame prefix + eN, a role word,
// and an optional quoted name. Like hands-mac, a PC mark may carry trailing annotations inside the bracket (a field
// value, 꺼짐, (못 누름)), so the PC parser reads id + role + name from the mark head rather than requiring the bracket
// to close right after the name. If the helper's marks match this, the daemon can parse either helper's output.
const REF_RE = /\[((?:f\d+)?e\d+)\s+(\S+)(?:\s+"([^"]*)")?/g

function loginWindow() {
  return [
    {
      title: 'Sign in',
      front: true,
      root: uiaEl({
        controlType: 'Window',
        name: 'Sign in',
        rect: { x: 0, y: 0, width: 400, height: 300 },
        children: [
          uiaEl({ controlType: 'Text', value: 'Welcome back' }),
          uiaEl({ controlType: 'Edit', name: '이메일', value: 'a@b.com', handle: 'email' }),
          uiaEl({
            controlType: 'Edit',
            name: '비밀번호',
            isPassword: true,
            value: 'super-secret-value',
            handle: 'pw',
          }),
          uiaEl({ controlType: 'CheckBox', name: '자동 로그인', checked: false, handle: 'keep' }),
          uiaEl({ controlType: 'Button', name: '로그인', handle: 'submit' }),
          uiaEl({ controlType: 'Button', name: '다음', enabled: false, handle: 'next' }),
        ],
      }),
    },
  ]
}

describe('buildSnapshot', () => {
  it('emits [eN role "name"] marks the daemon regex matches', () => {
    const snap = buildSnapshot(loginWindow(), 12000)
    const marks = [...snap.text.matchAll(REF_RE)].map((m) => ({ ref: m[1], role: m[2], name: m[3] }))
    // one mark per actionable element: email, password, checkbox, two buttons
    expect(marks.map((m) => m.ref)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'])
    expect(marks[0]).toMatchObject({ ref: 'e1', role: '입력칸', name: '이메일' })
    expect(marks[1]).toMatchObject({ ref: 'e2', role: '비밀번호칸', name: '비밀번호' })
    expect(marks[3]).toMatchObject({ ref: 'e4', role: '버튼', name: '로그인' })
  })

  it('a mark with no trailing annotation matches the exact @dool2/page-bridge regex too', () => {
    // The page-bridge regex requires the bracket to close right after the (optional) name. A plain button mark — the
    // common case — satisfies it verbatim, so the same adapter reads PC and web marks.
    const pageRe = /\[((?:f\d+)?e\d+)\s+(\S+?)(?:\s+"([^"]*)")?\]/
    expect('[e4 버튼 "로그인"]').toMatch(pageRe)
  })

  it('never emits a password field value, but still refs it so it can be focused', () => {
    const snap = buildSnapshot(loginWindow(), 12000)
    expect(snap.text).not.toContain('super-secret-value')
    // the non-password edit's value IS shown
    expect(snap.text).toContain('a@b.com')
    // the password field still gets a ref, marked as password
    expect(snap.refs.get('e2')).toMatchObject({ handle: 'pw', isPassword: true })
    expect(snap.refs.get('e1')).toMatchObject({ handle: 'email', isPassword: false })
  })

  it('marks a disabled control and a toggle state', () => {
    const snap = buildSnapshot(loginWindow(), 12000)
    expect(snap.text).toContain('[e3 체크박스 "자동 로그인" 꺼짐]')
    expect(snap.text).toMatch(/\[e5 버튼 "다음" \(못 누름\)\]/)
  })

  it('gives a nameless icon button a position hint instead of a name', () => {
    const windows = [
      {
        title: 'App',
        front: true,
        root: uiaEl({
          controlType: 'Window',
          name: 'App',
          rect: { x: 0, y: 0, width: 200, height: 100 },
          children: [uiaEl({ controlType: 'Button', rect: { x: 90, y: 40, width: 20, height: 20 } })],
        }),
      },
    ]
    const snap = buildSnapshot(windows, 12000)
    expect(snap.text).toContain('이름 없음')
    expect(snap.text).toMatch(/창 왼쪽에서 50% 위에서 50%/)
  })

  it('truncates at maxChars and flags it', () => {
    const snap = buildSnapshot(loginWindow(), 20)
    expect(snap.truncated).toBe(true)
  })
})
