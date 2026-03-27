// content-email-export.js - Экспорт email клиентов по тарифам Эконом/Универсал
// Скрипт сканирует страницу Pochtoy.com admin и собирает email клиентов

if (typeof window.emailExportLoaded === 'undefined') {
    window.emailExportLoaded = true;

    console.log("📧 Email Export script loaded on Pochtoy.com admin page.");

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "exportCustomerEmails") {
            extractAndExportEmails(request.options || {})
                .then(sendResponse);
            return true;
        }
    });

    async function extractAndExportEmails(options) {
        const targetTariffs = (options.tariffs || ['эконом', 'универсал']).map(t => t.toLowerCase());
        console.log(`📧 Extracting emails for tariffs: ${targetTariffs.join(', ')}`);

        try {
            const customers = [];

            // Стратегия 1: Поиск по таблицам на странице
            const tables = document.querySelectorAll('table');
            for (const table of tables) {
                const result = parseTable(table, targetTariffs);
                customers.push(...result);
            }

            // Стратегия 2: Поиск по карточкам/блокам (article, div с классами)
            if (customers.length === 0) {
                const cardResults = parseCards(targetTariffs);
                customers.push(...cardResults);
            }

            // Стратегия 3: Глубокий поиск по всей странице
            if (customers.length === 0) {
                const deepResults = deepScanPage(targetTariffs);
                customers.push(...deepResults);
            }

            // Дедупликация по email
            const uniqueMap = new Map();
            for (const c of customers) {
                const key = c.email.toLowerCase();
                if (!uniqueMap.has(key)) {
                    uniqueMap.set(key, c);
                }
            }
            const uniqueCustomers = Array.from(uniqueMap.values());

            console.log(`📧 Found ${uniqueCustomers.length} unique customers with emails`);

            // Отправляем данные обратно для скачивания
            return {
                status: "success",
                count: uniqueCustomers.length,
                data: uniqueCustomers
            };

        } catch (error) {
            console.error("📧 Export failed:", error);
            return { status: "error", message: error.message, count: 0, data: [] };
        }
    }

    // Парсинг таблиц - ищем колонки с email и тарифом
    function parseTable(table, targetTariffs) {
        const results = [];
        const rows = table.querySelectorAll('tr');
        if (rows.length < 2) return results;

        // Определяем индексы колонок по заголовкам
        const headerRow = rows[0];
        const headers = Array.from(headerRow.querySelectorAll('th, td')).map(
            cell => cell.textContent.trim().toLowerCase()
        );

        let emailCol = -1;
        let tariffCol = -1;
        let nameCol = -1;
        let trackCol = -1;
        let orderCol = -1;
        let phoneCol = -1;
        let dateCol = -1;

        headers.forEach((h, i) => {
            if (/e-?mail|почта|имейл|email/i.test(h)) emailCol = i;
            if (/тариф|tariff|услуга|service|тип\s*(отправ|доставк)/i.test(h)) tariffCol = i;
            if (/имя|name|клиент|customer|фамил|получатель/i.test(h)) nameCol = i;
            if (/трек|track|номер\s*отслеж/i.test(h)) trackCol = i;
            if (/заказ|order|номер/i.test(h)) orderCol = i;
            if (/телефон|phone|тел\./i.test(h)) phoneCol = i;
            if (/дата|date/i.test(h)) dateCol = i;
        });

        // Если не нашли колонки по заголовкам, пробуем определить по содержимому
        if (emailCol === -1 || tariffCol === -1) {
            const detected = detectColumnsByContent(rows, headers.length);
            if (emailCol === -1 && detected.emailCol >= 0) emailCol = detected.emailCol;
            if (tariffCol === -1 && detected.tariffCol >= 0) tariffCol = detected.tariffCol;
            if (nameCol === -1 && detected.nameCol >= 0) nameCol = detected.nameCol;
        }

        if (emailCol === -1) {
            console.log("📧 Could not find email column in table");
            return results;
        }

        // Собираем данные
        for (let i = 1; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('td');
            if (cells.length <= emailCol) continue;

            const email = extractEmail(cells[emailCol]?.textContent || '');
            if (!email) continue;

            const tariff = tariffCol >= 0 ? (cells[tariffCol]?.textContent || '').trim() : '';

            // Фильтр по тарифу (если колонка тарифа найдена)
            if (tariffCol >= 0 && tariff) {
                const tariffLower = tariff.toLowerCase();
                const matches = targetTariffs.some(t => tariffLower.includes(t));
                if (!matches) continue;
            }

            results.push({
                email: email,
                name: nameCol >= 0 ? (cells[nameCol]?.textContent || '').trim() : '',
                tariff: tariff,
                trackNumber: trackCol >= 0 ? (cells[trackCol]?.textContent || '').trim() : '',
                orderId: orderCol >= 0 ? (cells[orderCol]?.textContent || '').trim() : '',
                phone: phoneCol >= 0 ? (cells[phoneCol]?.textContent || '').trim() : '',
                date: dateCol >= 0 ? (cells[dateCol]?.textContent || '').trim() : ''
            });
        }

        return results;
    }

    // Определение колонок по содержимому (если заголовки не информативные)
    function detectColumnsByContent(rows, numCols) {
        const result = { emailCol: -1, tariffCol: -1, nameCol: -1 };
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
        const tariffKeywords = /эконом|универсал|стандарт|экспресс|premium|economy|universal|standard/i;

        for (let col = 0; col < numCols; col++) {
            let emailCount = 0;
            let tariffCount = 0;
            const sampleSize = Math.min(rows.length, 10);

            for (let row = 1; row < sampleSize; row++) {
                const cells = rows[row]?.querySelectorAll('td');
                if (!cells || cells.length <= col) continue;
                const text = cells[col]?.textContent || '';
                if (emailRegex.test(text)) emailCount++;
                if (tariffKeywords.test(text)) tariffCount++;
            }

            if (emailCount >= 2 && result.emailCol === -1) result.emailCol = col;
            if (tariffCount >= 2 && result.tariffCol === -1) result.tariffCol = col;
        }

        return result;
    }

    // Парсинг карточек (article, div блоки)
    function parseCards(targetTariffs) {
        const results = [];
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const tariffRegex = /(?:тариф|услуга|service|tariff)[:\s]*([\w\s-]+)/i;

        // Ищем контейнеры посылок/заказов
        const containers = document.querySelectorAll(
            'article, .parcel, .shipment, .order-item, .customer-row, ' +
            '.parcel-card, .shipment-card, [class*="parcel"], [class*="shipment"], ' +
            '[class*="order"], [class*="customer"], .row, .item'
        );

        for (const container of containers) {
            const text = container.textContent || '';
            const textLower = text.toLowerCase();

            // Проверяем тариф
            const hasTariff = targetTariffs.some(t => textLower.includes(t));
            if (!hasTariff) continue;

            // Извлекаем email
            const emails = text.match(emailRegex);
            if (!emails || emails.length === 0) continue;

            // Извлекаем тариф
            const tariffMatch = text.match(tariffRegex);
            const tariff = tariffMatch ? tariffMatch[1].trim() :
                           targetTariffs.find(t => textLower.includes(t)) || '';

            // Извлекаем имя (ищем рядом с email)
            const nameEl = container.querySelector(
                '.name, .customer-name, [class*="name"], .fio, [class*="fio"]'
            );

            for (const email of emails) {
                results.push({
                    email: email,
                    name: nameEl ? nameEl.textContent.trim() : '',
                    tariff: tariff,
                    trackNumber: extractTrackFromElement(container),
                    orderId: '',
                    phone: extractPhoneFromText(text),
                    date: ''
                });
            }
        }

        return results;
    }

    // Глубокий поиск по всей странице
    function deepScanPage(targetTariffs) {
        const results = [];
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const body = document.body.textContent || '';

        // Ищем все email на странице
        const allEmails = body.match(emailRegex) || [];
        if (allEmails.length === 0) return results;

        // Проверяем наличие целевых тарифов на странице
        const bodyLower = body.toLowerCase();
        const hasTariffs = targetTariffs.some(t => bodyLower.includes(t));
        if (!hasTariffs) {
            console.log("📧 No target tariffs found on page");
            return results;
        }

        // Находим элементы, содержащие email, и проверяем контекст
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
            if (el.children.length > 3) continue; // Только leaf-like элементы
            const elText = el.textContent || '';
            if (!emailRegex.test(elText)) continue;
            emailRegex.lastIndex = 0;

            // Поднимаемся по DOM, ищем контекст с тарифом
            let parent = el.parentElement;
            let depth = 0;
            let contextText = '';

            while (parent && depth < 8) {
                contextText = parent.textContent || '';
                const ctxLower = contextText.toLowerCase();
                if (targetTariffs.some(t => ctxLower.includes(t))) {
                    const emails = elText.match(emailRegex);
                    if (emails) {
                        const tariff = targetTariffs.find(t => ctxLower.includes(t)) || '';
                        for (const email of emails) {
                            results.push({
                                email,
                                name: '',
                                tariff,
                                trackNumber: '',
                                orderId: '',
                                phone: '',
                                date: ''
                            });
                        }
                    }
                    break;
                }
                parent = parent.parentElement;
                depth++;
            }
        }

        return results;
    }

    // Утилиты
    function extractEmail(text) {
        const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        return match ? match[0] : null;
    }

    function extractTrackFromElement(el) {
        const trackInput = el.querySelector('input.shop-tracking, input[name*="track"], [class*="track"] input');
        if (trackInput) return trackInput.value.trim();

        const text = el.textContent || '';
        // UPS, USPS, YT, TBA patterns
        const trackMatch = text.match(/\b(1Z[A-Z0-9]{16}|9[0-9]{21,25}|YT[A-Z0-9]+|TBA[0-9]+)\b/);
        return trackMatch ? trackMatch[0] : '';
    }

    function extractPhoneFromText(text) {
        const phoneMatch = text.match(/(?:\+?[0-9]{1,3}[-.\s]?)?(?:\(?[0-9]{2,4}\)?[-.\s]?)?[0-9]{3,4}[-.\s]?[0-9]{2,4}[-.\s]?[0-9]{2,4}/);
        return phoneMatch ? phoneMatch[0].trim() : '';
    }

    chrome.runtime.sendMessage({ action: "emailExportReady" });
}
