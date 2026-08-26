'use strict';

const { execFile } = require('child_process');

/**
 * Auto-Type: the Windows equivalent of AutoFill.
 *
 * You focus the app or page you are signing into, press the hotkey, and
 * Ironvault matches the foreground window against your entries and types the
 * credentials into it. Nothing is injected into other processes: the keystrokes
 * go through the same SendKeys path a macro would use, so the target sees
 * ordinary typing.
 */

const POWERSHELL = 'powershell.exe';
const DEFAULT_SEQUENCE = '{USERNAME}{TAB}{PASSWORD}{ENTER}';

function encode(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function run(script, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)],
      { timeout, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) return resolve({ ok: false, output: '', error: (stderr || error.message || '').trim() });
        resolve({ ok: true, output: String(stdout).trim(), error: '' });
      }
    );
  });
}

/* ------------------------------------------------------- foreground window */

const WINDOW_SCRIPT = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class IvWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$h = [IvWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[IvWin]::GetWindowText($h, $sb, 512) | Out-Null
$pid = 0
[IvWin]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null
$name = ''
try { $name = (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch { }
$out = @{ title = $sb.ToString(); process = $name; handle = [string]$h }
$out | ConvertTo-Json -Compress
`;

async function foregroundWindow() {
  const { ok, output, error } = await run(WINDOW_SCRIPT, 8000);
  if (!ok) return { title: '', process: '', error };
  try {
    const parsed = JSON.parse(output);
    return { title: String(parsed.title || ''), process: String(parsed.process || ''), handle: parsed.handle };
  } catch {
    return { title: '', process: '', error: 'Could not read the foreground window' };
  }
}

/* ----------------------------------------------------------------- matching */

function hostOf(url) {
  if (!url) return '';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : 'https://' + url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * Scores each candidate against the window title. A URL host that appears in
 * the title is the strongest signal, then the entry title, then the username.
 */
function bestMatch(entries, window) {
  const title = String(window.title || '').toLowerCase();
  if (!title) return null;

  let best = null;
  for (const entry of entries) {
    let score = 0;
    const host = hostOf(entry.url).toLowerCase();
    if (host && title.includes(host)) score += 100 + host.length;
    if (host) {
      const bare = host.replace(/\.[a-z.]+$/, '');
      if (bare.length > 2 && title.includes(bare)) score += 40 + bare.length;
    }
    const entryTitle = String(entry.title || '').toLowerCase();
    if (entryTitle.length > 2 && title.includes(entryTitle)) score += 60 + entryTitle.length;
    if (entry.autoTypeWindow) {
      // A window pattern on the entry wins outright when it matches.
      const pattern = String(entry.autoTypeWindow).toLowerCase().replace(/\*/g, '');
      if (pattern && title.includes(pattern)) score += 500;
    }
    if (score > 0 && (!best || score > best.score)) best = { entry, score };
  }
  return best;
}

/* ------------------------------------------------------------------ typing */

/** SendKeys treats these as control characters, so they get braced. */
function escapeForSendKeys(text) {
  return String(text).replace(/[+^%~(){}[\]]/g, (c) => '{' + c + '}');
}

/**
 * Turns a KeePass style sequence into SendKeys input. Unknown placeholders are
 * dropped rather than typed literally, so a stray {FOO} never leaks into a
 * password field.
 */
function buildSendKeys(sequence, values) {
  const parts = [];
  const pattern = /\{([^}]+)\}|([^{]+)/g;
  let match;

  while ((match = pattern.exec(sequence)) !== null) {
    if (match[2] !== undefined) {
      parts.push({ type: 'keys', value: escapeForSendKeys(match[2]) });
      continue;
    }
    const token = match[1].trim();
    const upper = token.toUpperCase();

    const delay = /^DELAY[ =](\d+)$/i.exec(token);
    if (delay) {
      parts.push({ type: 'sleep', value: Math.min(5000, parseInt(delay[1], 10)) });
      continue;
    }

    const named = {
      USERNAME: values.username,
      PASSWORD: values.password,
      URL: values.url,
      TITLE: values.title,
      NOTES: values.notes,
      TOTP: values.totp
    };
    if (upper in named) {
      parts.push({ type: 'keys', value: escapeForSendKeys(named[upper] || '') });
      continue;
    }

    const literal = {
      TAB: '{TAB}',
      ENTER: '{ENTER}',
      SPACE: ' ',
      ESC: '{ESC}',
      BACKSPACE: '{BACKSPACE}',
      DELETE: '{DELETE}',
      HOME: '{HOME}',
      END: '{END}',
      UP: '{UP}',
      DOWN: '{DOWN}',
      LEFT: '{LEFT}',
      RIGHT: '{RIGHT}'
    }[upper];
    if (literal) parts.push({ type: 'keys', value: literal });
    // anything else is intentionally ignored
  }

  return parts;
}

/**
 * Types the sequence into whatever has focus. The caller is responsible for
 * making sure that is the right window, since this deliberately does not steal
 * focus itself.
 */
async function type(sequence, values, { initialDelayMs = 250 } = {}) {
  const parts = buildSendKeys(sequence || DEFAULT_SEQUENCE, values);
  if (!parts.length) throw new Error('That auto-type sequence produced nothing to send');

  const lines = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Start-Sleep -Milliseconds ' + Math.max(0, Math.min(3000, initialDelayMs))
  ];
  for (const part of parts) {
    if (part.type === 'sleep') {
      lines.push('Start-Sleep -Milliseconds ' + part.value);
    } else if (part.value) {
      // Single quoted, with apostrophes doubled: the value never gets parsed.
      lines.push("[System.Windows.Forms.SendKeys]::SendWait('" + part.value.replace(/'/g, "''") + "')");
      lines.push('Start-Sleep -Milliseconds 25');
    }
  }

  const { ok, error } = await run(lines.join('\n'), 30000);
  if (!ok) throw new Error(error || 'Auto-type failed');
  return { ok: true, steps: parts.length };
}

module.exports = {
  foregroundWindow,
  bestMatch,
  buildSendKeys,
  escapeForSendKeys,
  type,
  hostOf,
  DEFAULT_SEQUENCE
};
