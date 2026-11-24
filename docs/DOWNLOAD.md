# Download and run on Windows

Download the release asset named `Local-LIVE-Studio-1.4.0-windows-x64.zip`. The automatically generated GitHub “Source code” archives contain source files and are intended for developers.

1. Save the Windows ZIP to your computer.
2. In File Explorer, right-click it and choose **Extract All**.
3. Open the extracted folder and double-click **Launch Local LIVE Studio.cmd**, or open the `Local LIVE Studio` folder and double-click **Local LIVE Studio.exe**.
4. Keep the entire extracted folder together. The executable requires the runtime files beside it. You can move the extracted folder to another local drive before opening it.

The Windows ZIP includes the application runtime. Node.js, npm, a TikTok account, and developer tools are not required to run it. This release targets Windows 10/11 x64; other operating systems and ARM64 have not been validated. The build is unsigned: it does not carry a verified publisher code-signing certificate.

Your workspace, local accounts, downloaded media, and studio gift history are saved under `%APPDATA%\Local LIVE Studio`. Recordings are saved under your Videos folder in `Local LIVE Studio`. Files are saved for the current Windows user, rather than inside the downloaded ZIP. Keep locally imported media available at its original path.

Internet access starts enabled and can be switched off in Recording settings. Studio editing, recording, accounts, and symbolic gifts work locally. Browser overlays and downloading online media need an Internet connection. Windows camera, microphone, and screen-capture permissions depend on the device.

TikTok profile linking requires a registered Login Kit app and the connection backend; see `TIKTOK-SETUP.md` in the source archive. A profile connection does not enable broadcasting, real LIVE guest video, chat, real TikTok gifts, Coins, or payouts. The Gifts panel manages local name cards and symbolic gift animations with no cash value. It does not deliver gifts to remote viewers.

To update, close the app and extract a new release to a separate folder. Open its launcher. The same Windows user's saved workspace and recording folder are reused. The earlier extracted release can remain available if needed.

The release includes `SHA256SUMS.txt` for checking downloaded files. In PowerShell, run `Get-FileHash -Algorithm SHA256` against the ZIP and compare the hash with that file.
