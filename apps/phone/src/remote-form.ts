// 원격 화면 '필요한 칸만': PC 화면에서 사람이 해야 할 칸·고를 것·버튼만 폰 입력칸으로 다시 그린다.
// 브라우저 탭이든 (나중에) PC 앱 창이든 같은 모양(RemoteForm)을 받는다.
// 쓴 값은 버튼을 누를 때 한꺼번에 PC의 진짜 칸에 넣고, 화면이 넘어가면 새 칸을 다시 받아 온다
import type { RemoteForm, RemoteFormButton, RemoteFormField, RemoteFormValue } from '@dool2/protocol'
import { h } from './dom.js'
import { drawCheck, otpBoxes, riseIn, springTo } from './motion.js'

export interface FormPaneOpts {
  fill(values: RemoteFormValue[], press?: string): void
  /** 화면이 넘어간 것 같을 때: 두리에게 이어서 맡기기 */
  finish(): void
  /** 칸이 없거나 못 읽을 때 화면 보기로 */
  showScreen(): void
}

export interface FormPane {
  el: HTMLElement
  set(form: RemoteForm | undefined, error?: string): void
  /** 칸이 하나라도 있는지 */
  usable(): boolean
  /** '끝난 것 같아요' 알림을 보여 주는 중 */
  finishing(): boolean
}

const MAX_CHIPS = 8
const isText = (f: RemoteFormField) => ['text', 'number', 'tel', 'email', 'secret'].includes(f.kind)

