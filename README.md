<div align="center">

<img src="public/icon.svg" alt="Medora" width="96">

# medora

**One button. One answer. A voice assistant for seniors.**

[Live](https://medora-ai-479.netlify.app) · [Quick Start](#quick-start) · [Deploy](#deploy) · [Config](#config)

</div>

---

Press the button, ask out loud, hear a short answer. Family members get their own link to message, video call, and check that medicine was taken.

| | |
| --- | --- |
| **Ask** | Speech to text runs on device with Whisper. Answers come from Hack Club AI, with Exa web search when needed. |
| **Medicine** | Dose schedule synced to the Medora dispenser over Bluetooth. Missed doses alert the family. |
| **Family** | Per contact pages for messages and peer to peer video calls. Web Push rings phones with the page closed. |
| **Day** | Calendar, weather from Open-Meteo, headlines from RSS. No extra API keys. |
| **Games** | Simon, Spot the Difference, Scramble, Multiplication. Start any of them by voice. |

## Quick Start

```sh
cp .env.example .env    # add HACKCLUB_API_KEY
./run.sh
```

Open <http://127.0.0.1:5001>.

| Flag | Does |
| --- | --- |
| `--tunnel` | Public https link through Cloudflare. Cameras work on any phone. |
| `--lan` | Serve contact pages to the local wifi. |
| `--https` | Self signed TLS on the local network. |

## Deploy

```sh
npm install
npm run deploy
```

Netlify runs a Node port of the Flask app. Pages in `public/`, every `/api/*` route in `netlify/functions/api.mjs`, data in Netlify Blobs.

## Config

| Variable | |
| --- | --- |
| `HACKCLUB_API_KEY` | From [ai.hackclub.com](https://ai.hackclub.com/dashboard) |
| `HACKCLUB_MODEL` | Chat model id |
| `WHISPER_MODEL` | `tiny.en` to `large-v3` |
| `TURN_URL` | Relay for calls across strict networks |
| `SENIOR_PASSCODE` | Netlify only. Unlocks the senior's devices |
| `VAPID_*` | Netlify only. Web Push keys |

Full list in [`.env.example`](.env.example).

## Layout

```text
app.py          Flask server
brain.py        model, tools, prompt
stt.py          on device Whisper
static/         local frontend
public/         Netlify frontend
netlify/        Netlify functions
src/server/     Node port of the Python modules
```
