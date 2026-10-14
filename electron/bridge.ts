export interface Drive { path: string; name: string; capacity: number; available: number }
export type WindowAction = 'minimize' | 'maximize' | 'close'
export interface DesktopBridge { listDrives(): Promise<Drive[]>; windowAction(action: WindowAction): Promise<void>; openHelp(): Promise<void> }
export const channels = { drives: 'duprove:drives', window: 'duprove:window', help: 'duprove:help' } as const