export function createFormPane(o: FormPaneOpts): FormPane {
  const el = h('div', { class: 'rform' })
  let form: RemoteForm | undefined
  let dirty = new Map<string, RemoteFormValue>()
  let pressed: { url?: string; label: string } | undefined
  let sig = ''

  const put = (v: RemoteFormValue) => dirty.set(v.id, v)

  const press = (b?: RemoteFormButton) => {
    const values = [...dirty.values()]
    if (!b && !values.length) return
    pressed = { ...(form?.url ? { url: form.url } : {}), label: b?.label ?? '' }
    el.classList.add('busy')
    o.fill(values, b?.id)
    dirty = new Map()
  }

  const fieldEl = (f: RemoteFormField): HTMLElement => {
    const head = h('div', {
      class: 'rform-label',
      text: f.label || (f.kind === 'secret' ? '비밀번호' : '입력'),
    })
    // 보안문자: 그림을 크게, 칸 하나
    if (f.captcha) {
      const img = h('img', { class: 'rform-captcha' })
      img.src = `data:image/jpeg;base64,${f.captcha}`
      img.alt = '보안문자 그림'
      const inp = textInput(f, 'rform-input big')
      return h(
        'div',
        { class: 'rform-field' },
        h('div', { class: 'rform-label', text: '그림의 글자를 따라 써 주세요' }),
        img,
        inp,
      )
    }
    // 문자 인증번호: 여섯 칸 (다 넣으면 주 버튼이 하나면 바로 누른다)
    if (f.code) {
      const n = f.max && f.max >= 4 && f.max <= 8 ? f.max : 6
      const box = otpBoxes({
        length: n,
        value: f.value ?? '',
        onDone: (code) => {
          put({ id: f.id, value: code })
          const mains = (form?.buttons ?? []).filter((b) => b.main)
          if (mains.length === 1) setTimeout(() => press(mains[0]), 500)
        },
        onInput: (v) => put({ id: f.id, value: v }),
      })
      return h('div', { class: 'rform-field rform-code' }, head, box)
    }
    if (f.kind === 'choice') {
      const opts = f.options ?? []
      if (opts.length <= MAX_CHIPS) {
        const row = h('div', { class: 'rform-chips' })
        for (const op of opts) {
          const c = h('button', {
            class: op.on ? 'chip on' : 'chip',
            text: op.label,
            onclick: () => {
              for (const x of row.children) x.classList.remove('on')
              c.classList.add('on')
              springTo(c, [{ transform: 'scale(0.9)' }, { transform: 'none' }], 'squash')
              put({ id: f.id, pick: op.id })
            },
          })
          row.append(c)
        }
        return h('div', { class: 'rform-field' }, head, row)
      }
      const sel = h('select', { class: 'rform-input' })
      sel.append(h('option', { text: '골라 주세요' }))
      for (const op of opts) {
        const x = h('option', { text: op.label })
        x.value = op.id
        x.selected = Boolean(op.on)
        sel.append(x)
      }
      sel.onchange = () => {
        if (sel.value) put({ id: f.id, pick: sel.value })
      }
      return h('div', { class: 'rform-field' }, head, sel)
    }
    if (f.kind === 'check') {
      const box = h('span', { class: f.checked ? 'rform-box on' : 'rform-box' })
      let on = Boolean(f.checked)
      const row = h(
        'button',
        {
          class: 'rform-check',
          onclick: () => {
            on = !on
            box.classList.toggle('on', on)
            if (on) {
              box.replaceChildren()
              drawCheck(box)
            }
            put({ id: f.id, checked: on })
          },
        },
        box,
        h('span', { text: f.label }),
      )
      return row
    }
    return h('div', { class: 'rform-field' }, head, textInput(f, 'rform-input'))
  }

  const textInput = (f: RemoteFormField, cls: string) => {
    const inp = h('input', { class: cls })
    inp.type = f.kind === 'secret' ? 'password' : f.kind === 'email' ? 'email' : 'text'
    inp.inputMode =
      f.kind === 'number' ? 'numeric' : f.kind === 'tel' ? 'tel' : f.kind === 'email' ? 'email' : 'text'
    inp.autocomplete = f.kind === 'secret' ? 'current-password' : 'off'
    inp.setAttribute('autocapitalize', 'off')
    inp.spellcheck = false
    if (f.max) inp.maxLength = f.max
    inp.placeholder = f.kind === 'secret' ? 'PC 칸에만 들어가요' : f.hint || ''
    if (f.value) inp.value = f.value
    inp.oninput = () => put({ id: f.id, value: inp.value })
    inp.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        press((form?.buttons ?? []).find((b) => b.main))
      }
    }
    return inp
  }

  const render = () => {
    const f = form
    el.classList.remove('busy')
    if (!f) return
    const fields = f.fields
    const main = f.buttons.find((b) => b.main) ?? f.buttons[0]
    const others = f.buttons.filter((b) => b !== main)
    // 이름이 같은 칸이 이어지면(생년월일 앞 6자리 + 뒷자리 첫 숫자, 번호 나눠 쓰기) 한 줄로
    const rows: HTMLElement[] = []
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i] as RemoteFormField
      const run = [f]
      while (
        i + 1 < fields.length &&
        fields[i + 1]?.label === f.label &&
        isText(fields[i + 1] as RemoteFormField) &&
        isText(f) &&
        !f.code &&
        !f.captcha
      )
        run.push(fields[++i] as RemoteFormField)
      if (run.length === 1) rows.push(fieldEl(f))
      else {
        const line = h('div', { class: 'rform-line' })
        run.forEach((x, k) => {
          if (k) line.append(h('span', { class: 'rform-dash', text: '–' }))
          const inp = textInput(x, 'rform-input')
          if (x.max && x.max <= 2) {
            inp.classList.add('tiny')
            line.append(
              h('span', { class: 'rform-tiny' }, inp, h('span', { class: 'rform-dots', text: '●●●●●●' })),
            )
          } else line.append(inp)
        })
        rows.push(h('div', { class: 'rform-field' }, h('div', { class: 'rform-label', text: f.label }), line))
      }
    }
    const list = h('div', { class: 'rform-card' }, ...rows)
    const parts: HTMLElement[] = []
    if (f.title) parts.push(h('div', { class: 'rform-title', text: f.title }))
    if (fields.length) parts.push(list)
    else parts.push(h('p', { class: 'rform-empty', text: '이 화면에는 채울 칸이 없어요' }))
    if (others.length)
      parts.push(
        h(
          'div',
          { class: 'rform-chips rform-more' },
          ...others.map((b) => h('button', { class: 'chip', text: b.label, onclick: () => press(b) })),
        ),
      )
    if (main)
      parts.push(h('button', { class: 'btn rform-main', text: main.label, onclick: () => press(main) }))
    parts.push(
      h('button', {
        class: 'btn-text rform-screen',
        text: 'PC 화면 그대로 보기',
        onclick: () => o.showScreen(),
      }),
    )
    el.replaceChildren(...parts)
    riseIn(list.children, 35)
  }

  // 화면이 넘어간 것 같을 때: 두리에게 이어서 맡길지 묻는다
  const moved = (next: RemoteForm) => {
    const p = pressed
    pressed = undefined
    // 넘어간 화면에 아직 채울 칸이 있으면 그대로 이어서 (알림은 할 일이 끝나 보일 때만)
    if (!p?.url || !next.url || p.url === next.url || next.fields.length) return false
    const card = h(
      'div',
      { class: 'rform-moved' },
      h('strong', { text: '다음 화면으로 넘어갔어요' }),
      h('span', {
        text: next.fields.length
          ? '이어서 채울 칸이 있어요. 계속하거나 두리에게 맡겨 주세요'
          : '할 일이 끝난 것 같아요',
      }),
      h(
        'div',
        { class: 'rform-moved-btns' },
        h('button', { class: 'btn-ghost', text: '계속 할게요', onclick: () => card.remove() }),
        h('button', { class: 'btn btn-approve', text: '두리에게 이어서 맡기기', onclick: () => o.finish() }),
      ),
    )
    el.prepend(card)
    springTo(
      card,
      [
        { opacity: 0, transform: 'translateY(-10px)' },
        { opacity: 1, transform: 'none' },
      ],
      'fade',
    )
    return true
  }

  return {
    el,
    usable: () => Boolean(form?.fields.length),
    finishing: () => Boolean(el.querySelector('.rform-moved')),
    set(next, error) {
      if (error) {
        el.classList.remove('busy')
        el.replaceChildren(
          h('p', { class: 'rform-empty', text: error }),
          h('button', {
            class: 'btn-text rform-screen',
            text: 'PC 화면 그대로 보기',
            onclick: () => o.showScreen(),
          }),
        )
        return
      }
      if (!next) return
      // 같은 칸이면 다시 그리지 않는다 (쓰던 글자·키보드가 그대로)
      const nsig = JSON.stringify([
        next.url,
        next.fields.map((f) => [f.id, f.kind, f.label, f.options?.length, Boolean(f.captcha)]),
        next.buttons.map((b) => b.label),
      ])
      const wasPressed = Boolean(pressed)
      form = next
      if (nsig === sig && !wasPressed) return
      sig = nsig
      render()
      if (wasPressed) moved(next)
    },
  }
}
