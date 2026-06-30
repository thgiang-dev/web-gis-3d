import { dataFolders } from '../../constants/folders'
import type { LayerConfig } from '../../types/layer'
import { getModelFile, deleteModelFile } from '../../utils/file/indexedDbStore'
import { registerActiveBlobUrl } from '../../utils/file/objectUrlStore'

const storageKey = 'frontend-gis.layers'

export interface LayerRepository {
  listLayers(): Promise<LayerConfig[]>
  getLayer(layerId: string): Promise<LayerConfig | null>
  saveLayer(layer: LayerConfig): Promise<void>
  deleteLayer(layerId: string): Promise<void>
}

export class LocalLayerRepository implements LayerRepository {
  async listLayers(): Promise<LayerConfig[]> {
    const stored = readStoredLayers()
    if (stored) {
      return restoreLayerModels(stored)
    }

    const response = await fetch(dataFolders.layers)
    if (!response.ok) {
      throw new Error('Không đọc được /data/layers/layers.json')
    }
    const layers = (await response.json()) as LayerConfig[]
    writeStoredLayers(layers)
    return restoreLayerModels(layers)
  }

  async getLayer(layerId: string): Promise<LayerConfig | null> {
    const layers = await this.listLayers()
    return layers.find((layer) => layer.layerId === layerId) ?? null
  }

  async saveLayer(layer: LayerConfig): Promise<void> {
    const layers = await this.listLayers()
    const existingIndex = layers.findIndex((item) => item.layerId === layer.layerId)
    const nextLayers = [...layers]
    if (existingIndex >= 0) {
      nextLayers[existingIndex] = layer
    } else {
      nextLayers.push(layer)
    }
    writeStoredLayers(nextLayers)
  }

  async deleteLayer(layerId: string): Promise<void> {
    const layers = await this.listLayers()
    const target = layers.find((layer) => layer.layerId === layerId)
    if (target?.model3D?.modelId) {
      try {
        await deleteModelFile(target.model3D.modelId)
      } catch (err) {
        console.error(`Không xóa được file mô hình ${target.model3D.modelId} từ IndexedDB:`, err)
      }
    }
    writeStoredLayers(layers.filter((layer) => layer.layerId !== layerId))
  }
}

async function restoreLayerModels(layers: LayerConfig[]): Promise<LayerConfig[]> {
  for (const layer of layers) {
    if (layer.model3D?.enabled && layer.model3D.modelId) {
      try {
        const fileBlob = await getModelFile(layer.model3D.modelId)
        if (fileBlob) {
          const newUrl = URL.createObjectURL(fileBlob)
          registerActiveBlobUrl(newUrl)
          layer.model3D.modelUrl = newUrl
        }
      } catch (err) {
        console.error(`Không thể khôi phục mô hình cho lớp ${layer.layerId}:`, err)
      }
    }
  }
  return layers
}

export const layerRepository = new LocalLayerRepository()

function readStoredLayers(): LayerConfig[] | null {
  const raw = window.localStorage.getItem(storageKey)
  return raw ? (JSON.parse(raw) as LayerConfig[]) : null
}

function writeStoredLayers(layers: LayerConfig[]): void {
  window.localStorage.setItem(storageKey, JSON.stringify(layers))
}
