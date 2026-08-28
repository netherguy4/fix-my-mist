#!/bin/bash
# Дев-сборка: тот же файл под именем «Fix My Mist (dev)», обновляется с ветки dev
# зеркала, в прод (main) не попадает. Ставится рядом с боевым скриптом — боевой
# на время проверки выключить в Tampermonkey, иначе правки встанут дважды.
set -e
cd "$(dirname "$0")"

node test.js
ver=$(grep -m1 '^// @version' fix-my-mist.user.js | awk '{print $3}').$(date +%Y%m%d%H%M)
raw=https://codeberg.org/netherguy/fix-my-mist/raw/branch/dev/fix-my-mist.user.js
sed -e "s|^// @name .*|// @name         Fix My Mist (dev)|" \
    -e "s|^// @version .*|// @version      $ver|" \
    -e "s|^\(// @updateURL \+\).*|\1$raw|" \
    -e "s|^\(// @downloadURL \+\).*|\1$raw|" fix-my-mist.user.js > "${1:-.mirror/fix-my-mist.user.js}"
[ -n "$1" ] && exit 0

git -C .mirror checkout -q -B dev
git -C .mirror commit -qam "$ver"
git -C .mirror push -q -f origin dev
git -C .mirror checkout -q main
echo "dev $ver → $raw"
