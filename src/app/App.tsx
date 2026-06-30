import Camera from '@arcgis/core/Camera'
import { Download, Globe, Layers, MapPinned, PanelLeft, Settings2, Plus, Minus, Compass, Hand, RotateCw, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LayerPanel, type LayerRuntimeStatus } from '../features/layer-management/components/LayerPanel'
import { useLayerManagement } from '../features/layer-management/hooks/useLayerManagement'
import { ArcgisSceneMap } from '../features/map/components/ArcgisSceneMap'
import { MapInspector } from '../features/map/components/MapInspector'
import { MapToolbar } from '../features/map/components/MapToolbar'
import { useArcgisScene, type ArcgisMapContexts } from '../features/map/hooks/useArcgisScene'
import { useEditable3DModels } from '../features/map/hooks/useEditable3DModels'
import { useMapSelection } from '../features/map/hooks/useMapSelection'
import { useSliceWidget } from '../features/map/hooks/useSliceWidget'
import { SpatialEntityPanel } from '../features/spatial-entity-management/components/SpatialEntityPanel'
import { useSpatialEntityManagement } from '../features/spatial-entity-management/hooks/useSpatialEntityManagement'
import { exportCurrentDataAsJson } from '../services/mock-backend/fileStorageService'
import {
  buildArcgisGeojsonQueryUrl,
  clearGeojsonCache,
  loadGeojsonForSource,
} from '../services/mock-backend/geojsonRepository'
import { normalizeLayerGeojson, normalizeSpatialEntity } from '../services/geojson/geojsonNormalizer'
import type { LayerConfig } from '../types/layer'
import type { InspectorFeature, NormalizedSpatialFeature } from '../types/map'
import type { SpatialEntityConfig } from '../types/spatialEntity'
import { removeFeaturesBySource } from '../utils/map-renderer/clearMapGraphics'
import { clearHighlight, highlightFeature, renderSpatialFeatures, zoomToFeature } from '../utils/map-renderer/layerRenderer'

type LeftTab = 'layers' | 'entities'

