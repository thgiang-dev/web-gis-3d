import IconSymbol3DLayer from '@arcgis/core/symbols/IconSymbol3DLayer'
import LineSymbol3D from '@arcgis/core/symbols/LineSymbol3D'
import ObjectSymbol3DLayer from '@arcgis/core/symbols/ObjectSymbol3DLayer'
import PathSymbol3DLayer from '@arcgis/core/symbols/PathSymbol3DLayer'
import PointSymbol3D from '@arcgis/core/symbols/PointSymbol3D'
import SimpleFillSymbol from '@arcgis/core/symbols/SimpleFillSymbol'
import SimpleLineSymbol from '@arcgis/core/symbols/SimpleLineSymbol'
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol'
import type { LineProfile, NormalizedSpatialFeature, ResolvedSpatialStyle } from '../../types/map'
import type { ResolvedModel3DConfig } from '../../types/model3d'
import { createMapPinSymbol3D } from './pinSymbolFactory'
import { isBlobUrlValid } from '../file/objectUrlStore'

type HighlightSymbol = PointSymbol3D | SimpleMarkerSymbol | SimpleLineSymbol | SimpleFillSymbol

export { createMapPinSymbol3D }

// Symbol caches to avoid duplicate allocations
const pinSymbol3DCache = new Map<string, PointSymbol3D>()
const lineSymbol3DCache = new Map<string, LineSymbol3D>()
const polygonSymbolCache = new Map<string, SimpleFillSymbol>()
const modelSymbol3DCache = new Map<string, PointSymbol3D>()

/**
 * Pin symbol đẹp — dùng PointSymbol3D + IconSymbol3DLayer cho SceneView,
 * hiển thị pin nổi trên mặt đất.
 */
export function createPinSymbol3D(style: ResolvedSpatialStyle): PointSymbol3D {
  const key = style.pinColor || '#ff0000'
  let cached = pinSymbol3DCache.get(key)
  if (!cached) {
    cached = createMapPinSymbol3D(key, 34)
    pinSymbol3DCache.set(key, cached)
  }
  return cached
}

/**
 * Fallback 2D marker dùng cho highlight hoặc khi SceneView chưa sẵn sàng
 */
export function createPinSymbol(style: ResolvedSpatialStyle): SimpleMarkerSymbol {
  return new SimpleMarkerSymbol({
    style: 'circle',
    color: style.pinColor,
    size: 12,
    outline: {
      color: '#ffffff',
      width: 1.5,
    },
  })
}

/**
 * LineString 3D symbol — dùng PathSymbol3DLayer trong SceneView để render
 * dạng ống tròn (profile: "circle") hoặc khối vuông (profile: "quad").
 *
 * ArcGIS JS SDK PathSymbol3DLayer hỗ trợ profile "circle" và "quad" native.
 */
export function createLineSymbol3D(style: ResolvedSpatialStyle): LineSymbol3D {
  const profile = mapLineProfile(style.lineProfile)
  const key = `${style.lineColor || '#0000ff'}_${style.lineWidth || 2}_${style.lineHeight || 2}_${profile}_${style.lineCap || 'round'}`
  
  let cached = lineSymbol3DCache.get(key)
  if (!cached) {
    cached = new LineSymbol3D({
      symbolLayers: [
        new PathSymbol3DLayer({
          profile,
          material: { color: style.lineColor },
          width: style.lineWidth,
          height: style.lineHeight,
          join: 'round',
          cap: style.lineCap === 'square' ? 'square' : 'round',
        }),
      ],
    })
    lineSymbol3DCache.set(key, cached)
  }
  return cached
}

/**
 * Fallback 2D line symbol
 */
export function createLineSymbol(style: ResolvedSpatialStyle): SimpleLineSymbol {
  return new SimpleLineSymbol({
    color: style.lineColor,
    width: style.lineWidth,
    style: 'solid',
    cap: style.lineCap === 'square' ? 'square' : 'round',
    join: 'round',
  })
}

export function createPolygonSymbol(style: ResolvedSpatialStyle): SimpleFillSymbol {
  const key = `${style.polygonFillColor || '#ff0000'}_${style.polygonOpacity ?? 0.5}_${style.polygonOutlineColor || '#ffffff'}`
  
  let cached = polygonSymbolCache.get(key)
  if (!cached) {
    cached = new SimpleFillSymbol({
      color: withOpacity(style.polygonFillColor, style.polygonOpacity),
      outline: {
        color: style.polygonOutlineColor,
        width: 1.5,
      },
    })
    polygonSymbolCache.set(key, cached)
  }
  return cached
}

export function createHighlightSymbol(feature: NormalizedSpatialFeature): HighlightSymbol {
  if (feature.geometryType === 'Point') {
    return new PointSymbol3D({
      symbolLayers: [
        new IconSymbol3DLayer({
          resource: { primitive: 'circle' },
          material: { color: [0, 137, 123, 0.22] },
          outline: {
            color: '#00897b',
            size: 2.5,
          },
          size: feature.model3D?.enabled ? 52 : 42,
        }),
      ],
      verticalOffset: {
        screenLength: feature.model3D?.enabled ? 8 : 24,
        maxWorldLength: 180,
        minWorldLength: 0,
      },
    })
  }

  if (feature.geometryType === 'LineString' || feature.geometryType === 'MultiLineString') {
    return new SimpleLineSymbol({
      color: '#00897b',
      width: Math.max(feature.style.lineWidth + 3, 6),
      style: 'solid',
    })
  }

  return new SimpleFillSymbol({
    color: [0, 137, 123, 0.12],
    outline: {
      color: '#00897b',
      width: 3,
    },
  })
}

export function createModelSymbol3D(model3D: ResolvedModel3DConfig): PointSymbol3D | null {
  if (!model3D.modelUrl || !isBlobUrlValid(model3D.modelUrl)) {
    return null
  }

  const scale = model3D.scale ?? { x: 5, y: 5, z: 5 }
  const rotation = model3D.rotation ?? { x: 0, y: 0, z: 0 }
  const key = `${model3D.modelUrl}_${scale.x}_${scale.y}_${scale.z}_${rotation.x}_${rotation.y}_${rotation.z}`

  let cached = modelSymbol3DCache.get(key)
  if (!cached) {
    cached = new PointSymbol3D({
      symbolLayers: [
        new ObjectSymbol3DLayer({
          resource: { href: model3D.modelUrl },
          width: scale.x,
          depth: scale.y,
          height: scale.z,
          heading: rotation.z,
          tilt: rotation.x,
          roll: rotation.y,
        }),
      ],
    })
    modelSymbol3DCache.set(key, cached)
  }
  return cached
}

function withOpacity(hex: string, opacity: number): number[] | string {
  const normalized = hex.replace('#', '')
  if (normalized.length !== 6) {
    return hex
  }

  const red = Number.parseInt(normalized.slice(0, 2), 16)
  const green = Number.parseInt(normalized.slice(2, 4), 16)
  const blue = Number.parseInt(normalized.slice(4, 6), 16)
  return [red, green, blue, opacity]
}

/**
 * Map LineProfile enum → ArcGIS PathSymbol3DLayer profile.
 * ArcGIS JS SDK PathSymbol3DLayer trực tiếp hỗ trợ "circle" và "quad".
 */
function mapLineProfile(profile: LineProfile): 'circle' | 'quad' {
  if (profile === 'quad') return 'quad'
  return 'circle'
}
