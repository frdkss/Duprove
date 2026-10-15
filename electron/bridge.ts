import type { ConsentChange, ConsentSnapshot } from '../contracts/consent'
import type { AnalysisSnapshot, AnalysisCommand, StartAnalysis } from '../contracts/analysis'
import type { Report } from '../contracts/report'

export interface Drive { path: string; name: string; capacity: number; available: number }
export type WindowAction = 'minimize' | 'maximize' | 'close'
export interface DesktopBridge {
  listDrives(): Promise<Drive[]>
  windowAction(action: WindowAction): Promise<void>
  openHelp(): Promise<void>
  getStatisticsConsent(): Promise<ConsentSnapshot>
  setStatisticsConsent(change: ConsentChange): Promise<ConsentSnapshot>
  getAnalysis(): Promise<AnalysisSnapshot>
  startAnalysis(request: StartAnalysis): Promise<AnalysisSnapshot>
  controlAnalysis(command: AnalysisCommand): Promise<AnalysisSnapshot>
  onAnalysis(listener: (snapshot: AnalysisSnapshot) => void): () => void
  getAnalysisReport(): Promise<Report | null>
  getAutostart(): Promise<{ enabled: boolean; supported: boolean }>
  setAutostart(enabled: boolean): Promise<{ enabled: boolean; supported: boolean }>
}
export const channels = { drives: 'duprove:drives', window: 'duprove:window', help: 'duprove:help',
  consentGet: 'duprove:consent:get', consentSet: 'duprove:consent:set',
  analysisGet: 'duprove:analysis:get', analysisStart: 'duprove:analysis:start', analysisControl: 'duprove:analysis:control',
  analysisEvent: 'duprove:analysis:event', analysisReport: 'duprove:analysis:report',
  autostartGet: 'duprove:autostart:get', autostartSet: 'duprove:autostart:set' } as const
