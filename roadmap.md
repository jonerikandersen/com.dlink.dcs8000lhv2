# D-Link DCS-8000LHV2 — utviklings-roadmap

Fasedelt roadmap for egenbygd Homey SDK3-app som styrer DCS-8000LHV2 lokalt. Hver fase har mål, leveranse, oppgaver, akseptanse og risiko.

Les `dlink-camera-homey-app-spec.md` først — den dekker protokoll og arkitektur.

---

## Konseptet: lokal kamera-kontroll med Eufy-lignende UX

DCS-8000LHV2 er et 1080p PTZ-kamera som ut av boksen kun snakker med mydlink-skyen. Vi bygger en Homey-app som etter et flagg i mydlink-appen tar over **lokalt** og gir Eufy-lignende opplevelse:

```
Homey device tile
┌────────────────────────────┐
│   [thumbnail snapshot]     │   ← auto-refresh hvert 30s
│   D-Link Camera (LAN)      │
├────────────────────────────┤
│   ↑   ⌂                    │   ← PTZ-knapper
│  ← →  📷                   │   ← snapshot-knapp
│   ↓                        │
│                            │
│  Motion: idle              │   ← alarm_motion capability
└────────────────────────────┘

Tap thumbnail → fullscreen live RTSP stream (WebRTC proxy)
```

Bevegelses-events fra ONVIF puller motion → trigger flows. PTZ-knapper sender ONVIF relativeMove. Snapshot tas via HTTP `/images/jpeg.cgi`.

---

## Fase 0 — Protokoll-bevis (forutsetning)

**Mål:** Bevis at vi kan snakke med kameraet lokalt før vi koder.

**Oppgaver:**
- Bekreft at DCS-8000LHV2 faktisk er v2-modellen (sjekk etikett / mydlink-app)
- Aktiver RTSP i mydlink → Settings → Advanced Settings → Local Access
- Noter RTSP-passord
- Port-scan kamera-IP: `nmap -p 80,554,3702 <ip>` — verifiser åpne porter
- Test RTSP: `ffprobe rtsp://admin:<pwd>@<ip>:554/live/profile.0`
- Test snapshot: `curl -u admin:<pwd> http://<ip>/images/jpeg.cgi -o test.jpg`
- Test ONVIF discovery: `onvif-cli discover` eller `wsdd`

**Akseptanse:** RTSP-stream spilles av i VLC, snapshot kommer tilbake som JPEG, kameraet svarer på ONVIF probe.

**Risiko:** Hvis snapshot-endepunktet ikke er `/images/jpeg.cgi`, prøv `/image/jpeg.cgi` eller `/snapshot.cgi`. Hvis ONVIF ikke svarer, kameraet kan ha intern ONVIF deaktivert (rare, men mulig).

---

## Fase 1 — Scaffold + RTSP-stream

**Mål:** Én Homey-enhet som viser live-stream.

**Leveranse:** `drivers/camera/` med device.js + driver.js, RTSP video registrert.

**Oppgaver:**
- App-scaffold (`.homeycompose/`, `app.json`, manifest, assets)
- Driver med `class: "camera"` + capability `alarm_motion`
- Pair-flyt: manuell IP + passord, test med snapshot
- `this.homey.videos.createVideoRTSP()` med URL-listener
- `setCameraVideo()` på device

**Akseptanse:** Homey kan vise live RTSP-stream fra kameraet i Web App.

---

## Fase 2 — Snapshot-thumbnail + ONVIF motion

**Mål:** Device-tile viser thumbnail som oppdateres jevnlig, og motion-events lager flow-trigger.

**Oppgaver:**
- HTTP Basic-auth snapshot-fetcher (`lib/snapshot.js`)
- `homey.images.createImage()` + `setCameraImage()`
- Polling-loop med konfigurerbart intervall (5–600 s)
- ONVIF `Cam`-klient (`lib/onvif-client.js`)
- Pull-point subscription for motion-events
- Flow trigger `motion_detected`

**Akseptanse:** Thumbnail oppdateres, motion utløser flow-trigger, alarm_motion-capability skifter på rett tidspunkt.

---

## Fase 3 — PTZ + flow-actions

**Mål:** Direkte kamera-styring fra Homey.

**Oppgaver:**
- 6 custom button-capabilities: `button_up/down/left/right/home/snapshot`
- ONVIF `relativeMove()` + `gotoHomePosition()` wrapping
- Flow actions: `ptz_move`, `take_snapshot`

**Akseptanse:** Hver knapp i device-tile flytter kameraet riktig vei. Flow `take snapshot` returnerer JPEG-token.

---

## Fase 4 — Brukervennlig pair-flyt

**Mål:** UX som matcher den polerte Eufy-opplevelsen.

**Oppgaver:**
- 5-stegs pair-flyt: intro → discover → connect → preview → list_devices
- `intro.html` med visuell veiledning for å aktivere RTSP i mydlink
- `discover.html` — ONVIF WS-Discovery scanner LAN automatisk
- `connect.html` — pre-fyller IP fra discovery, du skriver kun passord
- `preview.html` — viser faktisk snapshot fra kameraet før commit
- Fallback "Enter IP manually" hvis discovery feiler (VLAN-separasjon)

**Akseptanse:** Bruker kan pare uten å taste IP, ser bilde fra kamera før commit, vet hvilket kamera som ble paret hvis flere finnes.

---

## Fase 5 — Robusthet & polish

**Mål:** Produksjonsklart for eget bruk.

**Oppgaver:**
- Reconnect-logikk hvis ONVIF subscription dør
- `setUnavailable()` ved snapshot-feil med klar feilmelding
- Konfigurerbart snapshot-endepunkt (settings) hvis 404 på standard
- Bedre placeholder-bilder med kamera-design
- README med install-steg og kjente begrensninger

**Akseptanse:** Overlever nettverksbrudd, kamera-restart og IP-bytte uten manuell innblanding.

---

## Anbefalt rekkefølge å mate inn

```
Fase 0  → bevis RTSP + snapshot + ONVIF mot ditt faktiske kamera   ← avgjør at v2 fungerer
Fase 1  → scaffold + RTSP stream
Fase 2  → thumbnail + motion-detection
Fase 3  → PTZ + flow-actions
Fase 4  → polert pair-flyt med discovery
Fase 5  → robusthet, reconnect, dokumentasjon
```

Stopp etter hver fase, test mot kameraet, så neste.

## Status (per 2026-11-25)

| Fase | Status |
|---|---|
| 0 | **Ferdig.** Se `phase-0-findings.md`, inkludert oppdateringen 2026-11-25 |
| 1 | **Ferdig.** RTSP verifisert mot kameraet (begge profiler) |
| 2 | **Ferdig.** Snapshot-loop virker. Motion via egen ONVIF-klient, abonnement verifisert. Selve motion-payloaden er ikke sett ennå |
| 3 | **Utgår.** Kameraet er fastmontert og har ingen PTZ. Knappene og `ptz_move` er fjernet i 0.2.0. `take_snapshot` beholdes |
| 4 | **Delvis.** IP + PIN → forhåndsvisning → legg til. Discovery droppet (UDP 3702 er stengt) |
| 5 | **Delvis.** Hendelsesløkken fornyer abonnementet og kobler til på nytt med backoff. Diagnoselogg i appinnstillingen `diag` |

## Neste

Vift foran kameraet og les `diag`: hva sender kameraet i `Event` ved bevegelse, og kommer det en egen slutt-hendelse? Stram deretter inn tolkningen i `device.js` (`_onCameraEvent`).
