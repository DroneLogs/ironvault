# The Propolis browser extension

Fills passwords from your Propolis vault into web pages.

## What it does, and what it cannot do

The extension never holds your passwords. It asks Propolis for the ones matching
the page you are on, one page at a time, and forgets them when the popup closes.
Nothing is stored in the browser and nothing is sent over the internet.

Propolis will only answer a browser you have approved, and only while your
database is unlocked. Lock it and the extension goes quiet.

Passwords come back only for a site the entry actually belongs to, matched on the
host and on whole labels. An entry for `github.com` covers `login.github.com` and
never covers `github.com.evil.example`.

## Setting it up

Three steps, in this order.

**1. Switch it on in Propolis.** Settings, then Browser extension, then
"Allow browsers to connect".

**2. Load the extension.** In your browser open the extensions page
(`chrome://extensions` in Chrome, `edge://extensions` in Edge), switch on
developer mode, choose **Load unpacked**, and select this folder.

The browser will show an id on the extension's card, 32 letters. Copy it.

**3. Tell Propolis the id.** Back in Settings, pick your browser, paste the id,
and press **Set up**. Then restart the browser.

Now press the Propolis button in the browser toolbar and choose **Connect**.
Propolis will ask you to approve it. That question appears in Propolis itself,
never in the browser, so a web page cannot talk you into approving something.

## Using it

Press the toolbar button on a page with a login form. Entries matching that site
are listed; click one and the form is filled.

If it says Propolis is locked, unlock Propolis and press Refresh.

## Disconnecting

Settings, then Browser extension, then Disconnect. The browser can ask again, and
you will be asked to approve it again.

## How it works underneath

```
extension  <-- native messaging (stdio) -->  host  <-- named pipe -->  Propolis
```

The browser will not let an extension talk to an application directly, so it
launches a small helper and passes messages through it. That helper holds no keys
and cannot read anything going past: the extension encrypts to Propolis and
Propolis encrypts back, using X25519 to agree a key and AES-256-GCM for the
messages. Replacing the helper gains an attacker nothing.

## Requirements

Chrome 133 or newer, or a browser of the same age, because the key agreement uses
X25519 in the browser's own crypto. Also Edge, Brave and Vivaldi. Firefox is
registered differently and is set up the same way from the same screen.

## Not yet

Passkeys. The groundwork is that this extension exists at all, since a desktop
application cannot answer a WebAuthn request on its own and needs an extension in
the page to do it. That is the next piece, not this one.
