# Local LIVE Studio 1.5.0

The main studio is now organized around livestreaming, with Start Live, End Live, connection status, output duration, transmitted bytes and a destination setup form. Recording controls and the recording library no longer occupy the main screen. Previous recordings remain available through Studio settings.

The new main-process encoder sends the composed scene and mixed audio as H.264/AAC to an RTMP or RTMPS server. FFmpeg with libx264 must be installed separately; the studio detects it and offers a file picker. It is already installed on the setup computer. No encoder binary is bundled in this release.

TikTok broadcasting requires a linked, verified TikTok profile **and** a current server URL and stream key supplied by TikTok. Login Kit basic-profile access alone does not grant broadcasting access. The app sends and stops the encoder output; TikTok instructs creators to end the broadcast in its own app/dashboard too. It does not create a TikTok LIVE room or update its title/category through Login Kit.

Output has bounded buffering, ordered media chunks, connection/stall detection, TLS certificate validation for RTMPS, cancellation while connecting, and shutdown handling. Destination credentials stay in memory; TikTok keys are discarded when output ends. Real TikTok transmission requires eligible account credentials and has not been validated by a public broadcast.

Read [Livestream setup](LIVESTREAM.md) for the full workflow and limitations.

An authorized sandbox account has completed sign-in and profile refresh in the installed Windows app. The product website is verified in the TikTok developer console. Production review and external streaming credentials are separate requirements; neither is supplied by downloading this release.
