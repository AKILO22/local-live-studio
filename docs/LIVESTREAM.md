# Start and end a livestream

Version 1.5.0 makes LIVE output the main studio workflow. The scene preview and audio mixer feed a separate FFmpeg encoder, which publishes H.264 video and AAC audio to the chosen RTMP/RTMPS destination. Preparing scenes works offline; transmitting needs Internet access.

1. Open the studio and prepare your scene. Add camera/screen/media sources and enable the microphone you intend to use. Check the preview and audio meters.
2. For TikTok, open **Account → Connect TikTok** and authorize the basic-profile connection. A saved link is verified again before broadcasting. This connection uses your configured Login Kit backend.
3. Obtain your LIVE server URL and stream key from TikTok's own streaming-software settings, if your account has that access. Set your LIVE title and category there. The app cannot generate those credentials or obtain broadcast permission from basic-profile sign-in.
4. Choose **Set up LIVE destination**. Select TikTok LIVE, enter the server URL and stream key in separate fields, then save. URL query credentials belong in the stream-key field. The secret field clears after saving; credentials remain only in this running app's main-process memory. They are not included in projects, exports or app logs. The selected FFmpeg executable path is the only saved LIVE preference.
5. Confirm that FFmpeg is detected. On this setup computer it is already installed. On another Windows PC, install a trusted FFmpeg build with libx264 from a source linked by [FFmpeg](https://ffmpeg.org/download.html), then choose its **ffmpeg.exe** if detection does not find it. The portable app does not bundle FFmpeg. The encoder must support RTMP, RTMPS, libx264 and AAC.
6. Select **Start Live**. The button changes to Cancel connection while starting, then End Live while transmitting. LIVE status is based on encoder output progress, not on a successful sign-in. It confirms that the encoder is sending; check TikTok to verify that viewers can see the broadcast.
7. Choose **End Live** to finish sending. Also end the broadcast in TikTok's app or LIVE dashboard. TikTok may issue a new server URL/key for every broadcast; the studio discards the TikTok destination after ending so you can enter fresh details.

**Custom RTMP / RTMPS** supports another server you control without requiring a TikTok profile link. It also supports loopback receivers for private tests. This selection does not claim a TikTok account connection.

## Connection behavior

The app does not silently reconnect and resume a public broadcast. A rejected key, stalled output or network error moves to Disconnected. Lower the bitrate or obtain fresh LIVE credentials, then explicitly start again. Turning Internet access off stops the output. Closing the studio asks whether to End Live and close; an unexpected renderer exit stops the encoder too.

RTMPS validates certificates using the Node/system trust roots exported to a public certificate bundle. RTMP itself is unencrypted; choose RTMPS when your platform supplies it. FFmpeg runs without a shell, and diagnostics shown by the app omit raw encoder output and stream keys. The key is necessarily given to the encoder process as its destination argument, so other software operating as the same Windows user may inspect it. Protect the Windows session and use only a trusted encoder. This version does not store stream keys persistently.

This release does not implement TikTok LIVE room creation/termination APIs, LIVE chat, remote guest video, paid TikTok gifts, Coins or payouts. Local guest cards and symbolic gifts can appear in the outgoing composed scene but are not remote platform transactions. Previous recordings can be opened from Studio settings; the main interface is for livestreaming.

Official references: [TikTok computer connection instructions](https://inapp.tiktokv.com/falcon/webcast_mt/page/obs_intro/index.html), [TikTok Login Kit](https://developers.tiktok.com/docs/en/login-kit-overview), [FFmpeg protocols](https://ffmpeg.org/ffmpeg-protocols.html), [FFmpeg command-line options](https://ffmpeg.org/ffmpeg.html).
