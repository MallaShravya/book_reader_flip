import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { initServiceWorker } from './lib/sw'
import './styles.css'

initServiceWorker()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
