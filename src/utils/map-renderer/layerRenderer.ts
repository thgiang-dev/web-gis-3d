import Graphic from '@arcgis/core/Graphic'
import FeatureLayer from '@arcgis/core/layers/FeatureLayer'
import UniqueValueRenderer from '@arcgis/core/renderers/UniqueValueRenderer'
import type { MapRenderContext, NormalizedSpatialFeature, RenderResult } from '../../types/map'
import { chunkedRender } from '../performance/chunkedRender'
import { clearMapGraphics } from './clearMapGraphics'
import { renderLineFeature } from './renderLine'
import { renderPointFeature } from './renderPoint'
import { renderPolygonFeature } from './renderPolygon'
import { createHighlightSymbol } from './symbolFactory'



function getStyleKey(feature: NormalizedSpatialFeature): string {
  if (feature.geometryType === 'Point') {
    if (feature.model3D?.enabled && feature.model3D.modelUrl) {
      const scale = feature.model3D.scale ?? { x: 5, y: 5, z: 5 }
      const rotation = feature.model3D.rotation ?? { x: 0, y: 0, z: 0 }
      return `model_${feature.model3D.modelUrl}_${scale.x}_${scale.y}_${scale.z}_${rotation.x}_${rotation.y}_${rotation.z}`
    }
    return `pin_${feature.style.pinColor || '#ff0000'}`
  }
  if (feature.geometryType === 'LineString' || feature.geometryType === 'MultiLineString') {
    return `line_${feature.style.lineColor || '#0000ff'}_${feature.style.lineWidth || 2}`
  }
  return `polygon_${feature.style.polygonFillColor || '#ff0000'}_${feature.style.polygonOpacity ?? 0.5}_${feature.style.polygonOutlineColor || '#ffffff'}`
}

