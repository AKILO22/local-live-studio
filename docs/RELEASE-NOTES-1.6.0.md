# Local LIVE Studio 1.6.0

- Phone Camera adds a paired phone's video to the scene, with front/back camera selection.
- Phone Monitor plays the studio's composed video and mixed audio on a phone. It works independently of RTMP destination setup.
- Camera + Monitor supports sending camera video and watching studio output on the same phone page.
- Pairing links, QR codes, desktop device approval, expiring links, per-device disconnect, and complete session shutdown are included.
- A separate official cloudflared helper provides a valid HTTPS phone page. Both devices should use the same Wi-Fi. The helper is not bundled; use the download and selection controls in Phone setup.
- Phone modes request no phone microphone access. Studio monitor audio is muted until enabled on the phone.
- Cancelling or disconnecting during camera switching releases newly acquired camera tracks.

TikTok profile linking and RTMP/RTMPS output retain their separate setup requirements. Phone monitoring does not start a TikTok broadcast or provide a TikTok stream key. See [Phone setup](PHONE.md) for networking requirements and verification limits.

The secure HTTPS pairing and signalling integration check passed. Physical phone media playback is unverified; browser media testing was blocked by the local Windows renderer failing to load the isolated fixture.
