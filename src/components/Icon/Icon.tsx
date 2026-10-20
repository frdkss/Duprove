import type { ReactNode } from 'react'
import './Icon.css'
export type IconName = 'drive' | 'settings' | 'help' | 'chevron' | 'arrow' | 'external' | 'leaf' | 'medium' | 'high' | 'fileSearch' | 'globe' | 'sun' | 'power' | 'search' | 'folder' | 'file' | 'sliders' | 'database' | 'trash' | 'clock' | 'info' | 'refresh' | 'close' | 'minus' | 'maximize'
const paths: Record<IconName, ReactNode> = {
  drive: <><path d="m5 4-3 11v5h20v-5L19 4H5Z"/><path d="M2 15h20M17.5 18h.01"/></>,
  settings: <><path d="m9 3-.7 2.5-2 .9-2.3-.7-2 3.5 1.8 1.8v2L2 15l2 3.5 2.3-.7 2 .9L9 21h4l.7-2.3 2-.9 2.3.7 2-3.5-1.8-2v-2L20 9.2l-2-3.5-2.3.7-2-.9L13 3H9Z"/><circle cx="11" cy="12" r="3"/></>,
  help: <><circle cx="12" cy="12" r="9"/><path d="M9.5 8.5a2.6 2.6 0 0 1 5 .8c0 2-2.5 2-2.5 4M12 17h.01"/></>,
  chevron: <path d="m9 6 6 6-6 6"/>, arrow: <path d="M4 12h16m-7-7 7 7-7 7"/>,
  external: <path d="M14 3h7v7m0-7L10 14M10 4H4v16h16v-6"/>,
  leaf: <><path d="M21 3C10 2 3 7 3 15c0 4 3 6 6 6 8 0 12-8 12-18Z"/><path d="M3 21 15 9"/></>,
  medium: <path d="M3 18h3v3H3zM10 12h3v9h-3zM17 5h3v16h-3z"/>,
  high: <path d="M2 17h3v4H2zM8 12h3v9H8zM14 7h3v14h-3zM20 2h3v19h-3z"/>,
  fileSearch: <><path d="M13 3H4v18h9M13 3l5 5h-5V3Z"/><circle cx="16" cy="15" r="4"/><path d="m19 18 3 3M7 8h3M7 12h2"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v1m0 18v1M2 12h1m18 0h1M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/></>,
  power: <path d="M12 2v10M6 5a9 9 0 1 0 12 0"/>,
  search: <><circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 6 6"/></>,
  folder: <path d="M3 6V4h6l3 3h9v13H3V6h7"/>,
  file: <path d="M4 2h10l6 6v14H4V2Zm10 0v6h6M8 13h8M8 17h5"/>,
  sliders: <path d="M3 5h12m4 0h2M3 12h3m4 0h11M3 19h10m4 0h4M15 2v6M6 9v6M13 16v6"/>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/></>,
  trash: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/></>,
  refresh: <path d="M21 9a9 9 0 0 0-15-5L3 7m0-5v5h5M3 15a9 9 0 0 0 15 5l3-3m0 5v-5h-5"/>,
  close: <path d="m5 5 14 14M19 5 5 19"/>, minus: <path d="M5 12h14"/>,
  maximize: <rect x="5" y="5" width="14" height="14" rx="1.5"/>,
}
export function Icon({ name, size = 22, className = '' }: { name: IconName; size?: number; className?: string }) {
  return <svg className={`icon ${className}`} style={{ width: `${size / 16}rem`, height: `${size / 16}rem` }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
