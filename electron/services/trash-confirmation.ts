import type { MessageBoxOptions } from 'electron'
import type { TrashPlan } from '../../contracts/catalog'

export function trashConfirmationOptions(plan: TrashPlan): MessageBoxOptions {
  const detail = plan.entries.map(e => `В корзину: ${e.path}\nСохранить оригинал: ${e.originalPath}${e.kind !== 'exact' ? '\nПохожие файлы: содержимое может различаться.' : ''}`).join('\n\n')
  if (detail.length > 60000) throw Error('CONFIRMATION_TOO_LARGE')
  return { type: 'warning', title: 'Перенести файлы в корзину?', message: `Файлов для переноса: ${plan.entries.length}`,
    detail, buttons: ['Отмена', 'Перенести в корзину'], defaultId: 0, cancelId: 0, noLink: true }
}
