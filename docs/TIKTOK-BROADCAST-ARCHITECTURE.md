# TikTok LIVE Studio account-based broadcasting investigation

Inspected November 25, 2026. The selected shortcut is `C:\ProgramData\Microsoft\Windows\Start Menu\Programs\TikTok LIVE Studio.lnk`. It resolves to `C:\Program Files\TikTok LIVE Studio\TikTok LIVE Studio Launcher.exe`. The installed package identifies itself as version **1.32.4**, with entrypoint `electron/main.js`. Windows reported a valid signature from **TikTok Pte. Ltd.** on the launcher. Shortcut resolution, signature verification and byte offsets below are ordinary local-file observations, separately from REA analysis.

## Finding

The installed client automates room creation and ingest setup. Its source consumes streaming URLs returned in room information and splits a URL into server and key parts before invoking its streaming bridge. The user does not have to copy a stream key; the code still uses server-issued streaming credentials. This is static client evidence, not an observed production request or a guarantee that another application can call that service.

## Source identity and provenance

Original workflow bundle: `C:\Program Files\TikTok LIVE Studio\1.32.4\resources\app\static\js\async\23080.3ba12061.js`.

- Size: 9,405,463 bytes.
- SHA-256: `17f80f07f039bd92117f34b1c5883f23307bb6625f61cbea11cdcd92630a2d12`.
- Original Electron bundle SHA-256: `2752e3b816a1f0f4ef7c7d44c1837c88e66ab57725606897d1c1d4316cd574b9`.

The large Electron bundle exceeded REA's 1,024 MiB worker heap. That failed portion remains unknown; its result was retained. To inspect the actual workflow without repeating that analysis, Babel parsed the workflow bundle inertly and selected original webpack factory bodies. Their original parameters and bodies were placed in inert CommonJS wrappers, with original file hashes and byte-range mappings. No target code was executed. Eight selected factories were then parsed by REA. Other inventoried factories and dynamically resolved relationships remain unknown.

Private evidence and recovered source remain in `operations/tiktok-keyless-2026-11-25/`, excluded from Git and release archives. `modules/provenance.json` maps every recovered factory to its original bytes. These files are investigation artifacts and are not runtime dependencies.

## REA records

| Record | Evidence ID | Coverage |
| --- | --- | --- |
| Selected original main/preload analysis | `ev_4ff07935f7af885247e01dc128ffd663db718dd0e85209d86c2c6a328c9ec8f8` | Partial; large main bundle exceeded worker heap. |
| Original-analysis summary | `ev_7c6cd3039d5ad50ebea2c79d2aa34d9b9b33bdad14e040d8cac00d49d8a2a6a2` | Reports the failure and retained preload facts. |
| Selected workflow-factory analysis | `ev_0167288ce8186ca80013df9b46179d301e43ef5d9a045799022d130358a1f5ef` | Eight selected factory sources parsed; application and semantic coverage partial. |
| Workflow summary | `ev_08d48f2a82693a73764c7909dcb7f3245d8238800b40591e967d8b32a32ea63c` | Five inventoried factory sources unexamined; bounded semantic retention. |

REA CLI **6.10.1** produced `rea-selected-source.json` and `rea-workflow-modules.json`. The connected MCP tool failed to start before and after the user restarted it. `rea doctor --client codex --json` identified registration drift: the connection requests 6.8.0 while the installed CLI is 6.10.1. No Codex configuration, analysis engine, security setting or TikTok installation was changed.

## Workflow evidence

All byte ranges below are zero-based, end-exclusive ranges in the original workflow bundle. Findings are observed static source; the inferred explanation is identified separately.

