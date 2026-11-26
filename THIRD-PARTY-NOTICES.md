# Third-party notices

Version 1.5.0 can launch an independently installed FFmpeg executable for LIVE encoding. No FFmpeg binary or library is bundled with this application. That installation is governed by its own licenses and notices; see https://ffmpeg.org/legal.html. The studio supports builds with libx264 and uses a separate process rather than linking FFmpeg libraries.

Local LIVE Studio is an independent application. It is not affiliated with or endorsed by TikTok. No TikTok application files, proprietary artwork, credentials, or inspection captures are included in the distributed app or source bundle.

The Windows distribution includes Electron and its bundled Chromium, Node.js, and other runtime components. Their license notices are included beside the executable in `Local LIVE Studio/LICENSE` and `Local LIVE Studio/LICENSES.chromium.html`. Keep those files with the distribution.

Development tools and their license metadata are identified in `package-lock.json`. Development dependencies are not bundled as application npm dependencies.

Version 1.6.0 includes qrcode-generator 2.0.4 by Kazuhiko Arase for local QR-code rendering. Its MIT license is included at `vendor/QR-LICENSE.txt` inside the application and source archive. Project: https://github.com/kazuhikoarase/qrcode-generator . No external QR-code service receives pairing links.

Phone HTTPS links use an independently installed cloudflared executable. This helper is not bundled in the application. Cloudflare distributes it under its own license and notices: https://github.com/cloudflare/cloudflared . Quick Tunnel hosting is a separate Cloudflare service.
