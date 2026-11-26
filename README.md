# Local LIVE Studio

An independent Windows livestream studio. Version 1.7.0 adds **Broadcast through TikTok LIVE Studio**: compose your scene here, open its output window, capture it in TikTok's official app, and start/end LIVE there. No manual stream key is needed for that route. See [the setup guide](docs/TIKTOK-STUDIO-ROUTE.md) and [the REA investigation](docs/TIKTOK-BROADCAST-ARCHITECTURE.md). This is an official-app handoff, not standalone keyless TikTok broadcasting.

Open **Phone** in the header to connect a phone on the same Wi-Fi. Phone Camera adds its video to a scene. Phone Monitor displays the studio's composed video and audio without a TikTok stream key or public broadcast. A separate official cloudflared helper provides the secure phone page. See [Phone setup](docs/PHONE.md).

TikTok profile linking uses Login Kit and `user.info.basic`. It is separate from the account signed in to the official TikTok app. **Direct RTMP output** uses Start Live / End Live and requires the receiving platform's server URL and key. Login Kit does not create or close TikTok LIVE rooms. The official-app route instead uses TikTok LIVE Studio's own signed-in session, without reading or copying it.

## Download and run

Download the Windows x64 ZIP, extract it completely, and open **Launch Local LIVE Studio.cmd**. Keep the runtime folder together. Electron is included; the livestream encoder is separate.

Install a trusted **FFmpeg build with libx264**, using an installation source linked from [FFmpeg’s download page](https://ffmpeg.org/download.html). The app detects an existing installation, including Windows WinGet’s FFmpeg link. If necessary, select **Choose ffmpeg.exe** in LIVE setup. FFmpeg is already installed on the setup computer. It is not bundled in the ZIP.

## Go live through TikTok LIVE Studio

Choose **Broadcast through TikTok LIVE Studio**, open studio output, then open the official app. Add a Window Capture source in TikTok and select **Local LIVE Studio — Broadcast Output**. Configure sound, check the account and preview, and start/end LIVE in TikTok. No stream key or FFmpeg is required for this route. Closing output does not end the TikTok broadcast.

## Direct RTMP output

1. Prepare your scene using camera, display/window capture, text, colors, images, video, website overlays or local guest cards. Enable the microphone and check the audio meters.
2. For TikTok, link your profile through **Account → Connect TikTok**. Start your configured Login Kit connection backend first.
3. Get the LIVE server URL and stream key from TikTok’s own streaming-software settings, if available for your account. Set the title/category there.
4. Choose **Set up LIVE destination**, select TikTok LIVE, enter those details and save.
5. Choose **Start Live**. Connecting changes to LIVE only when the encoder reports output progress. Check the platform to confirm the broadcast is visible.
6. Choose **End Live** to stop sending. End the room in TikTok too. Obtain fresh TikTok credentials for another broadcast if required.

**Custom RTMP / RTMPS** publishes to another streaming server you control, including loopback test receivers, without requiring a TikTok profile. Read [Livestream setup](docs/LIVESTREAM.md) for connection details, encoder installation, credential handling and limitations.

The app does not implement LIVE chat, remote guest video, paid TikTok gifts, Coins or payouts. Guest boxes are local name cards, and symbolic gifts are visual scene effects with no monetary value.

## TikTok account connection

The included [Login Kit backend](docs/TIKTOK-SETUP.md) keeps the developer secret and TikTok access/refresh tokens outside the desktop renderer. It returns an opaque session and basic profile. The desktop protects its saved link with Windows storage; the backend encrypts its session vault.

Register your own developer app and follow TikTok’s sandbox and production review requirements. The desktop callback is `http://127.0.0.1:*/tiktok/callback/`; the local connection server address is separately `http://127.0.0.1:4317/`. A profile link is verified again before TikTok output starts.

## Local data and Internet access

Projects, local studio accounts, online media cache, preferences, symbolic gifts and protected account links are stored under `%APPDATA%\Local LIVE Studio`. All local studio profiles under the same Windows user share the workspace and TikTok link. Studio sign-out does not disconnect TikTok.

Scene preparation works offline. LIVE output, website overlays and imports need Internet access. Disabling it stops active output. Recordings from older versions remain under the Windows Videos folder and can be opened from Studio settings. Project exports contain scene settings and media paths, not account credentials.

LIVE destinations and stream keys stay in the current main-process session and are not saved in projects or logs. TikTok keys are discarded after ending. The FFmpeg executable path is saved as a local preference. The separate encoder necessarily receives the destination/key in its process arguments, which other software under the same Windows user may inspect.

## Build from source

Use Windows x64 and Node.js 24 or newer.

~~~powershell
npm install
npm test
npm start
~~~

Create a portable runtime and downloadable archives:

~~~powershell
npm run build
npm run dist
~~~

Outputs are under `release/Local LIVE Studio-win32-x64` and `dist/v1.7.0`. Source archives use an explicit file list and exclude accounts, projects, tokens, media caches, recordings and private inspection artifacts.

For a private RTMP integration check, install FFmpeg/ffprobe and run:

~~~powershell
node scripts/check-live-output.cjs
~~~

It generates synthetic media, binds a receiver to 127.0.0.1, verifies H.264/AAC receipt and ends the output. It never publishes to TikTok or another public destination.

## Safety and verification

The studio uses a sandboxed renderer, context isolation, no renderer Node access, restricted IPC and user-action checks. Online sources use isolated offscreen sessions. LIVE media writes are ordered and bounded; stalled output fails instead of buffering indefinitely or silently restarting a broadcast. RTMPS validates certificates. Closing during LIVE asks whether to end; a renderer failure stops the encoder.

Automated tests cover local data, account linking, scene validation, permissions, online sources, packaging and livestream lifecycle. Real encoder and desktop UI checks use private loopback receivers. Actual TikTok broadcast visibility and LIVE-room termination remain dependent on an eligible account and platform-side verification.

See [1.7.0 release notes](docs/RELEASE-NOTES-1.7.0.md), [download instructions](docs/DOWNLOAD.md) and [component notices](THIRD-PARTY-NOTICES.md).
