/**
 * The popup: what the user actually touches.
 *
 * It asks the service worker for entries matching the current tab, and fills
 * the page when one is clicked. Passwords live here only for as long as the
 * popup is open, and a popup closes the moment it loses focus.
 */

const els = {
  site: document.getElementById('site'),
  message: document.getElementById('message'),
  connect: document.getElementById('connect'),
  connectButton: document.getElementById('connect-button'),
  entries: document.getElementById('entries'),
  empty: document.getElementById('empty'),
  refresh: document.getElementById('refresh')
};

function ask(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

function askTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (reply) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(reply);
    });
  });
}

function show(text, kind) {
  els.message.textContent = text;
  els.message.className = kind || '';
  els.message.hidden = !text;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function entryRow(entry, tab) {
  const li = document.createElement('li');

  const button = document.createElement('button');
  button.className = 'entry';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = entry.title || '(no title)';

  const user = document.createElement('span');
  user.className = 'username';
  user.textContent = entry.username || 'no username';

  button.append(title, user);
  button.addEventListener('click', async () => {
    const result = await askTab(tab.id, {
      type: 'fill',
      username: entry.username,
      password: entry.password
    });
    if (!result || !result.ok) {
      show(result?.error || 'This page could not be filled', 'error');
      return;
    }
    if (!result.data.filled) {
      show(result.data.reason || 'Nothing to fill here', 'error');
      return;
    }
    window.close();
  });

  li.append(button);
  return li;
}

async function load() {
  show('');
  els.entries.hidden = true;
  els.empty.hidden = true;
  els.connect.hidden = true;
  els.entries.replaceChildren();

  const tab = await currentTab();
  if (!tab || !/^https?:/i.test(tab.url || '')) {
    show('Open a web page to fill a login.');
    return;
  }
  els.site.textContent = hostOf(tab.url);

  const status = await ask({ type: 'status' });
  if (!status.ok) {
    if (status.code === 'not-associated') {
      els.connect.hidden = false;
      return;
    }
    show(status.error, 'error');
    return;
  }
  if (!status.data.unlocked) {
    show('Propolis is locked. Unlock it and press Refresh.', 'error');
    return;
  }

  const found = await ask({ type: 'logins', url: tab.url });
  if (!found.ok) {
    show(found.error, 'error');
    return;
  }
  const logins = found.data.logins || [];
  if (!logins.length) {
    els.empty.hidden = false;
    return;
  }
  for (const entry of logins) els.entries.append(entryRow(entry, tab));
  els.entries.hidden = false;
}

els.connectButton.addEventListener('click', async () => {
  els.connectButton.disabled = true;
  show('Look at Propolis, it is asking you to approve this browser.');
  const result = await ask({ type: 'associate' });
  els.connectButton.disabled = false;
  if (!result.ok) {
    show(result.error, 'error');
    return;
  }
  load();
});

els.refresh.addEventListener('click', load);
load();
