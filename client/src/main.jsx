import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { initCursorEffects } from './utils/cursorEffects'

// Start visual feedback listeners (cursor trail, magnetic button alignments, click ripples)
initCursorEffects();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
