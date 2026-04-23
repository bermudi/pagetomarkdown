import browser from 'webextension-polyfill';

const STORAGE_KEY = 'defaultStripLinks';
const DEBUG_KEY = 'debugLogging';

async function loadSettings() {
    const result = await browser.storage.local.get([STORAGE_KEY, DEBUG_KEY]);
    const stripLinks = result[STORAGE_KEY] ?? false;
    const debugLogging = result[DEBUG_KEY] ?? false;

    const value = stripLinks ? 'withoutLinks' : 'withLinks';
    const radio = document.querySelector(`input[name="defaultMode"][value="${value}"]`);
    if (radio) {
        radio.checked = true;
    }

    const debugCheckbox = document.getElementById('debugLogging');
    if (debugCheckbox) {
        debugCheckbox.checked = debugLogging;
    }
}

async function saveMode() {
    const selected = document.querySelector('input[name="defaultMode"]:checked');
    if (!selected) return;

    const stripLinks = selected.value === 'withoutLinks';
    await browser.storage.local.set({ [STORAGE_KEY]: stripLinks });
    showStatus('Saved.');
}

async function saveDebug() {
    const debugCheckbox = document.getElementById('debugLogging');
    if (!debugCheckbox) return;

    await browser.storage.local.set({ [DEBUG_KEY]: debugCheckbox.checked });
    showStatus('Saved.');
}

function showStatus(message) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.classList.add('visible');
    setTimeout(() => {
        status.classList.remove('visible');
        status.textContent = '';
    }, 1500);
}

document.addEventListener('DOMContentLoaded', () => {
    void loadSettings();

    document.querySelectorAll('input[name="defaultMode"]').forEach((radio) => {
        radio.addEventListener('change', () => void saveMode());
    });

    const debugCheckbox = document.getElementById('debugLogging');
    if (debugCheckbox) {
        debugCheckbox.addEventListener('change', () => void saveDebug());
    }
});
