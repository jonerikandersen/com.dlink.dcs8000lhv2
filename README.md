# D-Link DCS-8000LHV2 — Homey App

Local control of the D-Link DCS-8000LHV2 Mini HD Pan & Tilt camera on Homey Pro 2026 — no cloud after setup.

## What you get

- **Live 1080p/720p RTSP stream** — visible in the Homey Web App, and via WebRTC outside your network (Homey 2023+ proxies it)
- **Auto-refreshing snapshot thumbnail** on the device tile
- **Pan/Tilt buttons** directly on the device — up, down, left, right, home
- **Snapshot button** to refresh on demand
- **Motion alarm** via ONVIF event subscription → Homey flow trigger
- **Flow actions** for PTZ moves and capturing snapshots into other flows

## What you need

- The camera's **IP address** on your network (set a static DHCP reservation for stability)
- The **PIN** printed on the camera body (6 digits — also shown in the mydlink app under camera info)

Verified on firmware **1.05.03** — RTSP, snapshots and ONVIF all work out of the box on that version. If yours is older, update via the mydlink app.

## Install

```sh
cd /Users/jonerik/Dev/je_homey_apps/com.dlink.dcs8000lhv2
npm install
homey app install
```

Then in Homey: **Devices → Add a device → D-Link DCS-8000LHV2 → D-Link Camera**.

The pair wizard is three short steps:
1. **Connect** — enter IP + PIN, pick stream quality
2. **Preview** — see a snapshot from the camera so you know it's the right one
3. **Add** — done

## Architecture

```
.homeycompose/                  source of truth for app.json
  app.json
  capabilities/                 PTZ buttons + snapshot refresh
  flow/                         motion_detected, ptz_move, take_snapshot

drivers/camera/
  driver.compose.json
  driver.js                     pair: ONVIF scan + snapshot test
  device.js                     RTSP video + snapshot loop + ONVIF motion + PTZ
  pair/
    intro.html                  RTSP-enable walkthrough
    discover.html               auto-find cameras on network
    connect.html                IP + RTSP password + quality picker
    preview.html                snapshot confirmation view

lib/
  snapshot.js                   HTTP JPEG from /images/jpeg.cgi (Basic auth)
  onvif-client.js               WS-Discovery + pull-point motion + relative PTZ
```

## Known limitations

- **Two-way audio** — mydlink-cloud only on this model. Not supported.
- **Local recording** — the camera doesn't expose a recording API. Workaround: trigger snapshots via flows on motion.
- **Snapshot endpoint** is `/images/jpeg.cgi` based on community reports. If it returns 404 on your firmware, file an issue and I'll add detection of alternative paths.
- **ONVIF cross-VLAN** — WS-Discovery uses broadcast and doesn't cross VLANs. If your camera and Homey are on different VLANs, use **"Enter IP manually"** in the pair wizard.

## License

MIT
