// Social sign-in provider logos (simplified from each provider's guidelines), shown on the left of the button
import type { SocialProvider } from '@dool2/protocol/connect'
import { lang } from './lang.js'
import { socialCta } from './locales/brands.js'

const SVG: Record<SocialProvider, string> = {
  kakao:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#191919" d="M12 3.6c-5 0-9 3.1-9 7 0 2.5 1.7 4.7 4.2 6l-1 3.6c-.1.3.3.6.6.4l4.3-2.8c.3 0 .6.1.9.1 5 0 9-3.1 9-7s-4-7.3-9-7.3Z"/></svg>',
  naver:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M15.6 12.8 8.2 2.5H3v19h5.4V11.2l7.4 10.3H21v-19h-5.4z"/></svg>',
  google:
    '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.8-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>',
  apple:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.7-1-2.7-4.1ZM13.8 4.9c.7-.9 1.2-2 1-3.2-1 0-2.2.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.2.1 2.3-.6 3.1-1.5Z"/></svg>',
  facebook:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M13.5 22v-8.2h2.8l.4-3.2h-3.2V8.5c0-.9.3-1.6 1.6-1.6h1.7V4.1c-.3 0-1.3-.1-2.5-.1-2.5 0-4.2 1.5-4.2 4.3v2.4H7.3v3.2h2.8V22h3.4Z"/></svg>',
  payco:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><text x="12" y="16" text-anchor="middle" font-size="11" font-weight="800" fill="#fff" font-family="Arial, sans-serif">P</text></svg>',
  toss: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="#fff"/><circle cx="12" cy="12" r="4.2" fill="#0064ff"/></svg>',
}

/** Button text: "Continue with Kakao" */
export const SOCIAL_CTA: Record<SocialProvider, string> = socialCta(lang)

export function brandMark(p: SocialProvider): HTMLElement {
  const span = document.createElement('span')
  span.className = 'brand-mark'
  span.innerHTML = SVG[p]
  return span
}
