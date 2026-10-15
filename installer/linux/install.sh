#!/usr/bin/env bash
set -euo pipefail

mode=${1:-}
if [[ $mode == --help ]]; then
  printf 'Использование: bash install.sh [--non-interactive]\nУстановка для текущего пользователя, без sudo.\n'
  exit 0
fi
if [[ $# -gt 1 || ( -n $mode && $mode != --non-interactive ) ]]; then
  printf 'Неизвестный параметр. Используйте --help.\n' >&2; exit 2
fi
if [[ $(uname -s) != Linux || $EUID == 0 ]]; then
  printf 'Запустите установщик в Linux от обычного пользователя, без sudo.\n' >&2; exit 1
fi
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
notice="$source_dir/resources/statistics-notice.txt"
if [[ ! -f $notice || ! -x $source_dir/duprove || ! -x $source_dir/resources/analyzer/duprove-analyzer ]]; then
  printf 'Архив неполный. Распакуйте весь tar.gz перед установкой.\n' >&2; exit 1
fi
# Always show the notice before making changes. Enter continues installation, not consent.
cat -- "$notice"
printf '\n'
if [[ $mode != --non-interactive ]]; then
  if [[ ! -t 0 || ! -t 1 ]]; then
    printf 'Откройте терминал или передайте --non-interactive; уведомление будет выведено в любом случае.\n' >&2; exit 1
  fi
  read -r -p 'Нажмите Enter для установки. Ctrl+C — отмена. ' ignored
fi

data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
for directory in "$HOME" "$data_home"; do
  if [[ $directory != /* || $directory == / || $directory == *$'\n'* || $directory == *$'\r'* || $directory == *$'\t'* ]]; then
    printf 'HOME и XDG_DATA_HOME должны быть абсолютными путями без управляющих символов.\n' >&2; exit 1
  fi
done
mkdir -p -- "$data_home" "$HOME/.local/bin" "$data_home/applications"
data_home=$(cd -- "$data_home" && pwd -P)
bin_home=$(cd -- "$HOME/.local/bin" && pwd -P)
target="$data_home/duprove"
launcher="$bin_home/duprove"
desktop="$data_home/applications/duprove.desktop"
marker='Duprove managed installation v1'
if [[ -L $target || ( -e $target && ( ! -f $target/.duprove-managed || $(cat -- "$target/.duprove-managed") != "$marker" ) ) ]]; then
  printf 'Каталог назначения уже существует и не принадлежит установщику Duprove.\n' >&2; exit 1
fi
if [[ -e $launcher || -L $launcher ]]; then
  if [[ -L $launcher ]] || ! grep -qxF '# Duprove managed launcher v1' "$launcher"; then
    printf 'Команда duprove уже существует и не принадлежит этому установщику.\n' >&2; exit 1
  fi
fi
if [[ -e $desktop || -L $desktop ]]; then
  if [[ -L $desktop ]] || ! grep -qxF 'X-Duprove-Managed=true' "$desktop"; then
    printf 'Ярлык Duprove уже существует и не принадлежит этому установщику.\n' >&2; exit 1
  fi
fi
stage=$(mktemp -d "$data_home/.duprove-stage.XXXXXXXX")
backup=''
launcher_tmp=''
desktop_tmp=''
installed=0
committed=0
cleanup() {
  local status=$?
  if [[ $committed == 0 ]]; then
    if [[ $installed == 1 ]]; then rm -rf -- "$target"; fi
    if [[ -n $backup && -d $backup ]]; then mv -- "$backup" "$target"; fi
  elif [[ -n $backup ]]; then rm -rf -- "$backup"; fi
  [[ -z $stage ]] || rm -rf -- "$stage"
  [[ -z $launcher_tmp ]] || rm -f -- "$launcher_tmp"
  [[ -z $desktop_tmp ]] || rm -f -- "$desktop_tmp"
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp -a -- "$source_dir/." "$stage/"
printf '%s\n' "$marker" > "$stage/.duprove-managed"
chmod u+x "$stage/duprove" "$stage/resources/analyzer/duprove-analyzer"
launcher_tmp=$(mktemp "$bin_home/.duprove-launcher.XXXXXXXX")
printf '#!/usr/bin/env bash\n# Duprove managed launcher v1\ntarget=%q\n' "$target" > "$launcher_tmp"
cat >> "$launcher_tmp" <<'LAUNCHER'
# Recover the rename gap after power loss. Never move an unmarked directory.
if [[ ! -e $target && ! -L $target && -d $target.previous && ! -L $target.previous && $(cat -- "$target.previous/.duprove-managed") == 'Duprove managed installation v1' ]]; then
  mv -- "$target.previous" "$target"
fi
exec "$target/duprove" "$@"
LAUNCHER
chmod 755 "$launcher_tmp"

# Exec has two escaping layers: desktop strings, then argument quoting.
exec_path=${launcher//\\/\\\\}
exec_path=${exec_path//\"/\\\"}
exec_path=${exec_path//\$/\\\$}
exec_path=${exec_path//\`/\\\`}
exec_path=${exec_path//\\/\\\\}
exec_path=${exec_path//%/%%}
desktop_tmp=$(mktemp "$data_home/applications/.duprove-desktop.XXXXXXXX")
printf '[Desktop Entry]\nType=Application\nName=Duprove\nComment=Локальный анализ дубликатов файлов\nExec="%s"\nTerminal=false\nCategories=Utility;\nStartupWMClass=Duprove\nX-Duprove-Managed=true\n' "$exec_path" > "$desktop_tmp"
chmod 644 "$desktop_tmp"
if [[ -d $target ]]; then
  backup=$(mktemp -d "$data_home/.duprove-backup.XXXXXXXX")
  rmdir -- "$backup"
  mv -- "$target" "$backup"
fi
mv -- "$stage" "$target"
stage=''
installed=1
mv -f -- "$launcher_tmp" "$launcher"
launcher_tmp=''
mv -f -- "$desktop_tmp" "$desktop"
desktop_tmp=''
committed=1
printf '\nDuprove установлен: %s\nЗапуск: %s\n' "$target" "$launcher"
printf 'Настройки, отчёты и сохранённый отказ от отправки не изменены.\n'
