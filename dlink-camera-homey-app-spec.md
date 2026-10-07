# D-Link DCS-8000LHV2 — Homey-app · teknisk spec

Mål: en egenbygd Homey SDK3-app (`homey app install` på Homey Pro 2026) som styrer D-Link DCS-8000LHV2 (mydlink Mini HD Pan & Tilt Wi-Fi Camera, 1080p) lokalt via RTSP + HTTP + ONVIF. Ingen sky-binding etter førstegangs oppsett.

## Nøkkelinnsikt

DCS-8000LHV2 er den **V2-modellen** av DCS-8000LH. I motsetning til v1 (som var sky-låst) har D-Link åpnet for lokal RTSP og ONVIF i v2 — men det må **manuelt aktiveres i mydlink-appen først**:

- mydlink → kamera → Settings → Advanced Settings → Local Access → **RTSP on**
- Passord = som default de **siste 6 sifrene av PIN-koden** på kameraets etikett (kan endres i mydlink-appen)

Du porterer altså ikke en låst kamera-protokoll fra null — du kobler til en standard RTSP/ONVIF-enhet og pakker den inn som en Homey-enhet med PTZ + motion + thumbnail.

## Referansekilder

| Kilde | Hva |
|---|---|
| [Home Assistant DCS-8000LHV2 community thread](https://community.home-assistant.io/t/d-link-dcs-8000lhv2-integration/232283) | Bekrefter at lokal RTSP fungerer på v2 etter mydlink Local Access er aktivert |
| [D-Link Cameras + Home Assistant guide (usro.net, 2025)](https://blog.usro.net/2025/06/d-link-cameras-home-assistant-setup-guide/) | URL-strukturer, profile.0/profile.1, JPEG-endepunkt |
| [bmork/defogger (GitHub)](https://github.com/bmork/defogger) | DCS-8000LH (v1) hacking-referanse — bare for kontekst; v2 er enklere |
| [DCS-8000LHV2 datablad PDF](https://media.dlink.eu/support/products/dcs/dcs-8000lhv2/documentation/dcs-8000lhv2_man_reva1_1-00_eu_multi_20200327.pdf) | Offisiell brukermanual |
| [Homey VideoRTSP SDK](https://apps-sdk-v3.developer.homey.app/VideoRTSP.html) | `homey.videos.createVideoRTSP()` API |
| [Homey Camera SDK](https://apps-sdk-v3.developer.homey.app/Camera.html) | `setCameraImage`, `setCameraVideo` |
| `onvif` npm-pakke | WS-Discovery + Cam-klient for events/PTZ |

## Tjenester på kameraet (etter Local Access)

| Port | Protokoll | Brukt til |
|---|---|---|
| 80 | HTTP | Snapshot (`/images/jpeg.cgi`), ONVIF web services |
| 554 | RTSP | Live stream — `rtsp://admin:<pwd>@<ip>:554/live/profile.0` (1080p) eller `profile.1` (720p) |
| 3702/UDP | WS-Discovery | ONVIF discovery |

Ingen NIPCA-API, ingen lokal recording-API. To-veis lyd er fortsatt sky-låst.

## App-arkitektur (Homey SDK3)

```
com.dlink.dcs8000lhv2/
├── .homeycompose/
│   ├── app.json                       sdk:3, compatibility:>=12.0.0, category:video
│   ├── capabilities/                  PTZ-knapper + snapshot-refresh
│   └── flow/
│       ├── triggers/motion_detected.json
│       └── actions/{ptz_move,take_snapshot}.json
├── app.js                             stub
├── drivers/
│   └── camera/
│       ├── driver.compose.json        class:camera, capabilities: alarm_motion + 6 buttons
│       ├── driver.js                  pair-flyt med ONVIF auto-discovery
│       ├── device.js                  RTSP-video + snapshot-poll + ONVIF motion + PTZ
│       └── pair/
│           ├── intro.html             walkthrough for å aktivere RTSP i mydlink
│           ├── discover.html          ONVIF WS-Discovery, tap-to-select
│           ├── connect.html           bruker/passord/kvalitet, pre-fylt fra discovery
│           └── preview.html           viser et faktisk snapshot før commit
└── lib/
    ├── snapshot.js                    HTTP Basic-auth JPEG fetcher
    └── onvif-client.js                Cam wrapper (motion subscription + PTZ + discovery)
```

## Capabilities-mapping

| Homey capability | Kilde | Notater |
|---|---|---|
| `alarm_motion` | ONVIF pull-point event (`tns1:RuleEngine/CellMotionDetector/Motion` eller `tns1:VideoSource/MotionAlarm`) | Trigger via flow ved overgang false→true |
| `button_up`/`down`/`left`/`right` | Klikk-trigget → ONVIF `relativeMove(±0.3, 0)` | Egne button-capabilities så de vises som knapper i device-tile |
| `button_home` | Klikk → ONVIF `gotoHomePosition` | Egen knapp |
| `button_snapshot` | Klikk → tving snapshot-refresh | Egen knapp for manuell refresh |

Pluss media:
- **Video:** `homey.videos.createVideoRTSP()` + `setCameraVideo('rtsp', 'Live stream', video)`. URL-listener bygger `rtsp://user:pwd@ip:554/live/<profile>` ved hver tilkobling, så endringer i settings tas umiddelbart i bruk.
- **Image:** `homey.images.createImage()` + `setCameraImage('snapshot', 'Latest snapshot', image)`. Refresh-loop kaller `image.update()` per intervall.

## Pair-flyt (5 steg)

```
1. intro         "Aktivér RTSP i mydlink-appen"          (HTML guide)
2. discover      ONVIF WS-Discovery scanner LAN           (HTML, 4s scan)
                 → tap kamera for å velge IP
3. connect       Bruker/passord/kvalitet                  (HTML form)
                 Klikk Test → HTTP snapshot fra kamera
4. preview       Vis snapshot                             (HTML, "Looks good?")
5. list_devices  + add_devices (builtin)
```

Hvert steg har feilhåndtering: invalid IP → meldingsboks; 401 fra snapshot → "wrong password"; 404 → "snapshot endpoint differs"; timeout → "camera unreachable".

## Use cases (det dette skal kunne)

1. **Daglig overvåkning** — se live-stream fra Homey-appen eller web-dashboard, snap-thumbnail oppdateres hvert 30. sekund så det føles "alive" uten å brenne CPU
2. **Bevegelses-alarm i flyt** — WHEN motion detected → DO send notification + take snapshot + lagre bilde
3. **PTZ-styring fra Homey** — uten å hoppe ut til mydlink: trykk knapper på device-tile for å panorere, eller bruk flow-action i automasjon ("klokken 22 → flytt kamera til home-posisjon")
4. **Kamera-stream på dashboard** — Homey Web App + Insights kan vise RTSP-stream som video-widget
5. **Snapshot på trigger** — knytt snapshot til andre flows (dør åpnet → ta bilde; alarm utløst → snap)

## Flow-kort

### Triggers
- `motion_detected` — bevegelse oppdaget (én per overgang false→true)

### Actions
- `ptz_move {direction: up|down|left|right|home}` — flytt kamera
- `take_snapshot` — returnerer et `image`-token man kan sende til notifikasjoner, e-post, etc.

### Conditions
*(ikke laget enda — kan legges til når trengs, f.eks. "kamera er online", "siste motion < N sekunder siden")*

## Eksempel-flyts

```
Flow A — "Notify on motion + send snapshot"
  WHEN: D-Link Camera — motion detected
  THEN: D-Link Camera — take snapshot   (gir [[image]]-token)
  AND:  Send notification to phone with image=[[image]]

Flow B — "Park kameraet om natten"
  WHEN: Time is 23:00
  THEN: D-Link Camera — pan/tilt direction=home

Flow C — "Boost motion detection sensitivity when away"
  WHEN: Away mode activated
  THEN: (no-op — DCS-8000LHV2 har ikke sensitivitets-API lokalt;
         dette må gjøres i mydlink-appen)
```

## Sikkerhet og personvern

- **PIN-passordet** lagres i Homey device settings (ikke i source). Settings-typen er `password` så det maskeres i UI.
- **Trafikk** holder seg på lokalnett etter pairing. Kameraet snakker fortsatt med mydlink-skyen i bakgrunnen (kan ikke deaktiveres for v2), men appen din gjør det ikke.
- **Webhook ut av Homey:** Homey Pro 2026 sin innebygde WebRTC-proxy lar deg se streamen utenfor hjemmenettet via Homey Web App, uten å åpne porter selv.

## Forventede fallgruver

- **Snapshot-endepunkt** (`/images/jpeg.cgi`) er community-rapportert. Hvis kameraet returnerer 404, prøv `/image/jpeg.cgi` eller `/snapshot.cgi`. Vi har plassholder for å detektere og bytte.
- **ONVIF motion-topic** varierer per firmware: noen kameraer fyrer `RuleEngine/CellMotionDetector/Motion`, andre `VideoSource/MotionAlarm`. Vår parser matcher begge.
- **PTZ-magnitude** (0.3) er konservativ. Kan justeres via settings hvis bevegelsen er for liten.
- **WS-Discovery** krysser ikke VLAN. Hvis Homey og kamera er på ulike subnett: bruk "Enter IP manually"-knappen i discover-steget.
- **Motion må være på i mydlink** først — kameraet har sin egen sensitivitets-innstilling som ikke kan endres lokalt. Vi leser kun events.
- **Beep / klikk-lyd** har ikke kameraet. Men PTZ-motoren lager mekanisk lyd ved hver bevegelse.

## Notat

Privat sideloaded app, ikke i Homey Store. Bygger på samme mønster som Flexit Roomie-porten — alle protokoll-funn dokumentert i `phase-0-findings.md`.
