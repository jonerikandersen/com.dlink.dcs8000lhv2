# Fase 0 — funn

Status: **Bestått.** Protokollen er bevist mot faktisk DCS-8000LHV2 (firmware 1.05.03) på <lokal-ip>.

## Enhets-info

| | Verdi |
|---|---|
| Modell | DCS-8000LHV2 (Mini Full HD Pan & Tilt) |
| Hardware revision | A1 |
| Firmware | 1.05.03 |
| HTTP-server | `dcs-lig-httpd` (D-Link lighttpd-variant) |
| HTTP realm | `DCS-8000LHV2_56` |
| Hostname (DHCP) | `DCS-8000LHV2.iot.ov5.lan` |
| Verifisert bilde | 2026/05/25 23:21:26 (live garasje-snapshot) |

## Åpne porter

| Port | Tjeneste | Status |
|---|---|---|
| 80/tcp | HTTP (snapshot, ONVIF, web UI) | **open** |
| 554/tcp | RTSP | **open** |
| 8000/tcp | http-alt | open (formål uavklart) |
| 8080/tcp | http-proxy | open, lukker forbindelse |
| 443/tcp | HTTPS | closed |
| 3702/udp | WS-Discovery | **closed** ← discovery via broadcast vil ikke finne kameraet |

## Verifiserte endepunkter

| Endepunkt | Auth | Returnerer |
|---|---|---|
| `rtsp://admin:<pin>@<ip>:554/live/profile.0` | URL-embedded | H.264 1920×1080 + AAC |
| `rtsp://admin:<pin>@<ip>:554/live/profile.1` | URL-embedded | H.264 1280×720 + AAC |
| `GET http://<ip>/image/jpeg.cgi` | **HTTP Digest** | JPEG 1280×720 (~80 KB) |
| `http://<ip>/onvif/device_service` | HTTP Digest (realm `onvif`) | ONVIF SOAP |
| `http://<ip>/onvif/snapshot` | HTTP Digest (realm `onvif`) | ONVIF snapshot |

## Auth-fakta

- **Brukernavn:** `admin` (alltid)
- **PIN:** synlig på kameraets etikett (6 siffer). Brukes som passord for både RTSP, HTTP og ONVIF.
- **Snapshot- og web-UI-realm** = `DCS-8000LHV2_56` (modell + last 2 mac-siffer e.l.)
- **ONVIF-realm** = `onvif` (separat namespace)
- **Auth-mekanisme:** HTTP **Digest** (qop=auth). Basic-auth avvises med 401.
- RTSP bruker URL-embedded credentials, ikke separat auth-header.

## To bugs som ble fanget under verifisering

1. **Feil endepunkt-path:** vår første implementasjon brukte `/images/jpeg.cgi` (med 's'). Riktig er `/image/jpeg.cgi`. Community-guides på nett har begge varianter — D-Links lighttpd respekterer kun den uten 's'.
2. **Feil auth-type:** vi brukte HTTP Basic. Kameraet krever HTTP Digest. Vi hadde ingen indikasjon på dette før vi probet med ekte forespørsler.

Begge fikset i `lib/snapshot.js` med innebygd Digest-implementasjon (ingen ekstra dependency).

## Det ene spørsmålet — besvart

> Hvor stabil er ONVIF-subscriptionen på DCS-8000LHV2 over tid?

**Ikke målt enda.** ONVIF-portene svarer på Digest-auth, men vi har ikke kjørt subscription i timesvis. Forventningen er at den fungerer normalt for Profile S-event-subscriptions; usikkerheten er kun rundt langtidsstabilitet. Måles i Fase 5.

## Konsekvens for app-arkitekturen

| Komponent | Bekreftet | Konsekvens |
|---|---|---|
| `homey.videos.createVideoRTSP()` | RTSP-URL fungerer | Live-stream i Homey Web App |
| `homey.images.createImage().setStream()` | Digest snapshot fungerer | Auto-refreshing thumbnail |
| ONVIF motion subscription | Tilkobling fungerer, events ikke testet ende-til-ende | Sannsynligvis ok, må testes på Homey |
| PTZ via ONVIF | Endepunkt finnes | Sannsynligvis ok, må testes |
| WS-Discovery | **Stengt** | Pair-flyten må be om IP manuelt — droppet discover-steget |

## Capabilities-mapping (faktisk)

| Homey capability | Endepunkt | Auth |
|---|---|---|
| Video stream | `rtsp://admin:<pin>@<ip>:554/live/profile.<n>` | URL-embedded |
| Snapshot image | `GET http://<ip>/image/jpeg.cgi` | Digest |
| `alarm_motion` | ONVIF pull-point subscription | Digest (via `onvif` lib) |
| `button_up/down/left/right` | ONVIF `relativeMove` | Digest |
| `button_home` | ONVIF `gotoHomePosition` | Digest |
| `button_snapshot` | Force-refresh av `createImage` | — |

## Klar for installasjon

Vi har:
- Fungerende RTSP-URL-bygging (kun IP + PIN er parametere)
- Fungerende Digest-auth snapshot-lib bevist mot kamera <lokal-ip>
- Forenklet 3-stegs pair-flyt: IP+PIN → preview → add
- WS-Discovery droppet (port stengt, ville bare forvirret brukere)

## Oppdatering 2026-11-25

Testet på nytt mot kameraet (<lokal-ip>, firmware 1.05.03):

- **Ingen PTZ.** DCS-8000LHV2 er fastmontert. ONVIF tilbyr bare device, media, events og imaging. `/onvif/ptz_service` svarer 200 med tom kropp. PTZ-radene over er feil.
- **Motion har aldri virket i 0.1.** `onvif`-pakken sender ikke WS-Addressing-headere, og kameraet avviser hendelseskallene ("A required header representing a Message Addressing Property is not present"). 0.2 har en egen SOAP-klient (`lib/onvif-events.js`).
- `To`-headeren må være `http://<ip>/onvif/event_service` uten `:80`, ellers 500 "No route can be determined".
- POST uten kropp gir 500 i stedet for 401, så curl `--digest` kommer aldri til autentiseringen.
- Ett hendelsesemne, `Event`, med strengfeltet `Event`. Pull-point holdt stabilt i tre minutter uten hendelser (ingen hjemme). Payloaden ved bevegelse er ikke sett.
- RTSP bruker Digest (realm `LIVE555 Streaming Media`). profile.0 og profile.1 gir H.264 + AAC 16 kHz.
- `/common/info.cgi` (NIPCA 1.9.7) svarer uten innlogging og viser blant annet `pir=no`, `speaker=no`, `mic=yes`, `ir=yes`.
