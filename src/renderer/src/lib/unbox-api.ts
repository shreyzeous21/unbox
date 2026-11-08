/** Typed accessor for the contextBridge API. */
import type { UnboxApi } from '@shared/ipc-contracts'

declare global {
  interface Window {
    unbox: UnboxApi
  }
}

export const unbox: UnboxApi = window.unbox
