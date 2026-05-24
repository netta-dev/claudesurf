const params = new URLSearchParams(location.hash.slice(1));
const sessionId = params.get('sessionId') || '';
const startedAt = params.get('startedAt') || '';
const shortId = sessionId.slice(0, 8);
// keep in sync with SESSION_NAME_KEY_PREFIX in background.js
const nameKey = 'sessionName:' + sessionId;

const shortIdEl = document.getElementById('shortId');
const nameEl = document.getElementById('sessionName');
const descEl = document.getElementById('sessionDescription');
const startedAtEl = document.getElementById('startedAt');

shortIdEl.textContent = shortId || '?';
startedAtEl.textContent = startedAt || '?';

function render(meta) {
  const name = meta && meta.name;
  const description = meta && meta.description;
  if (name) {
    nameEl.textContent = name;
    nameEl.hidden = false;
    document.title = name;
  } else {
    nameEl.hidden = true;
    document.title = `ClaudeSurf ${shortId}`;
  }
  if (description) {
    descEl.textContent = description;
    descEl.hidden = false;
  } else {
    descEl.hidden = true;
  }
}

chrome.storage.session.get(nameKey).then((stored) => render(stored[nameKey]));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[nameKey]) {
    render(changes[nameKey].newValue);
  }
});
