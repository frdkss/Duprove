!include "nsDialogs.nsh"

; electron-builder inserts the standard license page before the directory page.
; Require an explicit check; do not combine license acceptance with statistics.
!ifndef BUILD_UNINSTALLER
  !define MUI_LICENSEPAGE_CHECKBOX
  !define MUI_LICENSEPAGE_CHECKBOX_TEXT "Я принимаю условия GNU GPL v3."
!endif

; Only this installer-owned marker permits automatic replacement. Unpacked and
; machine-wide installations are deliberately not treated as per-user NSIS.
!macro customInstall
  ${If} $installMode == "CurrentUser"
    FileOpen $0 "$INSTDIR\.duprove-managed" w
    FileWrite $0 "Duprove NSIS per-user v1"
    FileClose $0
  ${EndIf}
!macroend

; Information only. No checkbox, consent write, or acceptance callback.
; The separate GPL license page must not be treated as statistics consent.
!macro customWelcomePage
  Page custom DuproveDataNotice
  Function DuproveDataNotice
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "Данные и конфиденциальность" "Отправка статистики добровольна."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    nsDialogs::CreateControl EDIT ${WS_VISIBLE}|${WS_CHILD}|${WS_TABSTOP}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY} ${WS_EX_CLIENTEDGE} 0 0 100% 100% "Duprove анализирует выбранные накопители локально: имена, пути, размеры, даты изменения, хеши и байты файлов для сравнения. Рабочий файл, каталог групп, выбор оригинала и решения остаются на компьютере. Предпросмотр не отправляется. Перенос отмеченных копий в системную корзину требует отдельного подтверждения.$\r$\n$\r$\nАнонимная статистика используется для школьного проекта, пока отправка включена. Отчёт содержит расширения, количества файлов и пустых файлов, экземпляров и лишних копий, группы дубликатов, обезличенные данные диаграмм, номера дисков внутри отчёта и обобщённые категории расположения. Стандартные категории: документы, загрузки, рабочий стол, изображения, музыка, видео; для остальных папок — единый итог.$\r$\n$\r$\nСодержимое и имена файлов, полные пути, хеши, названия и структура нестандартных каталогов не отправляются.$\r$\n$\r$\nПо умолчанию отправка включена при первом запуске. Её можно отключить в настройках приложения; после отключения программа работает локально. Ранее сохранённый отказ сохраняется при обновлении. После отключения ожидающие отчёты остаются на компьютере; повторное включение разрешает отправку только новых отчётов. Уже переданные данные отозвать из приложения нельзя.$\r$\n$\r$\nБез настроенного сервера отчёты остаются локально. Включение по умолчанию не фиксируется как явное согласие пользователя."
    Pop $0
    nsDialogs::Show
  FunctionEnd
!macroend
