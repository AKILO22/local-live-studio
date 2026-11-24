# Local LIVE Studio 1.4.0

This version adds the TikTok Login Kit connection setup to the independent Windows recording studio.

Download **Local-LIVE-Studio-1.4.0-windows-x64.zip**, extract it completely, and open **Launch Local LIVE Studio.cmd**. The runtime is included. The build is unsigned.

New controls include Connect TikTok, Cancel sign-in, Refresh account, Disconnect, and Forget local link. The app implements official browser authorization with state and desktop PKCE verification, a temporary loopback callback, basic profile display, and an OS-protected saved link. The included Node backend keeps the developer secret and TikTok tokens off the renderer and downloadable app, and handles encrypted storage, refresh rotation, and revocation.

The source asset includes the backend and **docs/TIKTOK-SETUP.md**. No TikTok developer app, client key, client secret, or hosted backend is supplied. Complete registration and configure Login Kit before connecting a real account. Tests use mocked TikTok responses, not a live account.

This is profile authorization only. LIVE broadcasting, remote guest video, chat, paid platform gifts, Coins, and payouts remain unimplemented. Scene editing, local accounts, online overlays, media imports, recording, guest cards, and symbolic local gifts remain included.

GitHub publishing authorization is separate from TikTok setup. Downloading this release does not connect either account.
