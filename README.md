# Local LIVE Studio

An independent Windows desktop studio for scene composition and recording, with Internet access and an optional offline mode. Version 1.4.0 adds TikTok Login Kit connection setup, a private connection backend, basic profile display, saved links, refresh, and disconnection. Register a TikTok developer app and configure the backend before connecting a real account. Earlier features include local guest boxes, symbolic creator-to-guest gifts, studio profiles, visual web overlays, cached media imports, display/window capture, webcam sources, text and color layers, audio mixing, portrait and landscape canvases, and local WebM recording.

## Open the built app

For a downloaded release, use **Local-LIVE-Studio-1.4.0-windows-x64.zip**, extract the entire ZIP, and open **Launch Local LIVE Studio.cmd**. The ZIP includes the Windows runtime. See [Download instructions](docs/DOWNLOAD.md) for requirements and saved-data locations. Downloadable Windows builds are unsigned. Studio gifts are symbolic and local. TikTok profile connection requires your registered app and configured backend.

## Set up TikTok profile connection

Open **Sign in / Account → TikTok → Connection setup**. Save your own connection server URL, then choose **Connect TikTok**. Authorization opens TikTok's official website, with a temporary loopback callback and state/PKCE verification. The Account panel displays the basic profile after successful authorization. **Refresh account** verifies it again; **Disconnect** revokes access through the backend. **Forget local link** clears only this computer and is available offline.

Follow [TikTok setup](docs/TIKTOK-SETUP.md) to register Login Kit, register `http://127.0.0.1:*/tiktok/callback/`, and run the included backend with `npm run broker`. The developer secret and TikTok tokens stay on that backend. The desktop stores an opaque broker session using Windows protected storage. No client secret, production key, real-account authorization, or running backend is included in the download. The connection uses only `user.info.basic`; LIVE broadcasting and paid gifts remain separate.

Double-click `Launch Local LIVE Studio.cmd` after the build completes. It opens `release/Local LIVE Studio-win32-x64/Local LIVE Studio.exe`. Keep the executable beside the other files in its folder. The packaged app runs without Node.js, npm, an account, or an internet connection.

## Give studio gifts to guests

Version 1.3.0 adds **Gifts** beside Account in the top toolbar. This is a self-contained local gifting feature: it records symbolic gifts on this computer. It does not send anything to TikTok or remote viewers, buy or transfer Coins, issue Diamonds, or pay out money. Guest boxes are manually managed name cards, not live guest video connections. Real platform gifting still needs an authorized integration with the platform's supported gifting capabilities; Login Kit authorization alone does not provide that integration.

1. Open **Gifts**. Enter a guest name, choose an empty box from 1–9, and choose **Add guest**. You can also select an empty tile to choose its box.
2. Select an occupied guest box, choose Heart, Rose, Applause, Shining star, Crown, or Rocket, and set a quantity from 1–99. Quick buttons select 1, 5, or 10.
3. Choose **Send**. The selected guest's tile pulses, and a confirmation and history entry appear. The sender is the signed-in studio profile, or Creator when signed out. These are non-monetary studio gifts with no cash value.
4. Choose **Add boxes to scene** to add a Guest boxes & gifts layer to the current scene. You can also find it in Add source. The guest cards and five-second gift animations render directly on the recording canvas. Move, resize, hide, reorder, or remove this layer using the normal source controls. Only one guest-board layer is added by these controls per scene.
5. Close the panel and start recording. Reopen Gifts to send gifts during the recording, then close it to see the recipient's animated card. The panel itself is not recorded unless you separately capture the studio window.

Choose **Remove selected guest** to vacate a box. Prior gifts retain their original recipient; a new occupant cannot receive gifts addressed to the previous guest. The roster and gift history are shared across studio profiles and scenes and survive restarts in `%APPDATA%\Local LIVE Studio\studio-gifts.json`. The interface shows the latest 10 receipts, the bridge returns 30, and the file retains 1,000. The all-time gift quantity counter survives history pruning. Retried requests deduplicate within the retained 1,000 receipts. A failed request can be retried with Send; changing the selected guest, gift, quantity, or creator starts a new request. Gift animations are transient and do not replay on restart.

## Sign in and manage accounts

Choose **Sign in / Account** in the top-right toolbar. Select **Create account**, enter your display name and email address, and choose a dedicated password of 12–128 characters. Confirm the password and choose **Create account**. The account is local to this computer, works offline, and signs in immediately after creation. Your display name then appears in the toolbar. Open it again to view your account or sign out.

After restarting the app, choose **Sign in / Account → Sign in** and enter the same email and password. Local accounts are stored under `%APPDATA%\Local LIVE Studio\accounts.json` using per-account salts and scrypt password hashes. Passwords are never stored in plaintext or sent to an online service. Sign-in attempts are limited. Account operations use the main-process bridge; browser overlays have no account access.

These profiles identify a studio session. They do not provide separate workspaces or protect recordings from someone using the same Windows user. All profiles share the existing project and recordings. The studio also works while signed out. Email addresses are identifiers only: there is no email verification, cloud account, cross-device synchronization, or password-recovery service in this version. A damaged account file does not prevent using the studio.

The **Connected services** section manages the separate TikTok profile link. It starts at **Setup required** when no server is configured, and never asks for a TikTok password. Follow [TikTok setup](docs/TIKTOK-SETUP.md) to activate it. Local studio sign-in and TikTok authorization are separate; neither changes the other's credentials or sign-in state.

## Use Internet features

