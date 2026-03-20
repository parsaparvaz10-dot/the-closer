import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../the-closer-agent.jsx'

// Support embedding into Motayo site via custom mount ID
const mountId = window.__CLOSER_MOUNT_ID__ || 'root'
const mountEl = document.getElementById(mountId)

if (mountEl) {
  createRoot(mountEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
