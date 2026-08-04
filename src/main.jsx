import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App.jsx'
import { initializeMcpAppBridge } from './mcpAppBridge.js'

const mountPoint = document.querySelector('#root')
if (!(mountPoint instanceof HTMLElement)) throw new Error('Canvas mount point was not found.')

initializeMcpAppBridge()
createRoot(mountPoint).render(<StrictMode><App /></StrictMode>)
