// PC 화면 제어 도구 (M4, docs/architecture.md 5.2). 카카오톡 PC·메모 같은 앱을 접근성 트리로 읽고 누른다.
// 이 서버는 판단하지 않는다: 두리 본체(/api/tools/screen)에 넘기고, 허용한 앱·위험한 버튼은 본체가 막는다.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { BrowserClient } from './browser.js'

const bundleId = z
  .string()
  .regex(/^[\w.-]+$/)
  .max(200)
  .describe('앱의 번들 id (screen_apps가 알려 준 것, 예: com.kakao.KakaoTalkMac)')
const ref = z
  .string()
  .regex(/^e\d+$/)
  .describe('화면을 읽었을 때 나온 표시 (예: e12)')

export function registerScreenTools(server: McpServer, client: BrowserClient) {
  const tool = (
    name: string,
    title: string,
    description: string,
    // biome-ignore lint/suspicious/noExplicitAny: MCP SDK의 zod 입력 형식
    inputSchema: Record<string, any>,
    readOnly: boolean,
  ) =>
    server.registerTool(
      `screen_${name}`,
      { title, description, inputSchema, annotations: { readOnlyHint: readOnly, openWorldHint: false } },
      async (args: Record<string, unknown>) => {
        const r = await client(name, args)
        return { content: r.content, ...(r.isError ? { isError: true } : {}) }
      },
    )

  tool(
    'status',
    'PC 화면 제어 상태',
    'PC 앱 조작(카카오톡 PC 등)을 쓸 수 있는지: 권한, 화면 잠김, 허용한 앱. 웹사이트 일은 화면 제어가 아니라 browser_* 도구로 한다.',
    {},
    true,
  )
  tool(
    'apps',
    '앱 목록',
    '켜져 있는 앱과 번들 id를 본다. query를 주면 설치된 앱 중 이름이 맞는 것도 찾는다.',
    { query: z.string().max(60).optional().describe('찾을 앱 이름 (예: 카카오톡, KakaoTalk)') },
    true,
  )
  tool('open', '앱 열기', '허용한 앱을 열고 앞으로 가져온 뒤 화면을 읽어 준다.', { bundleId }, false)
  tool(
    'read',
    '앱 화면 읽기',
    '앱 창의 접근성 정보를 글로 읽는다. 누를 수 있는 것에는 [e12 버튼 "보내기"] 같은 표시가 붙는다. 비밀번호 칸 값은 나오지 않는다.',
    { bundleId, maxChars: z.number().int().min(1000).max(40000).optional() },
    true,
  )
  tool(
    'click',
    '앱에서 누르기',
    '읽은 화면의 요소를 누른다. 보내기·결제·삭제 같은 버튼은 승인 없이 누르지 않는다(그때는 screen_request_approval).',
    { bundleId, ref },
    false,
  )
  tool(
    'type',
    '앱에 글자 넣기',
    '글자를 넣는다(한글도 됨). ref를 주면 그 칸에 초점을 준 뒤 넣는다. 넣기만 하고 보내지는 않는다.',
    { bundleId, ref: ref.optional(), text: z.string().min(1).max(4000) },
    false,
  )
  tool(
    'key',
    '앱에서 키 누르기',
    'Tab, Escape, 화살표, Backspace 같은 키를 누른다. modifiers로 cmd·shift·option·ctrl. 메신저에서 Enter는 보내기라서 승인을 받는다.',
    {
      bundleId,
      key: z
        .enum([
          'Enter',
          'Tab',
          'Space',
          'Backspace',
          'Delete',
          'Escape',
          'ArrowLeft',
          'ArrowRight',
          'ArrowUp',
          'ArrowDown',
          'Home',
          'End',
          'PageUp',
          'PageDown',
          'a',
          'c',
          'f',
          'k',
          'l',
          'n',
        ])
        .describe('누를 키'),
      modifiers: z
        .array(z.enum(['cmd', 'shift', 'option', 'ctrl']))
        .max(3)
        .optional(),
    },
    false,
  )
  tool(
    'screenshot',
    '앱 화면 보기',
    '앱 창을 이미지로 본다. 접근성 정보로 읽히지 않는 화면에만 쓴다.',
    { bundleId },
    true,
  )
  tool(
    'request_app',
    '앱 조작 허용 요청',
    '사용자가 아직 허용하지 않은 앱을 다뤄야 할 때 쓴다. 사용자가 PC나 폰에서 허용하면 다음 메시지로 알려 준다. 쓴 뒤에는 이번 답을 끝낸다.',
    { bundleId, why: z.string().max(200).describe('이 앱으로 하려는 일 (사용자에게 보인다)') },
    false,
  )
  tool(
    'request_approval',
    '앱 승인 요청',
    '보내기·결제·삭제처럼 승인이 필요한 버튼(또는 메신저의 Enter, ref "key:Enter")일 때 쓴다. 사용자가 화면 캡처와 내용을 보고 승인하면 두리가 그것 하나만 한다. 쓴 뒤에는 이번 답을 끝낸다.',
    {
      bundleId,
      ref: z
        .string()
        .regex(/^(?:e\d+|key:Enter)$/)
        .describe('누를 요소 표시, 메신저 보내기면 "key:Enter"'),
      what: z.string().max(200).describe('무엇을 하는지 한 문장 (예: "엄마에게 \'7시에 도착해\' 보내기")'),
      amount: z.string().max(60).optional().describe('돈이 드는 일이면 금액'),
    },
    false,
  )
}
