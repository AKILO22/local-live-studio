# Broadcast through TikTok LIVE Studio

Local LIVE Studio 1.7.0 provides the scene. The official TikTok LIVE Studio signs in, creates the LIVE session and broadcasts. You do not enter a stream key for this route. TikTok account eligibility still applies; Local LIVE Studio's optional profile link is separate from the account signed in to the official app.

1. Open Local LIVE Studio and prepare the picture and sound. Enable Internet access.
2. In the right sidebar, choose **Broadcast through TikTok LIVE Studio**.
3. Choose **Open studio output**. Keep the **Local LIVE Studio — Broadcast Output** window open and visible. It contains the composed scene, without the editor or private notes. Avoid minimizing it during capture.
4. Choose **Open TikTok LIVE Studio**. If installation was not detected, use **Choose TikTok LIVE Studio** and select its launcher or application executable. Its publisher signature must be valid and identify TikTok Pte. Ltd. The official app is not bundled.
5. Check the account inside TikTok LIVE Studio. Add a **Window Capture** source, select **Local LIVE Studio — Broadcast Output**, and fit it to the TikTok canvas. Match portrait/landscape settings. Configure this once in the official app's scene.
6. Configure sound in TikTok. Use its microphone and desktop-audio sources, or enable **Play studio mixed audio through the output window** in Local LIVE Studio and capture that sound in TikTok. Use one microphone path and headphones. Confirm the receiving meters move before broadcasting. If Local LIVE Studio captures desktop sound, leave output playback muted and use TikTok's audio inputs to avoid feeding the output back into itself.
7. Set the title/category and choose **Go LIVE in TikTok LIVE Studio**. Check that platform's preview and LIVE indicator. Local LIVE Studio reports output-feed readiness only.
8. End LIVE **in TikTok LIVE Studio**. Then close the output feed if finished.

Closing the output feed, turning Internet off in Local LIVE Studio, or closing Local LIVE Studio does not end an independently running TikTok broadcast. Closing the setup dialog leaves the output feed running. The existing **Start Live / End Live** controls under **Direct RTMP output** control only the separately configured RTMP encoder.

The output renderer is sandboxed, has no Node access, no account bridge and no external web access. Only the trusted studio and output main frames may exchange bounded media signals for the current session. Closing output releases its owned track clones; microphone/RTMP/phone tracks remain separate. No public tunnel, cloud service, stream key or TikTok token is used for the local output window.

## Verification

The full automated suite passed 117 tests, including publisher identity, lifecycle and IPC boundary checks. An isolated Electron test loaded the production controller, output window and signalling bridge: moving generated video reached the output at 640×360 with advancing frames and one audio track, playback started muted, enabling audio changed playback state, and closing/reopening reconnected successfully. These checks validate local media transport; they do not establish physical audibility or platform receipt.

Actual TikTok Window Capture and a public broadcast still require a receiving-platform check with the account owner. No production LIVE is started as an automated test.

The complete studio initialized in a separate test workspace and detected the signed installed app. Its dialog was checked at browser viewports of 1480×940 and 1080×700: the dialog fit vertically and horizontally and had no horizontal content overflow. The generated output screenshot was reviewed. Capturing the hidden full-editor window stalled in the Windows compositor, so full-editor screenshot comparison remains unverified; the viewport checks use actual DOM geometry.

See [the evidence report](TIKTOK-BROADCAST-ARCHITECTURE.md) for recovered contracts and the remaining standalone-integration blocker.
