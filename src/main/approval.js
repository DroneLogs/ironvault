'use strict';

/**
 * Asking the user to approve something, in the app's own window.
 *
 * The question has to be answered in Propolis rather than in the browser or
 * over the network, because the thing doing the asking is exactly the thing
 * that must not be able to answer. That part was always right.
 *
 * What was wrong was how it looked. It was a bare Windows message box, in the
 * system's colours, with no sign it came from the app the user was already
 * looking at. A prompt that looks like it wandered in from somewhere else is
 * one people click through without reading, and this is the single prompt in
 * the app where reading it is the whole point: answering yes hands a browser
 * extension every password in the database.
 *
 * So it is drawn by the renderer now, like every other dialog. The native box
 * stays as the fallback for when there is no window to draw into, because a
 * question that cannot be displayed must still be answerable rather than
 * silently granted.
 */

const { dialog } = require('electron');

const pending = new Map();
let nextId = 1;

// Long enough to walk back to the computer, short enough that a prompt nobody
// answers cannot hold a request open indefinitely.
const TIMEOUT_MS = 2 * 60 * 1000;

function usable(win) {
  return win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed() ? win : null;
}

function nativeAsk(win, spec) {
  return dialog
    .showMessageBox(usable(win), {
      type: 'question',
      buttons: [spec.confirm, spec.cancel],
      defaultId: 1,
      cancelId: 1,
      title: spec.title,
      message: spec.message,
      detail: spec.detail
    })
    .then(({ response }) => response === 0);
}

/**
 * Puts the question to the user and resolves with what they chose.
 *
 * Anything that is not a clear yes is a no: a timeout, a window that will not
 * take the message, a reply for an id nobody is waiting on.
 */
function ask(win, spec) {
  const target = usable(win);
  if (!target) return nativeAsk(null, spec);

  // Nobody can answer a question they cannot see. This is also the only part
  // of the flow the user did not start, so it has to come to them.
  try {
    if (target.isMinimized()) target.restore();
    if (!target.isVisible()) target.show();
    target.focus();
  } catch {
    // A window that will not come forward can still be asked.
  }

  const id = nextId++;
  return new Promise((resolve) => {
    const settle = (approved) => {
      if (!pending.has(id)) return;
      clearTimeout(timer);
      pending.delete(id);
      resolve(approved);
    };
    const timer = setTimeout(() => settle(false), TIMEOUT_MS);
    if (timer.unref) timer.unref();
    pending.set(id, settle);

    try {
      target.webContents.send('approval', { ...spec, id });
    } catch {
      settle(false);
    }
  });
}

/** The renderer reporting what the user pressed. */
function answer({ id, approved } = {}) {
  const settle = pending.get(Number(id));
  if (!settle) return { ok: false };
  settle(approved === true);
  return { ok: true };
}

module.exports = { ask, answer };
