import type { PalmierApi } from '../preload/index.js'

declare global {
  interface Window {
    palmier: PalmierApi
  }
}

export {}