export async function renderSpatialFeatures(
  ctx: MapRenderContext,
  features: NormalizedSpatialFeature[],
  options?: {
    clearBeforeRender?: boolean
    chunkSize?: number
    onProgress?: (rendered: number, total: number) => void
  },
): Promise<RenderResult> {
  const startTime = performance.now()

  if (options?.clearBeforeRender) {
    clearMapGraphics(ctx)
  }

  if (features.length === 0) {
    return { rendered: 0, graphics: 0 }
  }

  const isLayerSource = features[0].sourceType === 'layer'

  // If it's a layer source and we have the featureLayersMap, render as FeatureLayers
  if (isLayerSource && ctx.featureLayersMap) {
    const layerId = features[0].layerId
    if (!layerId) {
      return { rendered: 0, graphics: 0 }
    }

    // 1. Clean up existing FeatureLayers for this layer
    const existingLayers = ctx.featureLayersMap.get(layerId)
    if (existingLayers) {
      existingLayers.forEach((lyr) => {
        ctx.view.map?.remove(lyr)
        lyr.destroy()
      })
      ctx.featureLayersMap.delete(layerId)
    }

    // Clear existing indexes for this layer
    ctx.layerFeatureIndex.get(layerId)?.forEach((featureId) => {
      ctx.graphicIndex.delete(featureId)
    })
    ctx.layerFeatureIndex.delete(layerId)

    // 2. Generate graphics in memory
    const baseGraphicsByGeom = {
      point: [] as Graphic[],
      polyline: [] as Graphic[],
      polygon: [] as Graphic[]
    }
    const modelGraphics: Graphic[] = []

    features.forEach((feature) => {
      const featureGraphics = renderFeature(ctx, feature)
      const styleKey = getStyleKey(feature)
      
      featureGraphics.forEach((g) => {
        if (!g.attributes) {
          g.attributes = {}
        }
        g.attributes.styleKey = styleKey

        if (g.attributes.appGraphicRole === 'model') {
          modelGraphics.push(g)
        } else {
          if (feature.geometryType === 'Point') {
            baseGraphicsByGeom.point.push(g)
          } else if (feature.geometryType === 'LineString' || feature.geometryType === 'MultiLineString') {
            baseGraphicsByGeom.polyline.push(g)
          } else {
            baseGraphicsByGeom.polygon.push(g)
          }
        }
      })
    })

    // 3. Assign unique integer OBJECTID to all graphics (mandatory for client-side FeatureLayer)
    let objectIdCounter = 1
    const assignObjectId = (g: Graphic) => {
      if (!g.attributes) {
        g.attributes = {}
      }
      g.attributes.OBJECTID = objectIdCounter++
    }

    baseGraphicsByGeom.point.forEach(assignObjectId)
    baseGraphicsByGeom.polyline.forEach(assignObjectId)
    baseGraphicsByGeom.polygon.forEach(assignObjectId)
    modelGraphics.forEach(assignObjectId)

    // 4. Create FeatureLayers for each geometry type
    const createdLayers: FeatureLayer[] = []
    const fields = [
      { name: "OBJECTID", alias: "OBJECTID", type: "oid" as const },
      { name: "appFeatureId", alias: "Feature ID", type: "string" as const },
      { name: "appFeatureName", alias: "Name", type: "string" as const },
      { name: "sourceType", alias: "Source Type", type: "string" as const },
      { name: "layerId", alias: "Layer ID", type: "string" as const },
      { name: "geometryType", alias: "Geometry Type", type: "string" as const },
      { name: "styleKey", alias: "Style Key", type: "string" as const }
    ]

    const popupTemplate = {
      title: "{appFeatureName}",
      content: (event: any) => {
        const graphic = event.graphic
        const props = graphic.attributes?.originalProperties || {}
        let tableHtml = '<table class="esri-widget" style="width:100%; border-collapse:collapse; font-family:var(--font-primary); font-size:13px; margin-top:8px;">'
        tableHtml += '<tbody>'
        const entries = Object.entries(props)
        if (entries.length === 0) {
          tableHtml += '<tr><td style="padding:6px; color:var(--color-text-muted); text-align:center;">Không có dữ liệu thuộc tính.</td></tr>'
        } else {
          for (const [key, val] of entries) {
            tableHtml += `<tr style="border-bottom:1px solid rgba(15,23,42,0.06);"><td style="padding:6px 8px; font-weight:bold; color:var(--color-text-secondary); width:40%;">${key}</td><td style="padding:6px 8px; color:var(--color-text-primary); word-break:break-all;">${typeof val === 'object' ? JSON.stringify(val) : val}</td></tr>`
          }
        }
        tableHtml += '</tbody></table>'
        return tableHtml
      }
    }

    const createUniqueValueRenderer = (graphics: Graphic[]) => {
      const uniqueStyleKeys = new Set<string>()
      const uniqueValueInfos: any[] = []
      
      graphics.forEach((g) => {
        const key = g.attributes?.styleKey
        if (key && !uniqueStyleKeys.has(key)) {
          uniqueStyleKeys.add(key)
          uniqueValueInfos.push({
            value: key,
            symbol: g.symbol
          })
        }
      })

      return new UniqueValueRenderer({
        field: "styleKey",
        uniqueValueInfos: uniqueValueInfos
      })
    }

    // A. Polygons (Bottom)
    if (baseGraphicsByGeom.polygon.length > 0) {
      const polygonLayer = new FeatureLayer({
        id: `${layerId}-polygons`,
        title: `${features[0].name || 'Polygons'}`,
        source: baseGraphicsByGeom.polygon,
        fields: fields,
        objectIdField: "OBJECTID",
        geometryType: "polygon",
        renderer: createUniqueValueRenderer(baseGraphicsByGeom.polygon),
        elevationInfo: {
          mode: "on-the-ground"
        },
        popupTemplate: popupTemplate
      })
      createdLayers.push(polygonLayer)
    }

    // B. Polylines
    if (baseGraphicsByGeom.polyline.length > 0) {
      const polylineLayer = new FeatureLayer({
        id: `${layerId}-lines`,
        title: `${features[0].name || 'Lines'}`,
        source: baseGraphicsByGeom.polyline,
        fields: fields,
        objectIdField: "OBJECTID",
        geometryType: "polyline",
        renderer: createUniqueValueRenderer(baseGraphicsByGeom.polyline),
        elevationInfo: {
          mode: "relative-to-ground"
        },
        popupTemplate: popupTemplate
      })
      createdLayers.push(polylineLayer)
    }

    // C. Points (Pins) - Rendered as a FeatureLayer with native selection reduction for 3D
    if (baseGraphicsByGeom.point.length > 0) {
      const isClusteringEnabled = (window as any).clusteringEnabled !== false
      const pointLayer = new FeatureLayer({
        id: `${layerId}-points`,
        title: `${features[0].name || 'Points'}`,
        source: baseGraphicsByGeom.point,
        fields: fields,
        objectIdField: "OBJECTID",
        geometryType: "point",
        renderer: createUniqueValueRenderer(baseGraphicsByGeom.point),
        elevationInfo: {
          mode: "relative-to-ground"
        },
        popupTemplate: popupTemplate,
        featureReduction: isClusteringEnabled ? { type: "selection" } as any : null
      })
      createdLayers.push(pointLayer)
    }

    // D. Models (3D GLB Models on top)
    if (modelGraphics.length > 0) {
      const modelLayer = new FeatureLayer({
        id: `${layerId}-models`,
        title: `${features[0].name || '3D Models'}`,
        source: modelGraphics,
        fields: fields,
        objectIdField: "OBJECTID",
        geometryType: "point",
        renderer: createUniqueValueRenderer(modelGraphics),
        elevationInfo: {
          mode: "relative-to-ground"
        },
        popupTemplate: popupTemplate
      })
      createdLayers.push(modelLayer)
    }

    // Add to Map in sorted order
    if (createdLayers.length > 0) {
      ctx.view.map?.addMany(createdLayers)
      ctx.featureLayersMap.set(layerId, createdLayers)
    }

    const duration = performance.now() - startTime
    console.log(
      `%c[Performance] Đã vẽ ${features.length} thực thể thành ${createdLayers.length} FeatureLayers trong ${duration.toFixed(2)}ms`,
      'color: #0d47a1; font-weight: bold; background: #e3f2fd; padding: 2px 6px; border-radius: 4px;'
    )

    return {
      rendered: features.length,
      graphics: objectIdCounter - 1
    }
  }

  // Fallback to GraphicsLayer rendering (for entities)
  let graphicsCount = 0
  const chunkBaseGraphics: Graphic[] = []
  const chunkModelGraphics: Graphic[] = []
  const safeChunkSize = Math.max(1, options?.chunkSize ?? 250)

  await chunkedRender(
    features,
    safeChunkSize,
    (feature, index) => {
      const featureGraphics = renderFeature(ctx, feature)
      graphicsCount += featureGraphics.length

      featureGraphics.forEach((g) => {
        if (g.attributes?.appGraphicRole === 'model') {
          chunkModelGraphics.push(g)
        } else {
          chunkBaseGraphics.push(g)
        }
      })

      const isEndOfChunk = (index + 1) % safeChunkSize === 0 || index === features.length - 1
      if (isEndOfChunk) {
        if (chunkBaseGraphics.length > 0) {
          ctx.graphicsLayer.addMany(chunkBaseGraphics)
          chunkBaseGraphics.length = 0
        }
        if (chunkModelGraphics.length > 0) {
          ctx.modelLayer.addMany(chunkModelGraphics)
          chunkModelGraphics.length = 0
        }
      }
    },
    options?.onProgress,
  )

  const endTime = performance.now()
  const duration = endTime - startTime
  console.log(
    `%c[Performance] Đã vẽ ${features.length} thực thể (${graphicsCount} graphics) trong ${duration.toFixed(2)}ms`,
    'color: #00897b; font-weight: bold; background: #e0f2f1; padding: 2px 6px; border-radius: 4px;'
  )

  return {
    rendered: features.length,
    graphics: graphicsCount,
  }
}

