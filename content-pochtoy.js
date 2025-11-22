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
    
    function withCheckmark(baseNote, existingValue) {
        // Возвращаем исходный текст без чекмарков и счетчиков
        return (baseNote || '').trim();
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

    async function findAndFill(task) {
        if (await shouldStop()) {
            console.log('🛑 Stopped before task start');
            return { status: "stopped" };
        }
        const { trackNumber, note } = task;
        console.log(`--- Starting task for track: ${trackNumber} ---`);

        try {
            const inputs = document.querySelectorAll('input.shop-tracking');
            let targetInput = null;
            for (const input of inputs) {
                if (input.value.trim() === trackNumber.trim()) {
                    targetInput = input;
                    break;
                }
            }

            if (!targetInput) throw new Error(`Input field with track number "${trackNumber}" not found.`);
            console.log("Found input field.");

            const packageContainer = targetInput.closest('article.unassigned-item'); 
            if (!packageContainer) throw new Error("Could not find package container.");
            
            const noteInput = packageContainer.querySelector('textarea.description');
            if (!noteInput) throw new Error("Note textarea not found.");

            const existing = noteInput.value || '';
            const finalNote = withCheckmark(note, existing);
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

