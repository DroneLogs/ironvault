'use strict';

const { execFile } = require('child_process');

/**
 * Windows Hello, the Windows answer to Touch ID.
 *
 * There is no Electron API for it, and a native module would mean a compiler on
 * every machine that builds this. Windows exposes the same prompt through WinRT,
 * and Windows PowerShell can reach WinRT, so this drives it through a short
 * script passed as an encoded command. No temporary files, and no execution
 * policy to fight.
 */

const POWERSHELL = 'powershell.exe';
const TIMEOUT_MS = 90000;

const PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($op, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $netTask = $asTask.Invoke($null, @($op))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
$null = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
$null = [Windows.Security.Credentials.UI.UserConsentVerifierAvailability,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
$null = [Windows.Security.Credentials.UI.UserConsentVerificationResult,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
`;

function encode(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function run(script) {
  return new Promise((resolve) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)],
      { timeout: TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          return resolve({ ok: false, output: '', error: (stderr || error.message || '').trim() });
        }
        resolve({ ok: true, output: String(stdout).trim(), error: '' });
      }
    );
  });
}

let availabilityCache = null;

/**
 * Available, DeviceNotPresent, NotConfiguredForUser, DisabledByPolicy,
 * DeviceBusy, or an error string.
 */
async function availability({ refresh = false } = {}) {
  if (process.platform !== 'win32') return { available: false, reason: 'Windows only' };
  if (availabilityCache && !refresh) return availabilityCache;

  const script =
    PRELUDE +
    `
$result = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
Write-Output $result
`;

  const { ok, output, error } = await run(script);
  if (!ok) {
    availabilityCache = { available: false, reason: error || 'Windows Hello could not be reached' };
    return availabilityCache;
  }

  availabilityCache = {
    available: output === 'Available',
    reason:
      output === 'Available'
        ? ''
        : {
            DeviceNotPresent: 'This PC has no Windows Hello hardware',
            NotConfiguredForUser: 'Windows Hello is not set up for this account',
            DisabledByPolicy: 'Windows Hello is disabled by policy',
            DeviceBusy: 'The Windows Hello device is busy'
          }[output] || output || 'Windows Hello is unavailable'
  };
  return availabilityCache;
}

/**
 * Shows the Hello prompt. Resolves { verified: true } only on a real success;
 * a cancel, a timeout, or exhausted retries all come back as false with a
 * reason, and never as an exception.
 */
async function verify(message = 'Unlock your database') {
  if (process.platform !== 'win32') return { verified: false, reason: 'Windows only' };

  const state = await availability();
  if (!state.available) return { verified: false, reason: state.reason };

  // The message is embedded as a single quoted PowerShell literal, so doubling
  // any apostrophe is all the escaping it needs.
  const safeMessage = String(message).replace(/'/g, "''").slice(0, 120);
  const script =
    PRELUDE +
    `
$result = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('${safeMessage}')) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
Write-Output $result
`;

  const { ok, output, error } = await run(script);
  if (!ok) return { verified: false, reason: error || 'Windows Hello failed' };

  if (output === 'Verified') return { verified: true, reason: '' };
  return {
    verified: false,
    reason:
      {
        Canceled: 'Cancelled',
        RetriesExhausted: 'Too many failed attempts',
        DeviceBusy: 'The Windows Hello device is busy',
        DeviceNotPresent: 'This PC has no Windows Hello hardware',
        NotConfiguredForUser: 'Windows Hello is not set up for this account',
        DisabledByPolicy: 'Windows Hello is disabled by policy'
      }[output] || output || 'Windows Hello did not confirm'
  };
}

module.exports = { availability, verify };
