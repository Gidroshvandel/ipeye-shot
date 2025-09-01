#!/bin/sh
set -e

# Вариант с ACL (точечно и безопаснее, чем делать 644/755):
# даём pptruser право прохода к каталогу и чтения файла,
# и выставляем default ACL для будущих перезаписей options.json
if command -v setfacl >/dev/null 2>&1; then
  # каталог
  setfacl -m u:pptruser:rx /data || true
  setfacl -m d:u:pptruser:rx /data || true
  # сам файл (если уже существует)
  [ -f /data/options.json ] && setfacl -m u:pptruser:r /data/options.json || true
else
  # запасной вариант без ACL — более грубо, но работает
  chmod 755 /data 2>/dev/null || true
  chmod 644 /data/options.json 2>/dev/null || true
fi

# запускаем приложение без root
exec su -s /bin/sh -c "node /home/pptruser/runner.js" pptruser
