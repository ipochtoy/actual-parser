// content-pochtoy.js - v6.9 (Rebuilt on stable base)

if (typeof window.pochtoyAutomationLoaded === 'undefined') {
    window.pochtoyAutomationLoaded = true;

    console.log("Content script for Pochtoy.com ADMIN loaded and ready.");

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    async function shouldStop() {
        return new Promise(resolve => {
            chrome.storage.local.get('stopAllParsers', (res) => resolve(!!res.stopAllParsers));
        });
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "searchAndFill") {
            findAndFill(request.data)
                .then(sendResponse); // Send the result back to the background script
            return true; // Signal that we will respond asynchronously
        }
    });
    
    // Сколько позиций было в ПРОШЛОЙ описи этой коробки.
    // «В посылке 4 позиций» → 4; «В посылке один товар» → 1; «В посылке 3 шт. — X» →
    // 1 (одна позиция в трёх штуках). Не нашли — null.
    function previousItemCount(existingValue) {
        const text = String(existingValue || '');
        let m = text.match(/В посылке\s+(\d+)\s+позици/i);
        if (m) return parseInt(m[1], 10);
        if (/В посылке\s+один\s+товар/i.test(text)) return 1;
        if (/В посылке\s+\d+\s+шт/i.test(text)) return 1;
        return null;
    }

    // Опись переписывается целиком, но молча ПОНИЖАТЬ число позиций нельзя: 02.09.2026
    // по заказу 114-4364449-9800232 опись «В посылке 1 товар» увела со склада три куклы
    // из четырёх. Стало больше — пишем, что состав уточнён; стало меньше — прямо
    // говорим о расхождении, чтобы человек сверил по кабинету магазина.
    function withCheckmark(baseNote, existingValue, itemCount) {
        const note = (baseNote || '').trim();
        if (!Number.isFinite(itemCount)) return note; // состав не разобран — сравнивать нечем
        const was = previousItemCount(existingValue);
        if (was === null || was === itemCount) return note;
        if (itemCount > was) return `${note}\n(состав уточнён: было ${was}, стало ${itemCount})`;
        return `${note}\n⚠️ расхождение с прошлой описью: было ${was}`;
    }

    async function saveWithRetry(noteInput, saveButton, finalNote) {
        // Set value and fire events so any framework detects change
        noteInput.value = finalNote;
        noteInput.dispatchEvent(new Event('input', { bubbles: true }));
        noteInput.dispatchEvent(new Event('change', { bubbles: true }));
        saveButton.click();
        await sleep(700);

        // If по какой-то причине значение не совпадает (или страница переписала), повторим ещё раз
        if ((noteInput.value || '').trim() !== finalNote.trim()) {
            console.warn('Note mismatch after save, retrying...');
            noteInput.value = finalNote;
            noteInput.dispatchEvent(new Event('input', { bubbles: true }));
            noteInput.dispatchEvent(new Event('change', { bubbles: true }));
            saveButton.click();
            await sleep(900);
        }
    }

    // Normalize tracking number: remove 4871 prefix if present
    function normalizeTrackingNumber(track) {
        const trimmed = track.trim();
        // If starts with 4871, return both versions (with and without prefix)
        if (trimmed.startsWith('4871') && trimmed.length > 4) {
            return {
                original: trimmed,
                withoutPrefix: trimmed.substring(4),
                withPrefix: trimmed
            };
        }
        return {
            original: trimmed,
            withoutPrefix: trimmed,
            withPrefix: '4871' + trimmed
        };
    }

    // Check if two tracking numbers match (handling 4871 prefix)
    function trackingNumbersMatch(track1, track2) {
        const norm1 = normalizeTrackingNumber(track1);
        const norm2 = normalizeTrackingNumber(track2);
        
        // Always compare withoutPrefix versions - this handles 4871 prefix correctly
        return norm1.withoutPrefix === norm2.withoutPrefix;
    }

    async function findAndFill(task) {
        if (await shouldStop()) {
            console.log('🛑 Stopped before task start');
            return { status: "stopped" };
        }
        const { trackNumber, note, itemCount } = task;
        console.log(`--- Starting task for track: ${trackNumber} ---`);

        try {
            // Try multiple selectors to find tracking input fields
            let inputs = document.querySelectorAll('input.shop-tracking');
            if (inputs.length === 0) {
                // Fallback: try other possible selectors
                inputs = document.querySelectorAll('input[type="text"][value*="4871"], input[type="text"][value*="940"], input[value*="4871"], input[value*="940"]');
                console.log(`⚠️ No inputs with "shop-tracking" class, trying fallback selectors: found ${inputs.length}`);
            }
            let targetInput = null;
            const normalized = normalizeTrackingNumber(trackNumber);
            console.log(`🔍 Looking for track: "${trackNumber}" (normalized: "${normalized.withoutPrefix}" or "${normalized.withPrefix}")`);
            console.log(`📋 Found ${inputs.length} input fields to check`);
            
            for (const input of inputs) {
                const inputValue = input.value.trim();
                const inputPlaceholder = (input.placeholder || '').trim();
                const inputTitle = (input.title || '').trim();
                
                console.log(`  Checking input: value="${inputValue}", placeholder="${inputPlaceholder}", title="${inputTitle}"`);
                
                // Check value, placeholder, and title
                if (trackingNumbersMatch(trackNumber, inputValue) || 
                    (inputPlaceholder && trackingNumbersMatch(trackNumber, inputPlaceholder)) ||
                    (inputTitle && trackingNumbersMatch(trackNumber, inputTitle))) {
                    targetInput = input;
                    console.log(`✅ Found matching input: "${inputValue}" matches "${trackNumber}"`);
                    break;
                } else {
                    const norm1 = normalizeTrackingNumber(trackNumber);
                    const norm2 = normalizeTrackingNumber(inputValue);
                    console.log(`  ❌ No match: "${norm1.withoutPrefix}" vs "${norm2.withoutPrefix}"`);
                }
            }

            if (!targetInput) {
                // Try to find by searching in nearby text as fallback
                console.log(`⚠️ Not found in inputs, trying fallback search...`);
                const allText = document.body.innerText || '';
                const searchPattern = new RegExp(`(4871)?${normalized.withoutPrefix.replace(/\d/g, '\\d')}`, 'g');
                if (searchPattern.test(allText)) {
                    console.log(`⚠️ Found track number in page text, but couldn't find input field`);
                }
                throw new Error(`Input field with track number "${trackNumber}" not found. Searched ${inputs.length} inputs.`);
            }
            console.log("Found input field.");

            const packageContainer = targetInput.closest('article.unassigned-item'); 
            if (!packageContainer) throw new Error("Could not find package container.");
            
            const noteInput = packageContainer.querySelector('textarea.description');
            if (!noteInput) throw new Error("Note textarea not found.");

            const existing = noteInput.value || '';
            const finalNote = withCheckmark(note, existing, itemCount);
            console.log('Existing note:', existing.substring(0, 120));
            console.log('New note:', finalNote.substring(0, 120));

            const saveNoteButton = packageContainer.querySelector('button.set-description');
            if (!saveNoteButton) throw new Error("Save button not found.");

            await saveWithRetry(noteInput, saveNoteButton, finalNote);
            
            if (await shouldStop()) {
                console.log('🛑 Stopped after save');
                return { status: "stopped" };
            }

            return { status: "success" };

        } catch (error) {
            console.error(`Automation failed for ${trackNumber}:`, error.message);
            return { status: "error", message: error.message };
        }
    }

    // Announce that the script is ready
    chrome.runtime.sendMessage({ action: "contentScriptReady" });
}

