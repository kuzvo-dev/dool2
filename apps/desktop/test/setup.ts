// Tests check the Korean reference copy: pin the device to Korean, whatever the CI machine's locale and time zone
Object.defineProperty(globalThis.navigator, 'languages', { value: ['ko-KR'], configurable: true })
