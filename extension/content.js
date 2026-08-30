/**
 * Finding the login form on a page, and filling it.
 *
 * Filling is only ever started by the user, from the popup. Nothing here reads
 * the page until asked and nothing is sent anywhere; the script exists so that
 * the popup, which cannot touch the page directly, has something that can.
 *
 * Sites do not agree on how a login form looks, so this guesses, and the guesses
 * are ordered by how much they can be trusted: what the browser's own autofill
 * hints say first, then field names, then position on the page.
 */

/** Visible in the ordinary sense: laid out, not hidden, not zero sized. */
function isVisible(el) {
  if (!el || el.disabled || el.readOnly) return false;
  const style = getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
  const box = el.getBoundingClientRect();
  return box.width > 1 && box.height > 1;
}

function passwordFields() {
  return Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible);
}

/**
 * The username field is whatever plausible text input sits closest above the
 * password box. Walking backwards through the form beats guessing by name,
 * because a field called "email" three sections up is usually not the one.
 */
function usernameFor(passwordField) {
  const form = passwordField.form || document;
  const inputs = Array.from(form.querySelectorAll('input')).filter(isVisible);
  const index = inputs.indexOf(passwordField);

  const usable = (el) => {
    const type = (el.type || 'text').toLowerCase();
    return ['text', 'email', 'tel', 'search', ''].includes(type);
  };

  for (let i = index - 1; i >= 0; i--) {
    if (usable(inputs[i])) return inputs[i];
  }
  // Some sites put the username after the password in the markup even though it
  // reads above it, so having failed going up, try going down.
  for (let i = index + 1; i < inputs.length; i++) {
    if (usable(inputs[i])) return inputs[i];
  }
  return null;
}

function autocompleteHint(el) {
  return String(el.getAttribute('autocomplete') || '').toLowerCase();
}

/**
 * Picks the password box to fill when a page has several.
 *
 * A change password form has two or three, and filling those with the current
 * password is worse than doing nothing. So a field marked new-password is
 * skipped, and if the remaining ones are ambiguous, the first is used, which is
 * the sign in box on every layout worth supporting.
 */
function chooseTarget() {
  const fields = passwordFields();
  if (!fields.length) return null;
  const current = fields.filter((f) => !/new-password/.test(autocompleteHint(f)));
  const chosen = current.length ? current[0] : fields[0];
  return { password: chosen, username: usernameFor(chosen) };
}

/**
 * Sets a value the way a person would, so frameworks notice.
 *
 * React and friends track their own copy of the value and ignore a plain
 * assignment, so the native setter is called directly and the events a real
 * keystroke would raise are dispatched afterwards. Without this the field looks
 * filled and the site submits an empty string.
 */
function setValue(el, value) {
  const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (setter && setter.set) setter.set.call(el, value);
  else el.value = value;

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function fill({ username, password }) {
  const target = chooseTarget();
  if (!target) return { filled: false, reason: 'No password box was found on this page' };

  if (target.username && username) {
    target.username.focus();
    setValue(target.username, username);
  }
  if (password) {
    target.password.focus();
    setValue(target.password, password);
  }
  target.password.blur();
  return {
    filled: true,
    username: Boolean(target.username && username),
    password: Boolean(password)
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
  if (message.type === 'has-login-form') {
    sendResponse({ ok: true, data: { present: Boolean(chooseTarget()) } });
    return false;
  }
  if (message.type === 'fill') {
    try {
      sendResponse({ ok: true, data: fill(message) });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return false;
  }
  return false;
});