| Step | Factory and original bytes | Concrete source evidence |
| --- | --- | --- |
| Create a room | `276513`, `[8935943,8936105)` | Exports `createRoom`; calls `request.post('/webcast/room/create/', stringify(input))`. Network host, final headers and live response were not captured. |
| Handle authorization/result | `532882`, `[6787043,6821466)` | `goLive` awaits `createRoom`, examines `status_code`, updates room information on success, proceeds to `goLiveStage2`, and handles a punished result separately. |
| Prepare native output | `204940`, `[6829981,6834622)` | Reads `id_str`, `stream_id_str`, `stream_url`, optional `multi_stream_url`; reads `push_urls[0]`, `rtmp_push_url`, and `rtmp_push_url_params`. Builds `fullUrl`, server `url`, and `key`; forwards codec, bitrate, retry and protocol settings through `startStream`. |
| Permission snapshot | `840375`, `[7938328,7950139)` | Fetches create info with `live_studio:1`, LIVE permission and a LIVE Studio access check. Reads account age assurance, bans, `enable_live_studio`, regional restriction, permission status and calm-period fields. A snapshot is evidence of checks, not proof every gate is enforced on every path. |
| First-party request context | `838250`, `[8805916,8807913)` | Uses app information, persisted user state, common request parameters, server-time adjustment and retry interceptors. Logs an invalid-session business code. Complete authentication/signing mechanics remain unverified. |
| Room continuity | `174001`, `[8936295,8938304)` | Contains create-info, room-continue, anchor-ping and room-switch-update calls. This explains client-side room maintenance patterns; endpoint availability and heartbeat timing are not runtime observations. |

Expected **consumer shape**, derived from field reads rather than a captured response:

```text
room: id_str, stream_id_str, stream_url, optional multi_stream_url
stream_url: push_urls[], rtmp_push_url, rtmp_push_url_params
create result: status_code, data, data.create_time
```

No live server URL, stream key, user cookie, session token, account database or decrypted credential was acquired. No private endpoint was called, no first-party identity or request signature was reproduced, and no production broadcast was started or stopped.

## Implication for Local LIVE Studio

The existing connection deliberately requests only `user.info.basic` (`lib/tiktok.cjs:10` and `server/tiktok-broker.cjs:11`). TikTok describes this as profile access and documents separate approval for additional permissions: [Login Kit overview](https://developers.tiktok.com/docs/en/login-kit-overview), [Scopes overview](https://developers.tiktok.com/docs/en/scopes-overview). This authorization is not evidence of access to the first-party room-creation service.

Inference: a standalone client would need an authorized broadcast integration that can create and end rooms and obtain valid ingest credentials, plus its documented session, refresh, heartbeat and error contracts. Reverse engineering client code does not confer that server permission. No supported standalone broadcast grant for this project's existing developer app was established in this investigation.

## Implemented route selected by the user

Version 1.7.0 adds a composed-output window and a launcher for the genuine signed TikTok LIVE Studio. The user selects this window as a capture source in TikTok and starts/ends LIVE there. Local LIVE Studio never reads the official app's account session or impersonates its private client. No stream key is entered in this route. A separate restricted output renderer receives only the composed video and mixed audio over local WebRTC. Audio playback is opt-in; it does not enable a microphone automatically.

This is an official-app handoff, **not standalone keyless TikTok broadcasting**. Output-ready status does not mean TikTok is LIVE. Closing the output feed, disabling Internet in Local LIVE Studio, or closing Local LIVE Studio does not end a broadcast running in TikTok. Direct RTMP/RTMPS output retains its separate destination requirements.

## Remaining scope

| Question | Result |
| --- | --- |
| Why can the official client avoid manual key entry? | Answered by static room-create → returned stream information → output-configuration flow. |
| Can profile-only Login Kit start LIVE? | Not supported by the granted scope; no broadcast authorization established. |
| Complete private API authentication/signing? | Unverified, outside the implemented handoff. |
| Standalone public broadcast integration for this app? | Blocked pending TikTok-authorized broadcast access and its integration contract. |
| Actual first-party request/response and account entitlement? | Unverified; no production mutation performed. |
| No-manual-key official-app route? | Implemented; see [setup](TIKTOK-STUDIO-ROUTE.md) for verification status. |

For a future standalone integration, request TikTok's supported broadcast SDK/API access for this developer app. Obtain documented room creation, ingest retrieval, refresh/reconnect, heartbeat and termination contracts and a disposable test account. Implement that service behind the existing encoder, keep credentials in protected backend storage, and verify create → stream → reconnect → end in the authorized test environment. Do not substitute profile tokens or copy the official client's session.
