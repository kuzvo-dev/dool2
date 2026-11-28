// Pure mapping from a browser-mirror frame (a data: URL, or null) to what the "watch Dool2's browser" pane shows:
// the <img> source and which of the frame/idle elements is visible. Kept framework-free so it can be unit-tested
// without a DOM; renderer.ts applies the result to the real elements. A frame is page pixels, same as a screenshot.

export interface FrameView {
  /** The <img> src to paint when a frame is present; empty when there is nothing to show. */
  src: string
  /** Whether the frame <img> is visible. */
  showFrame: boolean
  /** Whether the idle placeholder is visible. */
  showIdle: boolean
}

/** A non-empty data: URL paints the frame; null/empty shows the idle placeholder (browser invisible or no tab). */
export function frameView(dataUrl: string | null): FrameView {
  if (dataUrl) return { src: dataUrl, showFrame: true, showIdle: false }
  return { src: '', showFrame: false, showIdle: true }
}
