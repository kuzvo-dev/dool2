/**
 * DevTools methods browser_cdp may call (ADR 0045, threat model T31): ones that only read or produce from a page
 * Dool2 opened. Nothing that clicks, types, navigates, changes the page, reads cookies or storage, or watches the
 * network. The daemon and the extension each check this list
 */
export const READ_CDP_METHODS = [
  'Page.printToPDF',
  'Page.captureSnapshot',
  'Page.captureScreenshot',
  'Page.getLayoutMetrics',
  'Page.getResourceTree',
  'Page.getResourceContent',
  'Accessibility.getFullAXTree',
  'DOM.getDocument',
  'DOM.getOuterHTML',
] as const
