// Demo site-skill drafts for the smoke screenshot of the review panel (AGENTS.md §2). They stand in for what
// learn-by-watching would produce, so the offline smoke run (no model, no browser, no recording) still shows the
// panel with real-looking content. Everything here is made-up demo data on generic example hosts — a generic
// government portal and a generic shopping mall — with NO real product or company names (repo rule). The Korean copy
// lives in this `locales/` file so it stays out of code (ADR 0029). When recording is wired live, this demo goes away.

import type { LearnSnapshot, LocalDraft } from '@dool2/agentd'

/** A generic government portal: learned by driving the screen only (no data path yet). */
const GOV_DRAFT: LocalDraft = {
  id: 'gov-portal',
  host: 'portal.example.go.kr',
  updatedAt: 0,
  turns: 1,
  skill: {
    id: 'gov-portal',
    needsReview: true,
    frontmatter: {
      name: '정부민원포털',
      description: '정부민원포털에서 증명서를 떼고 민원을 신청해요.',
      site: ['example.go.kr'],
      autoInject: { url: ['*.example.go.kr'], keywords: ['민원', '증명서'] },
      regions: ['kr'],
    },
    body: [
      '## 화면에서 하는 법',
      '',
      '1. 로그인: 로그인',
      '2. 메뉴 열기: 증명서 발급',
      '3. 신청: 발급 신청',
      '',
    ].join('\n'),
    markdown: '',
  },
}

/** A generic shopping mall: learned a click-free data path (two endpoints) plus the UI fallback. */
const SHOP_DRAFT: LocalDraft = {
  id: 'shop-mall',
  host: 'shop.example.com',
  updatedAt: 0,
  turns: 2,
  skill: {
    id: 'shop-mall',
    needsReview: true,
    frontmatter: {
      name: '온라인 쇼핑몰',
      description: '온라인 쇼핑몰에서 주문 내역을 확인하고 배송을 추적해요.',
      site: ['shop.example.com'],
      autoInject: { url: ['*.shop.example.com'], keywords: ['주문', '배송'] },
    },
    body: [
      '## 바로 통로',
      '',
      '- `GET /api/orders`',
      '- `GET /api/orders/shipping`',
      '',
      '## 화면에서 하는 법',
      '',
      '1. 열기: 마이페이지',
      '2. 메뉴 열기: 주문 내역',
      '3. 고르기: 주문 선택',
      '4. 확인: 배송 조회',
      '',
    ].join('\n'),
    markdown: '',
  },
}

/** The demo snapshot the smoke run serves in place of a live GET /drafts. */
export function demoDraftsSnapshot(): LearnSnapshot {
  return {
    drafts: [GOV_DRAFT, SHOP_DRAFT],
    coverage: { covered: 2, total: 3, clickFreeRatio: 0.5 },
  }
}