export default function App() {
  const { contextsRef, setContexts } = useArcgisScene()
  const [heading, setHeading] = useState(0)
  const [activeTool, setActiveTool] = useState<'pan' | 'rotate'>('pan')
  const { selectedFeature, setSelectedFeature, clearSelection } = useMapSelection()
  const { layers, loading, error, saveLayer, deleteLayer, setLayers } = useLayerManagement()
  const {
    entities,
    loading: entitiesLoading,
    error: entitiesError,
    saveEntity,
    deleteEntity,
    setEntities,
  } = useSpatialEntityManagement()

  const [statusByLayerId, setStatusByLayerId] = useState<Record<string, LayerRuntimeStatus>>({})
  const [mapReady, setMapReady] = useState(false)
  const [renderVersion, setRenderVersion] = useState(0)
  const [leftTab, setLeftTab] = useState<LeftTab>('layers')
  const [leftPanelOpen, setLeftPanelOpen] = useState(false)
  const [editor3DEnabled, setEditor3DEnabled] = useState(false)
  const [sliceEnabled, setSliceEnabled] = useState(false)
  const [clusteringEnabled, setClusteringEnabled] = useState(true)
  const [pickedCoordinate, setPickedCoordinate] = useState<{ longitude: number; latitude: number; z: number } | null>(null)

  useEffect(() => {
    ;(window as any).clusteringEnabled = clusteringEnabled
  }, [clusteringEnabled])

  useEffect(() => {
    if (mapReady && contextsRef.current?.layer.view) {
      const view = contextsRef.current?.layer.view
      setActiveTool((view.navigation as any).activeTool)
      
      const handle = view.watch('camera', (camera) => {
        if (camera) {
          setHeading(camera.heading || 0)
        }
      })
      const toolHandle = view.navigation.watch('activeTool', (tool) => {
        if (tool === 'pan' || tool === 'rotate') {
          setActiveTool(tool)
        }
      })
      
      return () => {
        handle.remove()
        toolHandle.remove()
      }
    }
  }, [mapReady, contextsRef])

  const handleZoomIn = () => {
    const view = contextsRef.current?.layer.view
    if (view) {
      view.goTo({ zoom: (view.zoom ?? 0) + 1 })
    }
  }

  const handleZoomOut = () => {
    const view = contextsRef.current?.layer.view
    if (view) {
      view.goTo({ zoom: (view.zoom ?? 0) - 1 })
    }
  }

  const handleResetCompass = () => {
    const view = contextsRef.current?.layer.view
    if (view) {
      view.goTo({ heading: 0, tilt: 45 } as any, { duration: 800 })
    }
  }

  const handleToggleNavigation = () => {
    const view = contextsRef.current?.layer.view
    if (view) {
      const nextTool = activeTool === 'pan' ? 'rotate' : 'pan'
      ;(view.navigation as any).activeTool = nextTool
      setActiveTool(nextTool)
    }
  }

  const featureRegistryRef = useRef(new Map<string, NormalizedSpatialFeature>())
  const normalizedLayerCacheRef = useRef(new Map<string, NormalizedSpatialFeature[]>())
  const initialRenderDoneRef = useRef(false)

  const layerNameById = useMemo(
    () => new Map(layers.map((layer) => [layer.layerId, layer.layerName])),
    [layers],
  )

  /** Map<layerId, NormalizedSpatialFeature[]> for children display */
  const featuresByLayerId = useMemo(() => {
    const map = new Map<string, NormalizedSpatialFeature[]>()
    featureRegistryRef.current.forEach((feature) => {
      if (feature.layerId) {
        if (!map.has(feature.layerId)) {
          map.set(feature.layerId, [])
        }
        map.get(feature.layerId)!.push(feature)
      }
    })
    // Force dependency on renderVersion
    void renderVersion
    return map
  }, [renderVersion])

  const editableModelFeatures = useMemo(() => {
    const features = [...featureRegistryRef.current.values()].filter(
      (feature) => feature.geometryType === 'Point' && Boolean(feature.model3D?.enabled && feature.model3D.modelUrl),
    )
    void renderVersion
    return features
  }, [renderVersion])

  const registerFeatures = useCallback((features: NormalizedSpatialFeature[]) => {
    features.forEach((feature) => featureRegistryRef.current.set(feature.id, feature))
    setRenderVersion((value) => value + 1)
  }, [])

  const unregisterBySource = useCallback((sourceType: 'layer' | 'entity', sourceId: string) => {
    featureRegistryRef.current.forEach((feature, featureId) => {
      if (
        feature.sourceType === sourceType &&
        (feature.layerId === sourceId || feature.entityId === sourceId)
      ) {
        featureRegistryRef.current.delete(featureId)
      }
    })
    setRenderVersion((value) => value + 1)
  }, [])

  const loadLayerToMap = useCallback(
    async (layer: LayerConfig, forceReload = false) => {
      const contexts = contextsRef.current
      if (!contexts) {
        return
      }

      if (!layer.visible) {
        removeFeaturesBySource(contexts.layer, 'layer', layer.layerId)
        unregisterBySource('layer', layer.layerId)
        return
      }

      setStatusByLayerId((current) => ({
        ...current,
        [layer.layerId]: {
          loaded: current[layer.layerId]?.loaded ?? 0,
          loading: true,
          progress: 0,
        },
      }))

      try {
        if (forceReload) {
          clearGeojsonCache(layer.layerId)
          normalizedLayerCacheRef.current.delete(layer.layerId)
        }

        const cachedFeatures = normalizedLayerCacheRef.current.get(layer.layerId)
        const features =
          cachedFeatures ??
          normalizeLayerGeojson(layer, await loadGeojsonForSource(layer.layerId, resolveLayerGeojsonUrl(layer)))

        normalizedLayerCacheRef.current.set(layer.layerId, features)
        removeFeaturesBySource(contexts.layer, 'layer', layer.layerId)
        unregisterBySource('layer', layer.layerId)

        let lastProgress = -1
        await renderSpatialFeatures(contexts.layer, features, {
          clearBeforeRender: false,
          chunkSize: 300,
          onProgress: (rendered, total) => {
            const progress = Math.round((rendered / Math.max(total, 1)) * 100)
            if (progress === 100 || progress - lastProgress >= 5) {
              lastProgress = progress
              setStatusByLayerId((current) => ({
                ...current,
                [layer.layerId]: {
                  loaded: rendered,
                  loading: true,
                  progress,
                },
              }))
            }
          },
        })
        registerFeatures(features)
        setStatusByLayerId((current) => ({
          ...current,
          [layer.layerId]: {
            loaded: features.length,
            loading: false,
            progress: 100,
          },
        }))
      } catch (reason) {
        setStatusByLayerId((current) => ({
          ...current,
          [layer.layerId]: {
            loaded: current[layer.layerId]?.loaded ?? 0,
            loading: false,
            progress: 0,
            error: reason instanceof Error ? reason.message : 'Lỗi tải dữ liệu lớp.',
          },
        }))
      }
    },
    [contextsRef, registerFeatures, unregisterBySource],
  )



  const renderEntityToMap = useCallback(
    async (entity: SpatialEntityConfig) => {
      const contexts = contextsRef.current
      if (!contexts) {
        return
      }

      removeFeaturesBySource(contexts.entity, 'entity', entity.entityId)
      unregisterBySource('entity', entity.entityId)

      if (!entity.visible) {
        return
      }

      const feature = normalizeSpatialEntity(entity)
      await renderSpatialFeatures(contexts.entity, [feature], { clearBeforeRender: false, chunkSize: 1 })
      registerFeatures([feature])
    },
    [contextsRef, registerFeatures, unregisterBySource],
  )

  const renderAllVisible = useCallback(
    async (forceReload = false) => {
      await Promise.all(layers.filter((layer) => layer.visible).map((layer) => loadLayerToMap(layer, forceReload)))
      await Promise.all(entities.filter((entity) => entity.visible).map(renderEntityToMap))
    },
    [entities, layers, loadLayerToMap, renderEntityToMap],
  )

  useEffect(() => {
    if (!mapReady || loading || entitiesLoading || initialRenderDoneRef.current) {
      return
    }

    initialRenderDoneRef.current = true
    void renderAllVisible(false)
  }, [entitiesLoading, loading, mapReady, renderAllVisible])

  const handleMapReady = useCallback(
    (contexts: ArcgisMapContexts) => {
      initialRenderDoneRef.current = false
      setContexts(contexts)
      setMapReady(true)
    },
    [setContexts],
  )

  const clearAllHighlights = useCallback(() => {
    const contexts = contextsRef.current
    if (!contexts) {
      return
    }

    clearHighlight(contexts.layer)
    clearHighlight(contexts.entity)
  }, [contextsRef])

  const handleFeatureClick = useCallback(
    (featureId: string) => {
      const feature = featureRegistryRef.current.get(featureId)
      const contexts = contextsRef.current
      if (!feature || !contexts) {
        return
      }

      const inspectorFeature: InspectorFeature = {
        ...feature,
        layerName: feature.layerId ? layerNameById.get(feature.layerId) : undefined,
      }
      setSelectedFeature(inspectorFeature)
      clearHighlight(contexts.layer)
      clearHighlight(contexts.entity)
      highlightFeature(feature.sourceType === 'entity' ? contexts.entity : contexts.layer, feature)
    },
    [contextsRef, layerNameById, setSelectedFeature],
  )

  const handleMapClick = useCallback((point: { longitude: number; latitude: number; z: number }) => {
    setPickedCoordinate(point)
  }, [])

  const closeInspector = useCallback(() => {
    clearAllHighlights()
    clearSelection()
  }, [clearAllHighlights, clearSelection])

  async function toggleLayer(layer: LayerConfig) {
    const nextLayer = { ...layer, visible: !layer.visible }
    await saveLayer(nextLayer)
    setLayers((current) => current.map((item) => (item.layerId === layer.layerId ? nextLayer : item)))
    
    const featureLayers = contextsRef.current?.layer.featureLayersMap.get(layer.layerId)
    if (featureLayers && featureLayers.length > 0) {
      featureLayers.forEach((lyr) => {
        lyr.visible = nextLayer.visible
      })
    } else {
      await loadLayerToMap(nextLayer)
    }
  }

  async function updateLayer(layer: LayerConfig) {
    normalizedLayerCacheRef.current.delete(layer.layerId)
    await saveLayer(layer)
    setLayers((current) => current.map((item) => (item.layerId === layer.layerId ? layer : item)))
    await loadLayerToMap(layer, true)
  }

  async function removeLayer(layerId: string) {
    const contexts = contextsRef.current
    if (contexts) {
      removeFeaturesBySource(contexts.layer, 'layer', layerId)
      clearAllHighlights()
    }
    unregisterBySource('layer', layerId)
    normalizedLayerCacheRef.current.delete(layerId)
    await deleteLayer(layerId)
  }

  async function toggleEntity(entity: SpatialEntityConfig) {
    const nextEntity = { ...entity, visible: !entity.visible }
    await saveEntity(nextEntity)
    setEntities((current) => current.map((item) => (item.entityId === entity.entityId ? nextEntity : item)))
    await renderEntityToMap(nextEntity)
  }

  async function upsertEntity(entity: SpatialEntityConfig) {
    await saveEntity(entity)
    setEntities((current) => {
      const index = current.findIndex((item) => item.entityId === entity.entityId)
      if (index < 0) {
        return [...current, entity]
      }
      const next = [...current]
      next[index] = entity
      return next
    })
    await renderEntityToMap(entity)
  }

  async function removeEntity(entityId: string) {
    const contexts = contextsRef.current
    await deleteEntity(entityId)
    setEntities((current) => current.filter((entity) => entity.entityId !== entityId))
    if (contexts) {
      removeFeaturesBySource(contexts.entity, 'entity', entityId)
      clearAllHighlights()
    }
    unregisterBySource('entity', entityId)
  }

  const handleToggleClustering = () => {
    const nextVal = !clusteringEnabled
    setClusteringEnabled(nextVal)
    ;(window as any).clusteringEnabled = nextVal
    
    const contexts = contextsRef.current
    if (contexts?.layer.featureLayersMap) {
      contexts.layer.featureLayersMap.forEach((layers) => {
        layers.forEach((lyr) => {
          if (lyr.declaredClass === 'esri.layers.FeatureLayer' && lyr.id.endsWith('-points')) {
            ;(lyr as any).featureReduction = nextVal ? { type: "selection" } : null
          }
        })
      })
    }
  }

  async function zoomLayer(layerId: string) {
    const contexts = contextsRef.current
    if (!contexts) {
      return
    }

    const featureLayers = contexts.layer.featureLayersMap.get(layerId)
    if (featureLayers && featureLayers.length > 0) {
      const extents = await Promise.all(
        featureLayers.map(async (lyr) => {
          const response = await lyr.queryExtent()
          return response.extent
        })
      )
      const validExtents = extents.filter((ext: any) => ext !== null) as any[]
      if (validExtents.length > 0) {
        let fullExtent = validExtents[0].clone()
        for (let i = 1; i < validExtents.length; i++) {
          fullExtent = fullExtent.union(validExtents[i])
        }
        await contexts.layer.view.goTo(fullExtent, { duration: 800 })
        return
      }
    }

    const feature = [...featureRegistryRef.current.values()].find((item) => item.layerId === layerId)
    if (feature) {
      void zoomToFeature(contexts.layer, feature.id)
    }
  }

  function zoomItem(featureId: string) {
    const contexts = contextsRef.current
    if (!contexts) {
      return
    }

    const feature = featureRegistryRef.current.get(featureId)
    if (feature?.sourceType === 'entity') {
      void zoomToFeature(contexts.entity, featureId)
    } else {
      void zoomToFeature(contexts.layer, featureId)
    }
  }

  function resetView() {
    const view = contextsRef.current?.layer.view
    if (!view) {
      return
    }

    void view.goTo(new Camera({
      position: {
        longitude: 105.7821,
        latitude: 10.0298,
        z: 1800,
      },
      tilt: 62,
      heading: 0,
    }))
  }

  function toggleSelectedModel(featureId: string) {
    const contexts = contextsRef.current
    const feature = featureRegistryRef.current.get(featureId)
    const graphics =
      feature?.sourceType === 'entity'
        ? contexts?.entity.graphicIndex.get(featureId)
        : contexts?.layer.graphicIndex.get(featureId)
    graphics?.forEach((graphic) => {
      const attributes = graphic.attributes as Record<string, unknown>
      if (attributes.appGraphicRole === 'model') {
        graphic.visible = !graphic.visible
      }
    })
  }

  function exportData() {
    exportCurrentDataAsJson({
      layers,
      entities,
      exportedAt: new Date().toISOString(),
    })
  }

  function selectFeatureById(featureId: string) {
    handleFeatureClick(featureId)
  }

  useEditable3DModels({
    enabled: editor3DEnabled,
    view: mapReady ? contextsRef.current?.layer.view ?? null : null,
    features: editableModelFeatures,
    entities,
    onEntityEdited: upsertEntity,
  })

  useSliceWidget({
    enabled: sliceEnabled,
    view: mapReady ? contextsRef.current?.layer.view ?? null : null,
  })

  const loadedFeatureCount = featureRegistryRef.current.size + renderVersion * 0

  return (
    <div className="h-full w-full relative app-root bg-[var(--color-bg)] flex flex-col">
      {/* ── Top Bar ── */}
      <header className="top-bar flex-shrink-0">
        <div className="top-bar-title">
          <div className="top-bar-logo">
            <Globe size={18} />
          </div>
          <div>
            <h1>Hệ thống GIS 3D</h1>
            <p>Bản đồ không gian — ArcGIS SceneView</p>
          </div>
        </div>
        <div className="top-bar-actions">
          <button className="btn-header" type="button" onClick={exportData}>
            <Download size={14} />
            Xuất JSON
          </button>
          <button
            className="btn-header"
            type="button"
            onClick={() => setLeftPanelOpen((v) => !v)}
            title={leftPanelOpen ? 'Ẩn bảng quản lý' : 'Hiện bảng quản lý'}
          >
            <PanelLeft size={14} />
          </button>
        </div>
      </header>

      {/* ── Main Content Area ── */}
      <div className="relative flex-1 w-full overflow-hidden">
        {/* ── Full-screen ArcGIS 3D Map ── */}
        <ArcgisSceneMap onReady={handleMapReady} onFeatureClick={handleFeatureClick} onMapClick={handleMapClick} />

        {/* ── Map Toolbar ── */}
      <MapToolbar
        onResetView={resetView}
        onClearSelection={closeInspector}
        onReloadVisible={() => void renderAllVisible(true)}
        onToggleEditor3D={() => setEditor3DEnabled((value) => !value)}
        onToggleSlice={() => setSliceEnabled((value) => !value)}
        onToggleClustering={handleToggleClustering}
        loadedFeatureCount={loadedFeatureCount}
        editor3DEnabled={editor3DEnabled}
        sliceEnabled={sliceEnabled}
        clusteringEnabled={clusteringEnabled}
      />

      {/* ── Left Floating Panel ── */}
      {leftPanelOpen ? (
        <aside className="floating-panel floating-panel-left" id="left-panel">
          <nav className="panel-tabs">
            <button
              className={`panel-tab ${leftTab === 'layers' ? 'active' : ''}`}
              type="button"
              onClick={() => setLeftTab('layers')}
            >
              <Layers size={14} />
              Lớp dữ liệu
            </button>
            <button
              className={`panel-tab ${leftTab === 'entities' ? 'active' : ''}`}
              type="button"
              onClick={() => setLeftTab('entities')}
            >
              <Settings2 size={14} />
              Thực thể
            </button>
            <button
              className="panel-close-button"
              type="button"
              onClick={() => setLeftPanelOpen(false)}
              title="Ẩn bảng quản lý"
            >
              <X size={16} />
            </button>
          </nav>

          {/* Tab Content */}
          {leftTab === 'layers' ? (
            <LayerPanel
              layers={layers}
              statusByLayerId={statusByLayerId}
              loading={loading}
              error={error}
              featuresByLayerId={featuresByLayerId}
              onToggleLayer={(layer) => void toggleLayer(layer)}
              onReloadLayer={(layer) => void loadLayerToMap(layer, true)}
              onZoomLayer={zoomLayer}
              onSaveLayer={(layer) => void updateLayer(layer)}
              onDeleteLayer={(layerId) => void removeLayer(layerId)}
              onSelectFeature={selectFeatureById}
              onZoomFeature={zoomItem}
              onClose={() => setLeftPanelOpen(false)}
            />
          ) : (
            <SpatialEntityPanel
              entities={entities}
              loading={entitiesLoading}
              error={entitiesError}
              pickedCoordinate={pickedCoordinate}
              onClearPickedCoordinate={() => setPickedCoordinate(null)}
              onSaveEntity={(entity) => void upsertEntity(entity)}
              onDeleteEntity={(entityId) => void removeEntity(entityId)}
              onToggleEntity={(entity) => void toggleEntity(entity)}
              onZoomEntity={zoomItem}
              onClose={() => setLeftPanelOpen(false)}
            />
          )}
        </aside>
      ) : (
        <>
          <div className="absolute left-4 top-[70px] z-30">
            {/* Custom Left Map Toolbar (Vertical Pill) */}
            <div className="left-map-toolbar">
              <button className="icon-button" type="button" onClick={handleZoomIn} title="Phóng to">
                <Plus size={16} />
              </button>
              <button className="icon-button" type="button" onClick={handleZoomOut} title="Thu nhỏ">
                <Minus size={16} />
              </button>
              <div className="left-map-toolbar-divider" />
              <button className="icon-button" type="button" onClick={handleToggleNavigation} title={activeTool === 'pan' ? 'Chế độ xoay 3D' : 'Chế độ kéo bản đồ'}>
                {activeTool === 'pan' ? <Hand size={16} /> : <RotateCw size={16} />}
              </button>
              <button className="icon-button" type="button" onClick={handleResetCompass} title="Đặt lại hướng Bắc">
                <Compass 
                  size={16} 
                  style={{ transform: `rotate(${-heading}deg)`, transition: 'transform 0.1s ease-out' }} 
                />
              </button>
            </div>
          </div>

          <button
            className="toggle-button"
            type="button"
            onClick={() => setLeftPanelOpen(true)}
            title="Hiện bảng quản lý"
          >
            <MapPinned size={15} />
          </button>
        </>
      )}

      {/* ── Right Floating Panel (Inspector) ── */}
      {selectedFeature ? (
        <aside className="floating-panel floating-panel-right" id="right-panel">
          <MapInspector
            feature={selectedFeature}
            onClose={closeInspector}
            onZoom={zoomItem}
            onToggleModel={toggleSelectedModel}
          />
        </aside>
      ) : null}
      </div>
    </div>
  )
}

function resolveLayerGeojsonUrl(layer: LayerConfig): string {
  if (layer.sourceType === 'local-geojson') {
    if (!layer.geojsonFile) {
      throw new Error('Layer local thiếu geojsonFile.')
    }
    return layer.geojsonFile
  }

  if (!layer.geojsonUrl) {
    throw new Error('Layer remote thiếu geojsonUrl.')
  }

  return layer.sourceType === 'arcgis-query-url' ? buildArcgisGeojsonQueryUrl(layer.geojsonUrl) : layer.geojsonUrl
}
