import type { ConsentChange, ConsentSnapshot } from '../contracts/consent'

export interface Drive { path: string; name: string; capacity: number; available: number }
export type WindowAction = 'minimize' | 'maximize' | 'close'
export interface DesktopBridge {
  listDrives(): Promise<Drive[]>
  windowAction(action: WindowAction): Promise<void>
  openHelp(): Promise<void>
  getStatisticsConsent(): Promise<ConsentSnapshot>
  setStatisticsConsent(change: ConsentChange): Promise<ConsentSnapshot>
}
export const channels = { drives: 'duprove:drives', window: 'duprove:window', help: 'duprove:help',
  consentGet: 'duprove:consent:get', consentSet: 'duprove:consent:set' } as const
