# Parser Watchdog

Внешний сторож ночного парса «Pochtoy Parsing». Живёт вне Chrome (launchd, каждые 15 мин),
читает состояние расширения по CDP (127.0.0.1:9222) и шлёт оператору Telegram-алерт, если:

1. **Chrome закрыт / расширение не загружено** — ночной парс в 23:00 не сможет запуститься.
2. **Прогон не стартовал** — прошёл слот 23:00 + 15 мин, а `lastDailyAutoParseTriggeredAt` до слота.
3. **Прогон завис** — `pipelineStage.active` и стадия висит > 30 мин.
4. **Выгрузка в Sheets не подтверждена** — прогон completed, но `lastSheetsUploadOkAt` пуст/старше слота (> 20 мин после финиша).

Дедуп: один алерт на инцидент (`.watchdog-state.json`), авто-переарм когда условие ушло.

## Установка
    cp watchdog/com.pochtoy.parser-watchdog.plist ~/Library/LaunchAgents/
    launchctl load ~/Library/LaunchAgents/com.pochtoy.parser-watchdog.plist

## Логи
    tail -f /tmp/parser-watchdog.log        # обычный вывод (STATUS каждой проверки)
    tail -f /tmp/parser-watchdog.err.log    # ошибки

## Ручной прогон (без отправки в Telegram)
    node watchdog/parser-watchdog.mjs --dry-run
