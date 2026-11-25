# D-Link DCS-8000LHV2 — Homey App

Local control of the D-Link DCS-8000LHV2 Mini Full HD camera on Homey Pro, with no cloud after setup.

## What you get

- **Live 1080p/720p RTSP stream** in the Homey app (H.264 + AAC)
- **Auto-refreshing snapshot thumbnail** on the device tile, plus a snapshot button
- **Motion alarm** from the camera's ONVIF events → `alarm_motion` and the flow trigger *Motion detected*
- **Flow action** *Take snapshot*, which returns an image token for other flows

The DCS-8000LHV2 is a fixed camera: there is no pan/tilt. Version 0.1 had PTZ buttons that could never work; 0.2 removed them.

## What you need

- The camera's **IP address** (use a DHCP reservation)
- The **PIN** printed on the camera (6 digits, also in the mydlink app under camera info)
- Local Access (RTSP) enabled in the mydlink app

Verified on firmware **1.05.03**.

## Install

```sh
homey app install
```

Then in Homey: **Devices → Add a device → D-Link DCS-8000LHV2 → D-Link Camera**: enter IP + PIN, check the preview snapshot, add.

## Protocol notes (verified 2026-11-25)

| What | How |
|---|---|
| Snapshot | `GET /image/jpeg.cgi`, HTTP Digest, JPEG 1280×720 |
| Video | `rtsp://admin:<pin>@<ip>:554/live/profile.0` (1080p) or `profile.1` (720p), RTSP Digest |
| Events | ONVIF pull-point on `/onvif/event_service`, HTTP Digest |
| Device info | `GET /common/info.cgi` (NIPCA 1.9.7), no auth |

ONVIF services offered: device, media, events, imaging. No PTZ (the `ptz_service` path answers with an empty body).

Quirks the app works around in `lib/onvif-events.js`:

- Event requests need **WS-Addressing** headers (`Action`, `MessageID`, `To`); the `onvif` npm package does not send them, so the app has its own small SOAP client.
- The `To` header is matched literally: `http://<ip>/onvif/event_service`, without `:80`.
- A POST without a body gets `500` instead of `401`, so the Digest challenge must come from a request with the full SOAP body (curl's `--digest` never gets that far).

The camera has one event topic, `Event`, with a string item `Event`. The payload for motion has not been observed yet: the app treats any event that mentions "motion" as motion, resets the alarm after *Motion reset* seconds (default 30) and logs every event.

## Diagnostics

Homey offers no way to read an installed app's output, so the app keeps its last 80 log lines in the app setting `diag`:

```sh
homey api apps get-app-setting --id com.dlink.dcs8000lhv2 --name diag
```

## Architecture

```
app.js                          diag log (app setting "diag")
drivers/camera/
  driver.js                     pair: IP + PIN, snapshot test; take_snapshot action
  device.js                     RTSP video, snapshot loop, motion from ONVIF events
  pair/connect.html, preview.html
lib/
  snapshot.js                   Digest-auth HTTP (snapshot + shared helpers)
  onvif-events.js               pull-point subscription with WS-Addressing, renew + backoff
```

## Known limitations

- **Two-way audio**: mydlink cloud only.
- **Local recording**: no API. Trigger snapshots from flows instead.
- **Discovery**: WS-Discovery (UDP 3702) is closed on the camera, so pairing asks for the IP.

## License

MIT
