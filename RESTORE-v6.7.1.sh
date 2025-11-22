#!/bin/bash
# Скрипт восстановления v6.7.1 STABLE

echo "🔄 Восстанавливаю v6.7.1 STABLE..."

# Восстановить content-amazon.js
cp content-amazon.js.v6.7.1-STABLE-WORKING content-amazon.js

# Проверить версию в manifest.json
VERSION=$(grep '"version"' manifest.json | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')
if [ "$VERSION" != "6.7.1" ]; then
    echo "⚠️ Версия в manifest.json: $VERSION (ожидалась 6.7.1)"
    echo "Обнови manifest.json вручную на версию 6.7.1"
else
    echo "✅ Версия в manifest.json: $VERSION"
fi

# Проверить синтаксис
node -c content-amazon.js
if [ $? -eq 0 ]; then
    echo "✅ Синтаксис OK"
else
    echo "❌ ОШИБКА синтаксиса!"
    exit 1
fi

# Проверить версию в логах
VERSION_LOG=$(grep "console.log.*Amazon Parser" content-amazon.js | grep -o 'v[0-9]\+\.[0-9]\+\.[0-9]\+')
echo "✅ Версия в логах: $VERSION_LOG"

echo ""
echo "✅ ВОССТАНОВЛЕНИЕ ЗАВЕРШЕНО!"
echo "📋 Перезагрузи расширение в chrome://extensions"