Internet access is enabled by default. The header shows **Internet enabled**. Open the gear button for Recording settings and choose **Check connection** to make a bounded HTTPS connectivity check. Uncheck **Enable Internet access** to stop web sources and active downloads; local production and recording remain available. The preference is saved for the next launch.

Choose **Add source → Browser / web overlay**, enter an HTTP or HTTPS website or visual-widget URL, then save. Only visible browser layers in the active scene are connected. Select a browser source and choose **Reload website** to retry a failed page. Browser sources are visual only and muted, with up to four active sources at eight frames per second each. They suit overlays and widgets; use a video source for smooth video with audio. Embedded pages have no studio controls, local-file access, camera/microphone permissions, popups, or persistent sign-in storage. Sites needing sign-in, browser interaction, DRM, or special permissions may not work as overlays. No interactive browser or TikTok login screen is included.

Choose **Add source → Online image or video**, select the media type, and paste a direct image/video file URL. The app downloads supported media up to 250 MB and adds it to the scene as a local source. A video webpage URL, such as a TikTok or YouTube watch page, is not a direct media file. At most two imports can run at once; downloads time out after two minutes. Downloaded media is cached in `%APPDATA%\Local LIVE Studio\downloads` and remains usable in offline mode. Removing a source does not delete its cached file.

## Record a session

1. Select a scene or create one with the plus button beside Scenes.
2. Choose Add source. Add a display/window, camera, local image, local video, text, or color panel.
3. Select a source to edit its position, dimensions, opacity, and appearance. Drag visible unlocked sources in the preview. Use Forward and Backward to change layer order.
4. Enable the microphone when needed. Desktop sound is requested when adding a display/window with Capture desktop audio checked. To change that capture choice, reconnect the source.
5. Choose a landscape or portrait canvas. Recording settings provide 24, 30, or 60 fps and four video bitrate options.
6. Choose Start recording. You can switch scenes, pause, and resume. Choose Stop & save recording when finished.
7. Open the Recordings folder or use Show in folder beside a recording.

WebM recordings contain VP9 or VP8 video with Opus audio, according to the codecs available on the system. VLC and desktop browsers can play these files. Display capture availability, desktop sound, camera access, and encoder performance depend on Windows and the selected device. Capture devices reconnect through an explicit user action after a restart.

Recordings are saved under the Windows Videos folder in `Local LIVE Studio`. The application shows the exact path in Recording settings. The workspace is saved under `%APPDATA%\Local LIVE Studio\project.json`, with a previous valid copy beside it. Internet preferences are in `preferences.json` in the same folder. Locally imported media stays at its original path; online imports use the download cache. Keep those files available when reopening or transferring a project. Open project and Export project use JSON files.

## Build from source

Use Node.js 22.12 or newer with npm. Installing dependencies and obtaining the Electron runtime requires internet access once.

```powershell
Set-Location 'C:\path\to\local-live-studio'
npm install
node node_modules/electron/install.js
npm test
npm start
```

Create the portable Windows application with the following command.

```powershell
npm run build
```

The executable, its Chromium runtime, application code, and local assets are included in the resulting release folder. The distributed source excludes private inspection captures and local verification artifacts.

## Prepare download archives and publish to GitHub

Close the running app before replacing a build. Run `npm run release` to test, build, and generate a Windows ZIP, a curated source ZIP, checksums, and a release manifest under `dist/v1.4.0`. Existing versioned archives are preserved; use a new release version for an update. `npm run dist` creates archives from an already built runtime.

The source archive includes the original application code, tests, build scripts, notices, and this guide. It excludes accounts, projects, downloaded media, recordings, inspection captures, and development caches. The Windows ZIP contains the complete runtime plus launch and download instructions.

After connecting your own GitHub account with GitHub CLI, run `./scripts/publish-github.ps1 -Repository 'OWNER/local-live-studio'` from PowerShell. Omitting Repository uses the authenticated account's `local-live-studio` repository. The script verifies release checksums and source hashes, runs the tests, commits only the curated source file list, creates a public repository when needed, pushes main, uploads the assets to a draft release, then publishes it. It does not replace existing public release assets or force-push a repository.

The included GitHub Actions workflow runs the Windows tests and archive build on main pushes, pull requests, and manual runs. It keeps build artifacts for 30 days; publishing a permanent GitHub Release is handled by the publish script. GitHub-hosted builds still need a successful remote run before their status can be claimed as verified.

## Implementation

`main.cjs` owns the Electron window, local files, capture selection, recording writes, and process status. The sandboxed preload exposes a limited IPC bridge. `renderer.js` composites sources on a canvas and combines audio through Web Audio before handing recording chunks to the main process. The recorder streams chunks to disk and preserves partial recordings after an interrupted session. `lib/` contains storage, media, recording, and access-policy code.

`lib/online.cjs` owns isolated, sandboxed offscreen browser sessions and bounded streaming downloads. Remote pages send rendered PNG frames to the studio, rather than running in its privileged interface. The studio interface retains its restrictive content policy. Turning Internet access off revokes new requests and closes online contexts. TLS validation remains enabled. There is no automatic connectivity polling, broadcasting, or upload of projects and recordings. A configured web page can make its normal website requests while its source is active. Rendering follows Electron's [offscreen rendering API](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering/); downloads use its [session API](https://www.electronjs.org/docs/latest/api/session).

TikTok profile authorization is implemented through the configured connection backend. TikTok broadcasting, chat, paid gifts, and viewer counts are not included. Virtual-camera drivers and native game-capture hooks also remain outside the current scope. See `docs/TIKTOK-SETUP.md` for credentials, deployment, and verification limits.
