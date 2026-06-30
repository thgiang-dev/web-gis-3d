import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import esriConfig from '@arcgis/core/config' // 1. Nhập cấu hình Esri
import './index.css'
import App from './app/App'

// 2. Thiết lập API Key từ biến môi trường của Vite
const apiKey = import.meta.env.VITE_ARCGIS_API_KEY || ''
esriConfig.apiKey = apiKey

if (import.meta.env.DEV) {
  console.log(
    "ArcGIS API Key Status:",
    apiKey 
      ? `Loaded (Prefix: ${apiKey.substring(0, 8)}..., Length: ${apiKey.length})` 
      : "Not Loaded (Empty)"
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
