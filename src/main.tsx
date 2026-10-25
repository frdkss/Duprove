import React from 'react'
import { createRoot } from 'react-dom/client'
import { MainWindow } from './window/MainWindow/MainWindow'
const ComparisonWindow = React.lazy(() => import('./window/ComparisonWindow/ComparisonWindow').then(module => ({ default: module.ComparisonWindow })))
import './styles/global.css'
createRoot(document.getElementById('root')!).render(<React.StrictMode><React.Suspense fallback={<p>Загрузка…</p>}>{location.hash === '#comparison' ? <ComparisonWindow/> : <MainWindow/>}</React.Suspense></React.StrictMode>)
