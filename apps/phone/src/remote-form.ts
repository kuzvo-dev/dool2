// Remote screen, "only the fields": redraws just the fields, choices and buttons a person must handle on the PC
// screen as phone inputs. A browser tab and (later) a PC app window both give the same shape (RemoteForm).
// Typed values go into the real fields on the PC all at once when a button is pressed; when the page changes,
// the new fields are fetched again.
import type { RemoteForm, RemoteFormButton, RemoteFormField, RemoteFormValue } from '@dool2/protocol'
import { h } from './dom.js'
import { lang } from './lang.js'
import { remoteFormText } from './locales/remote-form.js'
import { drawCheck, otpBoxes, riseIn, springTo } from './motion.js'

export interface FormPaneOpts {
  fill(values: RemoteFormValue[], press?: string): void
  /** When the page seems to have moved on: hand the rest to Dool2 */
  finish(): void
  /** When there are no fields or they cannot be read: show the screen */
  showScreen(): void
}

export interface FormPane {
  el: HTMLElement
  set(form: RemoteForm | undefined, error?: string): void
  /** Whether there is at least one field */
  usable(): boolean
  /** Whether the "looks finished" notice is showing */
  finishing(): boolean
}

const MAX_CHIPS = 8
const isText = (f: RemoteFormField) => ['text', 'number', 'tel', 'email', 'secret'].includes(f.kind)

export function createFormPane(o: FormPaneOpts): FormPane {
  const t = remoteFormText(lang)
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
      text: f.label || (f.kind === 'secret' ? t.password : t.input),
    })
    // Captcha: a big image and one field
    if (f.captcha) {
      const img = h('img', { class: 'rform-captcha' })
      img.src = `data:image/jpeg;base64,${f.captcha}`
      img.alt = t.captchaAlt
      const inp = textInput(f, 'rform-input big')
      return h(
        'div',
        { class: 'rform-field' },
        h('div', { class: 'rform-label', text: t.captchaLabel }),
        img,
        inp,
      )
    }
    // SMS verification code: six boxes (once filled, the main button is pressed if there is only one)
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
      sel.append(h('option', { text: t.pickOne }))
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
    inp.placeholder = f.kind === 'secret' ? t.secretHint : f.hint || ''
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
    // Consecutive fields with the same label (birth date 6 digits + first digit of the rest, split numbers) go on one line
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
    else parts.push(h('p', { class: 'rform-empty', text: t.noFields }))
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
        text: t.viewPcScreen,
        onclick: () => o.showScreen(),
      }),
    )
    el.replaceChildren(...parts)
    riseIn(list.children, 35)
  }

  // When the page seems to have moved on: ask whether to hand the rest to Dool2
  const moved = (next: RemoteForm) => {
    const p = pressed
    pressed = undefined
    // If the new page still has fields to fill, just continue (the notice is only for when the task looks finished)
    if (!p?.url || !next.url || p.url === next.url || next.fields.length) return false
    const card = h(
      'div',
      { class: 'rform-moved' },
      h('strong', { text: t.movedTitle }),
      h('span', {
        text: next.fields.length ? t.movedMore : t.movedDone,
      }),
      h(
        'div',
        { class: 'rform-moved-btns' },
        h('button', { class: 'btn-ghost', text: t.keepGoing, onclick: () => card.remove() }),
        h('button', { class: 'btn btn-approve', text: t.handOver, onclick: () => o.finish() }),
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
            text: t.viewPcScreen,
            onclick: () => o.showScreen(),
          }),
        )
        return
      }
      if (!next) return
      // Same fields: do not redraw (typed text and the keyboard stay)
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
