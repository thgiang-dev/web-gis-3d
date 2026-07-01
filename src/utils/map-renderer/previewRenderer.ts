import Graphic from '@arcgis/core/Graphic'
import Point from '@arcgis/core/geometry/Point'
import Polyline from '@arcgis/core/geometry/Polyline'
import Polygon from '@arcgis/core/geometry/Polygon'
import type GraphicsLayer from '@arcgis/core/layers/GraphicsLayer'
import type { ArcgisMapContexts } from '../../features/map/hooks/useArcgisScene'
import { createModelSymbol3D, createPinSymbol3D } from './symbolFactory'

export type DraftEntityPreview = {
  geometryType: 'Point' | 'LineString' | 'Polygon'
  coordinatesText: string
  pinColor: string
  modelUrl: string
  modelSize: number
  modelHeading: number
}

function hexToRgb(hex: string): [number, number, number] {
  const cleanHex = hex.replace('#', '')
  const r = parseInt(cleanHex.substring(0, 2), 16)
  const g = parseInt(cleanHex.substring(2, 4), 16)
  const b = parseInt(cleanHex.substring(4, 6), 16)
  return [Number.isNaN(r) ? 198 : r, Number.isNaN(g) ? 40 : g, Number.isNaN(b) ? 40 : b]
}

export function updateMapPreview(contexts: ArcgisMapContexts | null, draft: DraftEntityPreview | null): void {
  if (!contexts) {
    return
  }

  const view = contexts.entity.view
  const previewLayer = view.map?.findLayerById('app-preview-graphics') as GraphicsLayer | undefined
  if (!previewLayer) {
    return
  }

  previewLayer.removeAll()

  if (!draft) {
    return
  }

  let coords: any = null
  try {
    coords = JSON.parse(draft.coordinatesText)
  } catch {
    // Invalid JSON coords, do not show preview
    return
  }

  if (draft.geometryType === 'Point') {
    if (!Array.isArray(coords) || coords.length < 2) {
      return
    }
    const longitude = Number(coords[0])
    const latitude = Number(coords[1])
    const elevation = Number(coords[2] ?? 0)

    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      return
    }

    const geometry = new Point({
      longitude,
      latitude,
      z: elevation,
      spatialReference: { wkid: 4326 },
    })

    const graphics: Graphic[] = []

    // 1. Render Pin (Always render a pin so they see the exact point)
    const pinSymbol = createPinSymbol3D({
      pinColor: draft.pinColor,
      pinIcon: draft.modelUrl ? 'custom' : 'circle',
    } as any)
    if (pinSymbol) {
      graphics.push(
        new Graphic({
          geometry,
          symbol: pinSymbol,
        })
      )
    }

    // 2. Render 3D Model if URL is present
    if (draft.modelUrl) {
      const modelSymbol = createModelSymbol3D({
        enabled: true,
        modelUrl: draft.modelUrl,
        scale: { x: draft.modelSize, y: draft.modelSize, z: draft.modelSize },
        rotation: { x: 0, y: 0, z: draft.modelHeading },
      })
      if (modelSymbol) {
        graphics.push(
          new Graphic({
            geometry,
            symbol: modelSymbol,
          })
        )
      }
    }

    previewLayer.addMany(graphics)
  } else if (draft.geometryType === 'LineString') {
    if (!Array.isArray(coords) || coords.length < 2) {
      return
    }

    const geometry = new Polyline({
      paths: [coords],
      spatialReference: { wkid: 4326 },
    })

    const symbol = {
      type: 'simple-line',
      color: draft.pinColor,
      width: 4,
    } as any

    previewLayer.add(
      new Graphic({
        geometry,
        symbol,
      })
    )
  } else if (draft.geometryType === 'Polygon') {
    if (!Array.isArray(coords) || coords.length === 0) {
      return
    }

    const geometry = new Polygon({
      rings: coords,
      spatialReference: { wkid: 4326 },
    })

    const rgb = hexToRgb(draft.pinColor)
    const symbol = {
      type: 'simple-fill',
      color: [rgb[0], rgb[1], rgb[2], 0.4],
      outline: {
        color: draft.pinColor,
        width: 2,
      },
    } as any

    previewLayer.add(
      new Graphic({
        geometry,
        symbol,
      })
    )
  }
}
