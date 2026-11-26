# Phone Camera and Phone Monitor

Version 1.6.0 adds a paired phone page with three modes: Phone Camera, Phone Monitor, and Camera + Monitor. Phone Monitor displays the studio's composed video and mixed audio without needing a TikTok stream key or starting a public LIVE broadcast.

## Connect

1. Put the computer and phone on the same Wi-Fi network. Keep Internet access enabled in the studio.
2. Open **Phone** in the studio header, or **Add source → Phone Camera**.
3. If the helper is not detected, get the official **cloudflared** executable from [Cloudflare's downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then choose it in the phone dialog. It is an external helper and is not bundled in the app. A verified helper has been prepared on the setup computer.
4. Choose **Create phone link**. Scan its QR code using your phone's normal Camera app, or copy the pairing link to your phone. Open it in Safari or Chrome.
5. Enter a phone name and choose **Phone Camera**, **Phone Monitor**, or **Camera + Monitor**. Camera modes ask permission for video only; the phone microphone is not requested.
6. Choose **Connect to studio** on the phone, then **Allow** for that phone in the desktop app. Check the phone name and requested mode before approving.
7. Phone Camera is added to the active scene. Select it to move, resize or hide it. Phone Monitor plays the canvas output, not the desktop interface or private notes. Monitor audio begins muted; tap **Enable monitor audio** on the phone to hear it. Use headphones near an active studio microphone.
8. Keep the phone page in the foreground. Full screen, front/back camera switching, and screen wake lock are offered where the browser supports them.

Choose **Disconnect phone** on either device to end one connection. **Stop phone connections** ends every phone connection and closes the temporary HTTPS helper. Turning Internet access off, closing the studio, or a renderer crash also stops phone access. New pairing links expire after 15 minutes; approved devices can continue while the session is running. Creating a new link after expiry preserves approved devices.

## Networking and privacy

The helper exposes only the dedicated phone page and bounded pairing/signalling endpoints. It binds locally to 127.0.0.1 and makes an outbound Cloudflare Quick Tunnel. Phone camera access uses a valid HTTPS origin; no certificate warning bypass or disabled TLS verification is used. Pairing secrets are generated for the current session, are excluded from project exports and app logs, and are never sent as URL query parameters. Each phone also receives a separate temporary connection token. Desktop approval is required before session descriptions or video are exchanged.

Cloudflare handles the HTTPS page and signalling requests, including ordinary connection metadata and WebRTC session descriptions. Video and audio use encrypted WebRTC between the devices. No STUN or TURN service is configured. This release targets the same Wi-Fi network; mobile-data or distant-network connections are not promised, and guest Wi-Fi or firewall isolation can prevent video. The app does not change Windows firewall or security settings. Cloudflare Quick Tunnels have no uptime guarantee and their hostname changes per session.

One phone camera and up to four waiting/connected devices are supported. Phone output targets 24 fps and approximately 1.5 Mbps per video sender. The phone does not become a TikTok mobile camera input and the feature does not grant TikTok LIVE access or create a mobile TikTok broadcast.

For browser behaviour, see [getUserMedia secure contexts](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) and [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## Verification scope

The automated suite covers pairing, authentication boundaries, approval, mode negotiation, signal forwarding, expiry, offline shutdown and owned-track cleanup. A separate integration check passed against a real temporary HTTPS Quick Tunnel: the phone page and assets loaded, a synthetic device joined, desktop approval completed, offer/answer messages crossed the tunnel, and shutdown cleared access.

Physical phone video, mobile browser camera permissions, audio playback and front/back switching have not been verified on a real handset. The isolated browser media check was blocked on this Windows session: its renderer could not finish loading the local fixture. Desktop UI automation was also unavailable. These are verification limits; the signalling checks do not prove end-to-end media playback. Confirm the two video directions on your own Wi-Fi before relying on them during a broadcast.