export function renderFeature(ctx: MapRenderContext, feature: NormalizedSpatialFeature): Graphic[] {
  if (feature.geometryType === 'Point') {
    return renderPointFeature(ctx, feature)
  }

  if (feature.geometryType === 'LineString' || feature.geometryType === 'MultiLineString') {
    return renderLineFeature(ctx, feature)
  }

  return renderPolygonFeature(ctx, feature)
}

export function highlightFeature(ctx: MapRenderContext, feature: NormalizedSpatialFeature): void {
  const graphics = ctx.graphicIndex.get(feature.id)
  if (!graphics || !ctx.highlightLayer) {
    return
  }

  const highlightGraphics = graphics
    .filter((graphic) => graphic.geometry)
    .map(
      (graphic) =>
        new Graphic({
          geometry: graphic.geometry,
          symbol: createHighlightSymbol(feature),
          attributes: graphic.attributes,
        }),
    )

  ctx.highlightLayer.addMany(highlightGraphics)
}

export function clearHighlight(ctx: MapRenderContext): void {
  ctx.highlightLayer?.removeAll()
}

export async function zoomToFeature(ctx: MapRenderContext, featureId: string): Promise<void> {
  const graphics = ctx.graphicIndex.get(featureId)
  if (!graphics || graphics.length === 0) {
    return
  }

  await ctx.view.goTo(graphics, {
    duration: 600,
  })
}
