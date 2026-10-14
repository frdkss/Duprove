import React from 'react'
import { createRoot } from 'react-dom/client'
import { MainWindow } from './window/MainWindow/MainWindow'
import './styles/global.css'
createRoot(document.getElementById('root')!).render(<React.StrictMode><MainWindow /></React.StrictMode>)
