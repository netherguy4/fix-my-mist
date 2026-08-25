#!/bin/bash
# Проверить, закоммитить, запушить.
set -e
cd "$(dirname "$0")"

node test.js
ver=$(grep -m1 '^// @version' fix-my-mist.user.js | awk '{print $3}')
git add -A
git diff --cached --quiet && { echo "нечего публиковать"; exit 0; }
git commit -q -m "${1:-обновление правок}"

# Обновление раздаёт Codeberg: raw.githubusercontent открывается не у всех в
# РФ. .mirror — отдельный репозиторий на один файл, заводится вручную один раз.
# Пушим до GitHub: не уедет зеркало — не уедет и версия, которая на него шлёт.
if [ -d .mirror ]; then
  cp fix-my-mist.user.js .mirror/
  git -C .mirror diff --quiet || git -C .mirror commit -qam "$ver"
  git -C .mirror push -q origin main
fi

git push

# Коммит со старой версией в шапке Tampermonkey за обновление не считает,
# поэтому дожидаемся, пока адрес из @updateURL отдаст новую.
raw=https://codeberg.org/netherguy/fix-my-mist-script/raw/branch/main/fix-my-mist.user.js
for i in $(seq 24); do
  [[ $(curl -sS "$raw") == *"$ver"* ]] && {
    echo "опубликовано $ver, Codeberg отдаёт её через $((i * 5)) с"
    exit 0
  }
  sleep 5
done
echo "опубликовано $ver, но Codeberg ещё отдаёт старое — Tampermonkey увидит позже"
