const objectUrls = new Map<string, string>()
const activeBlobUrls = new Set<string>()

export function createStoredObjectUrl(file: File): string {
  const key = `${file.name}-${file.size}-${file.lastModified}`
  const existing = objectUrls.get(key)
  if (existing) {
    return existing
  }

  const url = URL.createObjectURL(file)
  objectUrls.set(key, url)
  activeBlobUrls.add(url)
  return url
}

export function registerActiveBlobUrl(url: string): void {
  activeBlobUrls.add(url)
}

export function isBlobUrlValid(url: string): boolean {
  if (!url.startsWith('blob:')) {
    return true
  }
  return activeBlobUrls.has(url)
}

export function revokeStoredObjectUrls(): void {
  objectUrls.forEach((url) => URL.revokeObjectURL(url))
  objectUrls.clear()
  activeBlobUrls.clear()
}
