# Local LIVE Studio 1.7.0

- Added **Broadcast through TikTok LIVE Studio**, an official-app route without manual stream key entry.
- A separate **Local LIVE Studio — Broadcast Output** window carries the composed scene and optional mixed audio for capture in TikTok LIVE Studio.
- The launcher detects TikTok LIVE Studio and verifies its publisher signature before opening it. A file picker supports other installation locations.
- Output audio starts muted and can be enabled deliberately. The output renderer has no account access or remote web access.
- Direct RTMP output remains available as a separate route.

TikTok's official app must be installed and the account must have LIVE access. Start and end the broadcast there. Local LIVE Studio reports output readiness, not TikTok LIVE status. Closing this studio or its output window does not end a TikTok broadcast. This release does not add standalone keyless TikTok broadcasting.

See [setup](TIKTOK-STUDIO-ROUTE.md) and the [REA evidence report](TIKTOK-BROADCAST-ARCHITECTURE.md).
