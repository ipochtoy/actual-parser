// google-auth.js

function getAuthToken(interactive) {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: interactive }, (token) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(token);
            }
        });
    });
}

async function removeToken(token) {
    return new Promise(resolve => chrome.identity.removeCachedAuthToken({ token }, resolve));
}

export async function readSheetData(spreadsheetId, sheetName) {
    async function attemptRead(interactive) {
        const token = await getAuthToken(interactive); // prompt if needed
        if (!token) throw new Error("Authorization failed. No token received.");

        const range = `${sheetName}!A:Z`;
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` },
        });

        if (!response.ok) {
            // Invalidate cached token and signal caller
            await removeToken(token);
            const text = await response.text().catch(() => '');
            throw new Error(`Google Sheets API status ${response.status}: ${text || 'no body'}`);
        }
        const data = await response.json();
        return data.values;
    }

    try {
        // First attempt (may reuse valid token)
        return await attemptRead(true);
    } catch (err) {
        console.warn('First read attempt failed, retrying with fresh auth...', err);
        try {
            // Second attempt after forcing fresh token (interactive)
            return await attemptRead(true);
        } catch (finalErr) {
            console.error("Error reading Google Sheet:", finalErr);
            throw finalErr;
        }
    }
}

export async function writeDataToSheet(spreadsheetId, sheetName, values) {
    const authToken = await getAuthToken(true); // Re-use auth logic, will prompt if needed
    if (!authToken) {
        throw new Error("Authentication failed. Cannot write to sheet.");
    }

    const range = `${sheetName}!A1`; // Start at A1 to append
    const valueInputOption = 'USER_ENTERED';
    const insertDataOption = 'INSERT_ROWS'; // This will add new rows

    const body = { values };

    try {
        const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=${valueInputOption}&insertDataOption=${insertDataOption}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('Google Sheets API write error response:', errorData);
            await removeToken(authToken);
            throw new Error(`Google Sheets API Error: ${errorData?.error?.message || response.status}`);
        }
        
        const result = await response.json();
        console.log('Successfully wrote data to sheet:', result);
        return result;

    } catch (error) {
        console.error('Error writing data to sheet:', error);
        throw error;
    }
}

// Low-level helpers for cleanup rewrite
export async function clearSheetRange(spreadsheetId, a1Range){
    const token = await getAuthToken(true);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(a1Range)}:clear`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`Clear failed: ${res.status}`);
}

export async function overwriteSheetValues(spreadsheetId, sheetName, values){
    const token = await getAuthToken(true);
    const range = `${sheetName}!A1`;
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ range, values, majorDimension: 'ROWS' })
    });
    if (!res.ok) throw new Error(`Overwrite failed: ${res.status}`);
}
