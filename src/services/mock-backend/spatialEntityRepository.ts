import { dataFolders } from '../../constants/folders'
import type { SpatialEntityConfig } from '../../types/spatialEntity'
import { getModelFile, deleteModelFile } from '../../utils/file/indexedDbStore'
import { registerActiveBlobUrl } from '../../utils/file/objectUrlStore'

const storageKey = 'frontend-gis.entities'

export interface SpatialEntityRepository {
  listEntities(): Promise<SpatialEntityConfig[]>
  saveEntity(entity: SpatialEntityConfig): Promise<void>
  deleteEntity(entityId: string): Promise<void>
}

export class LocalSpatialEntityRepository implements SpatialEntityRepository {
  async listEntities(): Promise<SpatialEntityConfig[]> {
    const stored = readStoredEntities()
    if (stored) {
      return restoreEntityModels(stored)
    }

    const response = await fetch(dataFolders.entities)
    if (!response.ok) {
      throw new Error('Không đọc được /data/entities/spatial-entities.json')
    }
    const entities = (await response.json()) as SpatialEntityConfig[]
    writeStoredEntities(entities)
    return restoreEntityModels(entities)
  }

  async saveEntity(entity: SpatialEntityConfig): Promise<void> {
    const entities = await this.listEntities()
    const existingIndex = entities.findIndex((item) => item.entityId === entity.entityId)
    const nextEntities = [...entities]
    if (existingIndex >= 0) {
      nextEntities[existingIndex] = entity
    } else {
      nextEntities.push(entity)
    }
    writeStoredEntities(nextEntities)
  }

  async deleteEntity(entityId: string): Promise<void> {
    const entities = await this.listEntities()
    const target = entities.find((entity) => entity.entityId === entityId)
    if (target?.model3D?.modelId) {
      try {
        await deleteModelFile(target.model3D.modelId)
      } catch (err) {
        console.error(`Không xóa được file mô hình ${target.model3D.modelId} từ IndexedDB:`, err)
      }
    }
    writeStoredEntities(entities.filter((entity) => entity.entityId !== entityId))
  }
}

async function restoreEntityModels(entities: SpatialEntityConfig[]): Promise<SpatialEntityConfig[]> {
  for (const entity of entities) {
    if (entity.model3D?.enabled && entity.model3D.modelId) {
      try {
        const fileBlob = await getModelFile(entity.model3D.modelId)
        if (fileBlob) {
          const newUrl = URL.createObjectURL(fileBlob)
          registerActiveBlobUrl(newUrl)
          entity.model3D.modelUrl = newUrl
        }
      } catch (err) {
        console.error(`Không thể khôi phục mô hình cho thực thể ${entity.entityId}:`, err)
      }
    }
  }
  return entities
}

export const spatialEntityRepository = new LocalSpatialEntityRepository()

function readStoredEntities(): SpatialEntityConfig[] | null {
  const raw = window.localStorage.getItem(storageKey)
  return raw ? (JSON.parse(raw) as SpatialEntityConfig[]) : null
}

function writeStoredEntities(entities: SpatialEntityConfig[]): void {
  window.localStorage.setItem(storageKey, JSON.stringify(entities))
}
