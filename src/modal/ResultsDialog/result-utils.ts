import type { GroupMember } from '../../../contracts/catalog'
export const availability = { available: 'Найден', missing: 'Файл отсутствует', changed: 'Файл изменился', unavailable: 'Нет доступа' }
export const decisionLabels = { unresolved: 'Не решено', keep: 'Оставить', review: 'Проверить вручную', delete: 'Отмечен для удаления', trashed: 'В корзине' }
export const canSelectMember = (member: GroupMember) => member.decision !== 'trashed' && member.availability === 'available' && member.lastOperation !== 'pending'
export function catalogError(error: unknown): string {
  const text = String(error)
  const reasons: Record<string, string> = {
    CATALOG_UNAVAILABLE: 'Каталог результатов отсутствует. Закройте это окно и запустите новый анализ.',
    CATALOG_EXPIRED: 'Срок хранения результатов истёк. Запустите новый анализ.',
    ORIGINAL_PROTECTED: 'Этот файл выбран оригиналом в одной из групп. Сначала пересмотрите выбор.',
    FILE_UNAVAILABLE: 'Файл отсутствует, изменился или недоступен. Обновите анализ.',
    ANALYSIS_BUSY: 'Дождитесь окончания анализа.',
    ORIGINAL_REQUIRED: 'Сначала выберите сохраняемый оригинал и другой экземпляр для сравнения.',
    MANUAL_REVIEW_REQUIRED: 'Для похожих файлов откройте оба предпросмотра и подтвердите ручную проверку.',
    CATALOG_BUSY: 'Дождитесь завершения текущей операции с файлами.',
    TRASH_RESULT_UNCERTAIN: 'Перенос был начат, но результат не записан. Проверьте файл и корзину вручную; затем выполните новый анализ.',
    CONFIRMATION_TOO_LARGE: 'Подтверждение содержит слишком длинные пути. Выберите меньше файлов.',
  }
  return Object.entries(reasons).find(([code]) => text.includes(code))?.[1] ?? 'Не удалось выполнить действие. Повторите попытку. ' + text.replace(/^Error: /, '')
}
