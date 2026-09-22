#!/bin/bash
# Проверить, закоммитить, запушить.
set -e
cd "$(dirname "$0")"

node test.js
ver=$(grep -m1 '^// @version' fix-my-mist.user.js | awk '{print $3}')
git add -A
# Коммит мог быть сделан и руками — тогда публикуем то, что уже лежит в ветке.
git diff --cached --quiet || git commit -q -m "${1:-обновление правок}"

# Обновления раздаёт сайт клана (@updateURL) — он берёт файл с GitHub. Codeberg
# (.mirror, отдельный репозиторий на один файл) остаётся для установок со старым
# @updateURL: оттуда они один раз получают версию, которая шлёт уже на сайт.
# Пушим до GitHub: не уедет зеркало — старые установки застрянут.
if [ -d .mirror ]; then
  cp fix-my-mist.user.js .mirror/
  git -C .mirror diff --quiet || git -C .mirror commit -qam "$ver"
  git -C .mirror push -q origin main
fi

git push

# Коммит со старой версией в шапке Tampermonkey за обновление не считает,
# поэтому дожидаемся, пока адрес из @updateURL отдаст новую.
raw=https://templars-clan.online/fix-my-mist.user.js
for i in $(seq 24); do
  [[ $(curl -sS "$raw") == *"$ver"* ]] && {
    echo "опубликовано $ver, сайт отдаёт её через $((i * 5)) с"
    exit 0
  }
  sleep 5
done
echo "опубликовано $ver, но сайт ещё отдаёт старое — Tampermonkey увидит позже"
