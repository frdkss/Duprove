import type { DesktopBridge } from '../electron/bridge'
declare global { interface Window { duprove?: DesktopBridge } }
