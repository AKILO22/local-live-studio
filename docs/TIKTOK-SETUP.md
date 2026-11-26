# Set up the TikTok connection

Local LIVE Studio 1.4.0 includes Login Kit authorization, basic profile display, saved connections, profile refresh, and disconnection. No developer app or production credentials are supplied. Register a TikTok app and configure the included backend before connecting a real account.

The profile connection requests only `user.info.basic` and displays the profile name. Version 1.5.0 adds a separate RTMP/RTMPS broadcaster configured with the platform’s LIVE server URL and stream key; see [Livestream setup](LIVESTREAM.md). Login Kit itself does not supply broadcast credentials or LIVE room management. Chat, remote guest video, paid TikTok gifts, Coins, and payouts remain unimplemented.

## Register your developer app

1. Open [TikTok for Developers](https://developers.tiktok.com/) and follow [Register Your App](https://developers.tiktok.com/docs/en/getting-started-create-an-app).
2. Configure Login Kit for Desktop and `user.info.basic`. Complete the sandbox, test-user, and review requirements shown in your developer console.
3. Register this desktop redirect URI exactly: `http://127.0.0.1:*/tiktok/callback/`.
4. Keep the Client key and Client secret in your private backend configuration. Never put the secret into the desktop app, GitHub, or chat.

The wildcard lets the desktop app bind an available loopback port. [TikTok's Desktop guide](https://developers.tiktok.com/docs/en/login-kit-desktop) documents loopback callbacks, state verification, and a SHA-256 **hex** PKCE challenge. This implementation follows those requirements and opens only TikTok's official authorization endpoint.

## Run the backend locally

Use the source archive or repository, Node.js 24 or newer, and PowerShell. The broker uses Node's built-in modules and has no extra runtime npm dependencies. Enter private values yourself on the server computer.

```powershell
Set-Location 'C:\path\to\local-live-studio'
$env:TIKTOK_CLIENT_KEY = '<your registered client key>'
$tiktokSecret = Read-Host 'TikTok client secret' -AsSecureString
$env:TIKTOK_CLIENT_SECRET = [Net.NetworkCredential]::new('', $tiktokSecret).Password
# First setup only: keep this key private and reuse it after every restart.
$env:TIKTOK_VAULT_KEY = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
$env:TIKTOK_VAULT_FILE = Join-Path (Get-Location).Path 'data\tiktok-vault.json'
$env:TIKTOK_BROKER_PORT = '4317'
npm run broker
```

Leave the process running while using the connection. It listens on `127.0.0.1` by default. Reuse the same vault key and persistent vault file after a restart. The key-generation line is for first setup; regenerating the key makes existing sessions unreadable. Environment values in a temporary PowerShell session disappear when it closes. Keep a protected backup of the key and configure persistent deployments through your host's secret manager.

The service refuses to start without a client key, client secret, and 32-byte base64 vault key. Startup does not open a sign-in page or print secrets.

## Connect the desktop app

1. Open **Sign in / Account → TikTok → Connection setup**.
2. Enter `http://127.0.0.1:4317/` for local development, or your own HTTPS connection server URL, and choose **Save connection server**.
3. Enable Internet access in Recording settings, then choose **Connect TikTok**.
4. Sign in on TikTok's own website and review its basic-profile permission. The studio never asks for your TikTok password.
5. After approval, the browser returns to the temporary loopback listener. A verified response changes Account to **Connected** and shows the profile name.
6. **Refresh account** verifies the profile again. After restarting the studio, or in offline mode, the label is **Saved link** until refreshed.
7. **Disconnect** asks TikTok to revoke authorization before clearing the local link. **Forget local link** works offline and only clears this computer; it does not revoke access on TikTok. You can separately remove the app in TikTok's connected-app settings.

The TikTok link is shared by studio profiles under the same Windows user. Local studio sign-out does not sign out of TikTok. Disconnect or forget the saved link before changing connection servers or connecting another account.

## Deploy for other users

Run `server/tiktok-broker.cjs` on a Node.js host behind an HTTPS reverse proxy. Configure its private environment variables, persistent vault file, and stable encryption key. The default loopback binding works when the proxy runs on the same host. Set `TIKTOK_BROKER_HOST` only according to your host's deployment configuration. A subpath deployment requires the reverse proxy to strip that prefix before forwarding requests. HTTP server URLs are accepted by the desktop app only for localhost development.

GitHub Releases can distribute the desktop app and backend source. The backend needs a running Node service and private secret configuration; uploading a ZIP to GitHub does not deploy that service.

This initial backend uses one process, an encrypted file vault, at most 1,000 broker sessions, and per-peer request limits. Run one process per vault file. For a larger service, use a transactional shared database and distributed rate limits. Forwarded IP headers are not automatically trusted.

## Storage and security

- Desktop authorization uses fresh random state and PKCE values, a three-minute timeout, and a temporary IPv4 loopback listener. Duplicate callback fields and invalid state are rejected. The listener closes on completion or cancellation.
- The backend exchanges the authorization code and verifier with TikTok. It returns an opaque broker session and a display name, never TikTok access or refresh tokens. The developer secret stays on the server.
- Server tokens are encrypted with AES-256-GCM. The raw broker bearer token is not stored in the server vault; the lookup uses its SHA-256 hash. Sessions last at most 30 days or the remaining refresh authorization, whichever is shorter.
- `%APPDATA%\Local LIVE Studio\tiktok-settings.json` stores the public connection URL. `tiktok-link.bin` holds the opaque session and cached profile through Electron's OS-protected storage. On Windows this uses DPAPI, which protects against other Windows users, not every process running as the same user. Bearer credentials never enter the renderer, project exports, or gift history.
- The backend refreshes on demand before profile requests when the access token is near expiry. It uses returned expiry values and commits the rotated refresh token before another request proceeds. A failed rotation write blocks reuse in the running process and triggers best-effort revocation. Fix storage and reconnect; an uncommitted rotation cannot be recovered after a process restart.
- Outgoing endpoints are fixed to TikTok's OAuth token, basic profile, and revoke APIs. Redirects are rejected, responses are bounded, and raw upstream error text is not echoed or logged. Browser-origin requests to the broker are rejected.
- Failed or interrupted exchanges are cleaned up on a best-effort basis. If connectivity disappears after TikTok authorizes the app, users may need to remove the authorization in TikTok's connected-app settings.

Primary references: [Desktop Login Kit](https://developers.tiktok.com/docs/en/login-kit-desktop), [token lifecycle](https://developers.tiktok.com/docs/en/oauth-user-access-token-management), [token exchange](https://developers.tiktok.com/docs/en/oauth-get-a-user-access-token), [refresh](https://developers.tiktok.com/docs/en/oauth-refresh-a-user-access-token), [revocation](https://developers.tiktok.com/docs/en/oauth-revoke-a-user-access-token), [basic profile](https://developers.tiktok.com/docs/en/tiktok-api-v2-get-user-info), and [Electron protected storage](https://www.electronjs.org/docs/latest/api/safe-storage).

## Verification scope

Automated tests use synthetic credentials and mocked TikTok responses. They exercise real loopback HTTP between the desktop module and backend, encrypted persistence, state and PKCE verification, refresh rotation, revocation, offline cancellation, timeouts, and connection UI states.

On November 25, 2026, an authorized sandbox account completed TikTok sign-in in the installed Windows app. The native Account panel showed Connected, and Refresh account completed successfully with the same profile. The product website's ownership verification also completed. These checks validate this installation's profile connection; they do not establish production app approval or TikTok LIVE broadcast permission. Public TikTok transmission has not been verified because no platform-issued LIVE server URL and stream key have been obtained.
