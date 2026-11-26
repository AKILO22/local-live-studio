# Download and run Local LIVE Studio 1.6.0

1. Download `Local-LIVE-Studio-1.6.0-windows-x64.zip`. GitHub's automatic “Source code” archives are for developers.
2. Extract the entire ZIP.
3. Open **Launch Local LIVE Studio.cmd**, or open the **Local LIVE Studio** folder and run **Local LIVE Studio.exe**.
4. Keep the extracted runtime files together.

This is a Windows 10/11 x64 portable application. Electron is included. The build is unsigned and has no verified publisher certificate. Other operating systems and ARM64 have not been validated.

## Streaming encoder

For phone features, open **Phone** in the header, choose the official Cloudflare connection helper if not detected, and create a phone link. Scan its QR code, choose Phone Camera, Phone Monitor, or Camera + Monitor, then approve the phone on the computer. Both devices should use the same Wi-Fi. Phone Monitor works without a TikTok stream key and does not need FFmpeg. Read **docs/PHONE.md** for the full workflow.

LIVE output needs a separate **FFmpeg installation with libx264**. It is already installed on the setup computer. On another computer, install a trusted build from a source linked by [FFmpeg](https://ffmpeg.org/download.html). The app detects FFmpeg automatically, including the usual Windows WinGet link. If it is not found, choose **Set up LIVE destination → Choose ffmpeg.exe**. No FFmpeg binary is bundled in the ZIP.

## Start and end LIVE

Prepare the scene and audio, link your TikTok profile in Account, and get a current LIVE server URL and stream key from TikTok if that access is available to your account. Save them in **Set up LIVE destination**, then choose **Start Live**. **End Live** replaces it while transmitting. Also end the broadcast in TikTok's app or LIVE dashboard.

Profile sign-in does not grant broadcasting permission or supply the stream key. The app cannot create or terminate a TikTok LIVE room through Login Kit. It sends and stops RTMP/RTMPS output. Read **docs/LIVESTREAM.md** for full instructions.

Custom RTMP / RTMPS can send to another server you control without a TikTok profile. Preparing scenes works offline; actual output needs connectivity.

## Accounts and data

Local studio profiles work on this Windows account and are separate from TikTok. Workspace data and protected connections are under `%APPDATA%\Local LIVE Studio`. Previous recordings remain in your Windows Videos folder; open them through Studio settings. Project files do not contain LIVE keys.

TikTok linking needs a configured Login Kit backend, described in **docs/TIKTOK-SETUP.md**. That backend requires Node.js or an independently hosted service; it is not deployed by downloading the desktop ZIP. Existing setup on this computer continues to use its configured server.

Guest cards and symbolic gift effects can appear in the outgoing scene. Remote guest video, LIVE chat, paid gifts, Coins and payouts are not implemented.

To update, close the running studio before opening this new version. Your existing workspace is reused. Keep your previous version and connection-server files until the new version and saved account link have been checked.

The release includes **SHA256SUMS.txt** for archive verification.
