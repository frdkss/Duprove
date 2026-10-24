import type { ConsentChange, ConsentSnapshot } from '../contracts/consent'
import type { AnalysisSnapshot, AnalysisCommand, StartAnalysis } from '../contracts/analysis'
import type { Report } from '../contracts/report'
import type { DeliverySnapshot } from '../contracts/delivery'
import type { UpdateSnapshot } from '../contracts/update'
import type { CatalogRequest, TrashRequest, TrashResult } from '../contracts/catalog'

export interface Drive { path: string; name: string; capacity: number; available: number }
export type WindowAction = 'minimize' | 'maximize' | 'close'
export interface DesktopBridge {
  requestCatalog(request: CatalogRequest): Promise<unknown>
  trashCatalog(request: TrashRequest): Promise<TrashResult>
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
  getReportDelivery(): Promise<DeliverySnapshot>
  onReportDelivery(listener: (snapshot: DeliverySnapshot) => void): () => void
  getUpdate(): Promise<UpdateSnapshot>
  onUpdate(listener: (snapshot: UpdateSnapshot) => void): () => void
  getAutostart(): Promise<{ enabled: boolean; supported: boolean }>
  setAutostart(enabled: boolean): Promise<{ enabled: boolean; supported: boolean }>
}
export const channels = { drives: 'duprove:drives', window: 'duprove:window', help: 'duprove:help',
  catalog: 'duprove:catalog',
  trash: 'duprove:trash',
  consentGet: 'duprove:consent:get', consentSet: 'duprove:consent:set',
  analysisGet: 'duprove:analysis:get', analysisStart: 'duprove:analysis:start', analysisControl: 'duprove:analysis:control',
  analysisEvent: 'duprove:analysis:event', analysisReport: 'duprove:analysis:report',
  deliveryGet: 'duprove:delivery:get', deliveryEvent: 'duprove:delivery:event',
  updateGet: 'duprove:update:get', updateEvent: 'duprove:update:event',
  autostartGet: 'duprove:autostart:get', autostartSet: 'duprove:autostart:set' } as const
