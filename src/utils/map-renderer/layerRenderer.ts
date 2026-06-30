import Graphic from '@arcgis/core/Graphic'
import type { MapRenderContext, NormalizedSpatialFeature, RenderResult } from '../../types/map'
import { chunkedRender } from '../performance/chunkedRender'
import { clearMapGraphics } from './clearMapGraphics'
import { renderLineFeature } from './renderLine'
import { renderPointFeature } from './renderPoint'
import { renderPolygonFeature } from './renderPolygon'
import { createHighlightSymbol } from './symbolFactory'

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
