import type Editor from '@arcgis/core/widgets/Editor'
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer'
import type Graphic from '@arcgis/core/Graphic'
import type SceneView from '@arcgis/core/views/SceneView'
import { useEffect, useRef, type MutableRefObject } from 'react'
import type { NormalizedSpatialFeature } from '../../../types/map'
import type { SpatialEntityConfig } from '../../../types/spatialEntity'
import { createEditableModelLayers } from '../../../utils/map-editor/createEditableModelLayer'
import { updateEntityFromEditedFeature } from '../../../utils/map-editor/entityFeatureAdapter'
import type { ArcgisMapContexts } from './useArcgisScene'

type UseEditable3DModelsOptions = {
  enabled: boolean
  view: SceneView | null
  contextsRef: MutableRefObject<ArcgisMapContexts | null>
  features: NormalizedSpatialFeature[]
  entities: SpatialEntityConfig[]
  onEntityEdited: (entity: SpatialEntityConfig) => void
}

export function useEditable3DModels({
  enabled,
  view,
  contextsRef,
  features,
  entities,
  onEntityEdited,
}: UseEditable3DModelsOptions): void {
  // Use refs to avoid re-triggering the main useEffect when state updates
  const featuresRef = useRef(features)
  const entitiesRef = useRef(entities)
  const onEntityEditedRef = useRef(onEntityEdited)

  useEffect(() => {
    featuresRef.current = features
  }, [features])

  useEffect(() => {
    entitiesRef.current = entities
  }, [entities])

  useEffect(() => {
    onEntityEditedRef.current = onEntityEdited
  }, [onEntityEdited])

  useEffect(() => {
    const activeFeatures = featuresRef.current
    if (!enabled || !view || activeFeatures.length === 0) {
      return undefined
    }

    let isCancelled = false
    const contexts = contextsRef.current
    const activeEditedFeatureIds = new Set(activeFeatures.map((f) => f.id))
    
    // 1. Set global window flag to prevent newly rendered static features from being visible
    ;(window as any).activeEditedFeatureIds = activeEditedFeatureIds

    // 2. Temporarily hide original graphics in memory (both point pins and 3D models)
    activeEditedFeatureIds.forEach((featureId) => {
      contexts?.layer.graphicIndex.get(featureId)?.forEach((g) => {
        g.visible = false
      })
      contexts?.entity.graphicIndex.get(featureId)?.forEach((g) => {
        g.visible = false
      })
    })

    // 3. Temporarily hide static graphics in FeatureLayers already added to the map by applying definitionExpression
    const idsString = [...activeEditedFeatureIds].map(id => `'${id}'`).join(',')
    const expression = `appFeatureId NOT IN (${idsString})`
    
    view.map?.layers.forEach((layer) => {
      if (layer.declaredClass === 'esri.layers.FeatureLayer') {
        const fl = layer as FeatureLayer
        if (fl.fields?.some(f => f.name === 'appFeatureId')) {
          fl.definitionExpression = expression
        }
      }
    })

    let editor: Editor | null = null
    const editableLayers: FeatureLayer[] = createEditableModelLayers(activeFeatures)
    const handles: Array<{ remove: () => void }> = []

    async function mountEditor() {
      const { default: EditorWidget } = await import('@arcgis/core/widgets/Editor')
      
      if (isCancelled) {
        return
      }

      if (!view?.map || editableLayers.length === 0) {
        return
      }

      view.map.addMany(editableLayers)
      editableLayers.forEach((layer) => {
        handles.push(
          layer.on('edits', (event) => {
            const objectIds = event.updatedFeatures
              .map((feature) => feature.objectId)
              .filter((objectId): objectId is number => typeof objectId === 'number')
            
            // Retrieve latest entities and callback from refs inside the event handler
            const latestEntities = entitiesRef.current
            const entityById = new Map(latestEntities.map((entity) => [entity.entityId, entity]))
            void syncEditedObjectIds(layer, objectIds, entityById, onEntityEditedRef.current)
          }),
        )
      })

      editor = new EditorWidget({
        view,
        layerInfos: editableLayers.map((layer) => ({
          layer,
          enabled: true,
          addEnabled: true,
          updateEnabled: true,
          deleteEnabled: false,
        })),
        supportingWidgetDefaults: {
          sketch: {
            defaultUpdateOptions: {
              tool: 'transform',
              enableRotation: true,
              enableScaling: true,
              preserveAspectRatio: true,
            },
          },
        } as any,
      })

      if (isCancelled) {
        editor.destroy()
        editableLayers.forEach((layer) => view.map?.remove(layer))
        handles.forEach((handle) => handle.remove())
        return
      }

      view.ui.add(editor, 'top-right')
    }

    void mountEditor()

    return () => {
      isCancelled = true

      // 1. Restore visibility of original static graphics
      activeEditedFeatureIds.forEach((featureId) => {
        contexts?.layer.graphicIndex.get(featureId)?.forEach((g) => {
          g.visible = true
        })
        contexts?.entity.graphicIndex.get(featureId)?.forEach((g) => {
          g.visible = true
        })
      })

      // 2. Clear definitionExpression on all FeatureLayers
      view.map?.layers.forEach((layer) => {
        if (layer.declaredClass === 'esri.layers.FeatureLayer') {
          const fl = layer as FeatureLayer
          if (fl.fields?.some(f => f.name === 'appFeatureId')) {
            fl.definitionExpression = null as any
          }
        }
      })

      // 3. Clear global window flag
      ;(window as any).activeEditedFeatureIds = undefined

      handles.forEach((handle) => handle.remove())
      if (editor) {
        view.ui.remove(editor)
        editor.destroy()
      }
      editableLayers.forEach((layer) => view.map?.remove(layer))
    }
  }, [enabled, view, contextsRef])
}

async function syncEditedObjectIds(
  layer: FeatureLayer,
  objectIds: number[],
  entityById: Map<string, SpatialEntityConfig>,
  onEntityEdited: (entity: SpatialEntityConfig) => void,
): Promise<void> {
  if (objectIds.length === 0) {
    return
  }

  const results = await layer.queryFeatures({
    objectIds,
    outFields: ['*'],
    returnGeometry: true,
  })

  results.features.forEach((graphic: Graphic) => {
    const entityId = typeof graphic.attributes?.ENTITY_ID === 'string' ? graphic.attributes.ENTITY_ID : ''
    if (!entityId) {
      const layerId = typeof graphic.attributes?.LAYER_ID === 'string' ? graphic.attributes.LAYER_ID : ''
      console.warn('[map-editor] Edited layer model is not persisted to GeoJSON in frontend-only mode.', { layerId })
      return
    }

    const entity = entityById.get(entityId)
    if (!entity) {
      console.warn('[map-editor] Edited entity model could not be synced because entity was not found.', { entityId })
      return
    }

    onEntityEdited(updateEntityFromEditedFeature(entity, graphic))
  })
}
