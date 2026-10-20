#!/usr/bin/env bash
# Private helper copied outside the application before shutdown. Never uses sudo.
set -euo pipefail
directory=$1
parent_pid=$2
target=$3
source_dir=$4
token=$5
[[ $EUID != 0 && $parent_pid =~ ^[0-9]+$ && $token =~ ^[a-f0-9]{48}$ ]]
[[ $directory = /* && $target = /* && $target != / && $source_dir == "$directory/stage"* ]]
[[ ! -L $target && $(cat -- "$target/.duprove-managed") == 'Duprove managed installation v1' ]]
[[ -x $source_dir/duprove && -f $source_dir/resources/app.asar ]]
backup="$target.previous"
stage="$target.next-$token"
[[ ! -e $backup && ! -L $backup && ! -e $stage && ! -L $stage ]]
# Exclusive transaction lock also prevents two helpers racing after a restart.
exec 9>"$directory/install.lock"
flock -n 9
trap 'rm -rf -- "$stage"' EXIT
cp -a -- "$source_dir" "$stage"
printf '%s' "$token" > "$directory/armed"
for ((i=0; i<600; i++)); do
  if ! kill -0 "$parent_pid" 2>/dev/null; then break; fi
  sleep 0.1
done
if kill -0 "$parent_pid" 2>/dev/null; then rm -rf -- "$stage"; exit 1; fi
old_moved=0
new_moved=0
child=''
rollback() {
  local status=$?
  trap - EXIT
  if [[ $status != 0 && $old_moved == 1 ]]; then
    if [[ -n $child ]]; then
      kill "$child" 2>/dev/null || true
      for ((i=0; i<100; i++)); do kill -0 "$child" 2>/dev/null || break; sleep 0.1; done
      kill -KILL "$child" 2>/dev/null || true
      wait "$child" 2>/dev/null || true
    fi
    if [[ $new_moved == 1 ]]; then mv -- "$target" "$stage"; fi
    mv -- "$backup" "$target"
    printf '{"schema":1,"status":"rolled-back"}\n' > "$directory/result.json"
    "$target/duprove" >/dev/null 2>&1 9>&- &
  fi
  # stage was created exclusively by this helper, always a sibling of target.
  [[ ! -d $stage ]] || rm -rf -- "$stage"
  exit "$status"
}
trap rollback EXIT
trap 'exit 1' INT TERM
mv -- "$target" "$backup"
old_moved=1
mv -- "$stage" "$target"
new_moved=1
"$target/duprove" --duprove-updated >/dev/null 2>&1 9>&- &
child=$!
for ((i=0; i<1200; i++)); do
  if [[ -f $directory/ready && $(cat -- "$directory/ready") == "$token" ]]; then
    printf '{"schema":1,"status":"installed"}\n' > "$directory/result.json"
    rm -rf -- "$backup"
    exit 0
  fi
  kill -0 "$child" 2>/dev/null || exit 1
  sleep 0.1
done
exit 1
