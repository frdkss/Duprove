export const fileTypeName = (type: string) => type === 'empty' ? 'Пустой файл' : type === 'none' ? 'Без расширения' : type

// The extension alone defines the color; counts, disk and display order never do.
export function fileTypeColor(type: string): string {
  const extension = type.toLowerCase()
  if (extension === 'empty') return '#a5ada8'
  if (extension === 'none') return '#7c8b99'
  let hash = 2166136261
  for (let i = 0; i < extension.length; i++) hash = Math.imul(hash ^ extension.charCodeAt(i), 16777619) >>> 0
  return `hsl(${(hash % 3600) / 10} ${50 + (hash >>> 12) % 16}% ${43 + (hash >>> 20) % 13}%)`
}
