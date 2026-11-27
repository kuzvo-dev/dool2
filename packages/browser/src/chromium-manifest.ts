// The Chromium build Dool2 downloads for its own browser (ADR 0046). Pinned: a Dool2 release moves it forward.
//
// Source: the open-source Chromium snapshot builds (BSD-3-Clause plus the third-party licenses listed in the build's
// chrome://credits), not Chrome for Testing, whose files are Google Chrome under Google's Terms of Service.
// One trunk position for every platform, so all PCs run the same engine.
//
// To move it forward: pick a position that has a build on every platform
// (https://commondatastorage.googleapis.com/chromium-browser-snapshots/index.html), download each zip once, and write
// its size and `shasum -a 256` here. Dool2 refuses a file whose size or SHA-256 differs.

export const CHROMIUM_MANIFEST = {
  /** Chromium version of the pinned build (chrome://version) */
  version: '160.0.8188.0',
  /** Chromium trunk position the snapshots were built from */
  revision: 1756186,
  builds: {
    'mac-arm64': {
      url: 'https://commondatastorage.googleapis.com/chromium-browser-snapshots/Mac_Arm/1756186/chrome-mac.zip',
      size: 185671546,
      sha256: '17c19a68e82225a7dfb582e61ffde743928e64d52de61172ebce3be2bdecce19',
      executable: 'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    },
    'mac-x64': {
      url: 'https://commondatastorage.googleapis.com/chromium-browser-snapshots/Mac/1756186/chrome-mac.zip',
      size: 205460335,
      sha256: '115612af88219e4b1aac90cc8217e5d9c970e85a453420a7180180d9eee96f06',
      executable: 'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    },
    win64: {
      url: 'https://commondatastorage.googleapis.com/chromium-browser-snapshots/Win_x64/1756186/chrome-win.zip',
      size: 383935976,
      sha256: '3b3d7c0bfaf3828fe5851ccf1789a400d550574340ec2829dabd93e8c8db6801',
      executable: 'chrome-win/chrome.exe',
    },
    linux64: {
      url: 'https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/1756186/chrome-linux.zip',
      size: 263279544,
      sha256: '30c09d8da0928a5183d679987a109f507a044fd60dcb35922d3b01da0239f4d0',
      executable: 'chrome-linux/chrome',
    },
  },
}
