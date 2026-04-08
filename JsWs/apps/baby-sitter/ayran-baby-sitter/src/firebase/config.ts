// This file is intentionally empty.
// Platform-specific implementations:
//   config.native.ts  — iOS / Android (uses getReactNativePersistence + AsyncStorage)
//   config.web.ts     — Web (uses getAuth, which defaults to localStorage)
// Metro resolves the correct file automatically based on the target platform.
export {};
