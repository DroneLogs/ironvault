/**
 * The popup: what the user actually touches.
 *
 * It asks the service worker for entries matching the current tab, and fills
 * the page when one is clicked. Passwords live here only for as long as the
 * popup is open, and a popup closes the moment it loses focus.
 *
 * Copying is deliberately not done here. The popup asks Propolis to copy, and
 * Propolis puts the value on the clipboard itself, so a password is never held
 * in the browser for the sake of a copy, and it is cleared on the same timer as
 * anything copied inside the app.
 */

const els = {
  site: document.getElementById('site'),
  state: document.getElementById('state'),
  message: document.getElementById('message'),
  connect: document.getElementById('connect'),
  connectButton: document.getElementById('connect-button'),
  searchWrap: document.getElementById('search-wrap'),
  search: document.getElementById('search'),
  entries: document.getElementById('entries'),
  empty: document.getElementById('empty'),
  count: document.getElementById('count'),
  refresh: document.getElementById('refresh')
};

/** Everything found for this page, before the filter box narrows it. */
let allLogins = [];
let currentTab = null;

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

/** Says something happened, then gets out of the way. */
let flashTimer = null;
function flash(text) {
  show(text, 'good');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => show(''), 2200);
}

function setState(label, kind) {
  els.state.textContent = label;
  els.state.className = 'pill' + (kind ? ' ' + kind : '');
  els.state.hidden = !label;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function tabNow() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/* ------------------------------------------------------------------- rows */

function action(label, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
}

function entryRow(entry) {
  const li = document.createElement('li');
  li.className = 'card';

  const fill = document.createElement('button');
  fill.className = 'entry';
  fill.type = 'button';
  fill.title = 'Fill this page';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = entry.title || '(no title)';

  const user = document.createElement('span');
  user.className = 'username';
  user.textContent = entry.username || 'no username';

  fill.append(title, user);
  fill.addEventListener('click', async () => {
    const result = await askTab(currentTab.id, {
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

  const copy = async (field, label) => {
    const reply = await ask({ type: 'copy', uuid: entry.uuid, field });
    if (!reply || !reply.ok) {
      show((reply && reply.error) || 'Could not copy', 'error');
      return;
    }
    const seconds = reply.data && reply.data.clearAfter;
    flash(seconds ? label + ' copied, clears in ' + seconds + 's' : label + ' copied');
  };

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    action('User', 'Copy the username', () => copy('username', 'Username')),
    action('Password', 'Copy the password', () => copy('password', 'Password'))
  );

  if (entry.hasTotp) {
    actions.append(
      action('Code', 'Copy the one time code', async () => {
        const reply = await ask({ type: 'totp', uuid: entry.uuid });
        if (!reply || !reply.ok) {
          show((reply && reply.error) || 'No one time code', 'error');
          return;
        }
        await navigator.clipboard.writeText(reply.data.code);
        flash('Code copied, good for ' + reply.data.seconds + 's');
      })
    );
  }

  li.append(fill, actions);
  return li;
}

/** Draws whatever survives the filter box. */
function render() {
  const needle = (els.search.value || '').trim().toLowerCase();
  const shown = needle
    ? allLogins.filter(
        (e) =>
          (e.title || '').toLowerCase().includes(needle) ||
          (e.username || '').toLowerCase().includes(needle)
      )
    : allLogins;

  els.entries.replaceChildren();
  for (const entry of shown) els.entries.append(entryRow(entry));
  els.entries.hidden = shown.length === 0;

  if (allLogins.length === 0) {
    els.empty.textContent = 'No entries in your vault match this site.';
    els.empty.hidden = false;
  } else if (shown.length === 0) {
    els.empty.textContent = 'Nothing matches that.';
    els.empty.hidden = false;
  } else {
    els.empty.hidden = true;
  }

  if (!allLogins.length) els.count.textContent = '';
  else if (needle) els.count.textContent = shown.length + ' of ' + allLogins.length;
  else els.count.textContent = allLogins.length + (allLogins.length === 1 ? ' entry' : ' entries');
}

/* ------------------------------------------------------------------- load */

async function load() {
  show('');
  setState('');
  els.entries.hidden = true;
  els.empty.hidden = true;
  els.connect.hidden = true;
  els.searchWrap.hidden = true;
  els.count.textContent = '';
  els.entries.replaceChildren();
  allLogins = [];

  currentTab = await tabNow();
  if (!currentTab || !/^https?:/i.test(currentTab.url || '')) {
    show('Open a web page to fill a login.');
    return;
  }
  els.site.textContent = hostOf(currentTab.url);

  const status = await ask({ type: 'status' });
  if (!status.ok) {
    if (status.code === 'not-associated') {
      setState('not connected', 'shut');
      els.connect.hidden = false;
      return;
    }
    setState('no app', 'shut');
    show(status.error, 'error');
    return;
  }
  if (!status.data.unlocked) {
    setState('locked', 'shut');
    show('Propolis is locked. Unlock it and press Refresh.', 'error');
    return;
  }
  setState(status.data.database || 'unlocked', 'open');

  const found = await ask({ type: 'logins', url: currentTab.url });
  if (!found.ok) {
    show(found.error, 'error');
    return;
  }
  allLogins = found.data.logins || [];
  // A filter box for two entries is clutter; for fifteen it is the point.
  els.searchWrap.hidden = allLogins.length < 5;
  render();
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

els.search.addEventListener('input', render);
els.refresh.addEventListener('click', load);
load();
