# NexKord-ADM

NexKord-ADM combines two cooperating Discord processes:

- **Main bot** (`discord.js`) runs Akinator and the Components V2 Cinema control/public boards.
- **Streaming selfbot** (`discord.js-selfbot-v13`) resolves or prepares media, holds its configured voice channel, and streams into voice as a separate process.

> Automating a Discord user account violates Discord's Terms of Service and can result in account termination. Run the selfbot only if you accept that risk.

## Features

- **Akinator:** generation-bound game sessions, exact message/component validation, free-text or button answers, per-game timeout, and a CycleTLS client.
- **Cinema:** moderator-only Components V2 management dashboard, public showtimes board, TMDB search, atomic library/schedule state, DNS-pinned bounded downloads, exact offline-variant scheduling, and up to ten screens.
- **Streaming:** exact guild/channel/sender authorization, ready-RTC voice checks, DNS-pinned progressive-media spooling, local-only FFmpeg inputs, bounded prefetch/transcode concurrency, atomic cache metadata, and configurable 24/7 voice-channel presence.

## Architecture

```text
Discord -> Main bot (src/index.js)
           |-- Akinator (src/games/akinator)
           `-- Cinema (src/games/cinema)
                 |
                 `-- posts <prefix><command> to a screen text channel
                              |
                              v
                 Selfbot (src/selfbot/index.js)
                 listens in SELFBOT_CHANNEL_ID and streams in voice
```

A Cinema screen's text channel must match the selfbot's `SELFBOT_CHANNEL_ID`. The main bot user ID must be authorized through `SELFBOT_CONTROLLER_ID`; when omitted, it falls back to `CLIENT_ID`.

## Prerequisites

- Node.js 22.12 or newer and npm 10
- A Discord bot application/token
- A TMDB v3 API key for Cinema search
- For the selfbot: `ffmpeg` and `ffprobe` on `PATH`
- For provider extraction: Chromium/Chrome, or Puppeteer's bundled browser
- Docker and Docker Compose only when containerizing the main bot

## Installation

```powershell
Copy-Item .env.example .env
npm ci
```

Fill in `.env` before starting a process. `.env.example` lists required variables, optional settings, and the naming pattern for Cinema screens 1–10. Commented values are built-in defaults or example overrides. At minimum:

### Main bot

- `DISCORD_TOKEN`
- `AKINATOR_CHANNEL_ID` to enable Akinator
- `TMDB_API_KEY` and `CINEMA_DASHBOARD_CHANNEL_ID` to enable Cinema
- `GUILD_ID` or `CINEMA_GUILD_ID` to scope Cinema controls

`CLIENT_ID` and `GUILD_ID` are also used by explicit command deployment. This branch defines no slash commands, so they are not required merely to log the main bot in.

### Selfbot

- `SELFBOT_TOKEN`
- `SELFBOT_GUILD_ID`
- `SELFBOT_CHANNEL_ID`
- `SELFBOT_VOICE_CHANNEL_ID`
- `SELFBOT_CONTROLLER_ID`, or `CLIENT_ID` as its fallback
- `TMDB_API_KEY` for provider-backed TV/search/prepare commands

Only commands from the exact configured guild, channel, controller, or optional operator IDs are accepted.

## Running

### Main bot

```powershell
npm start
```

Command deployment is intentionally separate:

```powershell
npm run deploy
npm run deploy -- --clear
```

With the current empty definition set, the first command safely skips registration. It will register definitions if commands are added later. The second deliberately removes stale guild commands from earlier versions.

### Streaming selfbot

```powershell
npm run token:grab
npm run selfbot
```

`SELFBOT_STAY_IN_VC` defaults to `true`. The selfbot rejoins `SELFBOT_VOICE_CHANNEL_ID` after disconnects; `!leave` is blocked while that hold is enabled.

## Cinema authorization and channels

Cinema mutations require one of:

- Discord `ManageGuild`
- A user ID in `CINEMA_MODERATOR_USER_IDS`
- A role ID in `CINEMA_MODERATOR_ROLE_IDS`

Public screen-join and poster actions remain available to regular members. Configure:

- `CINEMA_DASHBOARD_CHANNEL_ID` for moderator controls
- `CINEMA_SHOWTIMES_CHANNEL_ID` for the auto-updating public board
- `CINEMA_ANNOUNCEMENT_CHANNEL_ID` for posters and as the showtimes fallback
- `CINEMA_SCREEN_1_*` through `CINEMA_SCREEN_10_*` for streaming screens

New showtimes can be created only when a verified offline media file exists. Each showtime is pinned to that exact library variant. Delivery status confirms that the bridge command reached the screen channel; an interrupted or uncertain delivery is retained as `dispatch_unknown` for operator review and is never automatically replayed. It does not confirm that selfbot playback started.

## Media safety and prefetching

Cinema downloads and selfbot remote playback accept public HTTPS destinations on port 443. Every connection is pinned to an address that passed validation, and every redirect is independently revalidated. URLs with credentials and local, private, documentation, multicast, or otherwise reserved network destinations are rejected.

- Empty `CINEMA_DOWNLOAD_ALLOWED_HOSTS` or `SELFBOT_PLAY_ALLOWED_HOSTS` allows any otherwise-valid public HTTPS host.
- A comma-separated host list allows that host and its subdomains only.
- Selfbot remote inputs must be progressive media. HLS, DASH, Smooth Streaming, manifest-shaped responses, compressed responses, unsupported content types, and files over `SOURCE_MAX_MB` are rejected.
- Remote media is downloaded through Node into a temporary bounded spool. ffprobe and FFmpeg receive only local files with network protocols disabled, even when `PREFETCH=false`.
- Local selfbot playback is restricted to regular files under `data/library` and `data/cache`; symlink and path escapes are rejected.
- `PREFETCH_MAX_CONCURRENT` bounds complete remote preparation operations. Same-title requests share one operation, while different titles are admitted in request-arrival FIFO order.
- Preparation and playback fail closed; a failed prefetch is never retried as a direct FFmpeg URL.

Provider extraction runs third-party pages in Chromium. Deployments requiring a complete network boundary must also restrict Chromium egress at the operating-system or network layer.

## Docker

The Docker image uses the digest-pinned [official Node image](https://hub.docker.com/_/node) and runs only the main bot as the unprivileged `node` user. With the documented Compose configuration, Docker's init process is PID 1 and forwards signals and reaps children; Node is its direct child without an npm or shell wrapper.

State and media are bind-mounted from the workspace `data/` directory so the containerized main bot and host-run selfbot use the same library, catalog, and schedules. Logs persist in the Compose-managed `nexkord-logs` volume. On Linux, ensure the host `data/` directory is writable by container UID/GID 1000 before startup. Compose explicitly passes only main-bot variables from the project `.env`; `SELFBOT_TOKEN` and other selfbot settings are not added to the main container.

```powershell
New-Item -ItemType Directory -Force data | Out-Null
docker compose build
docker compose up -d nexkord-adm
```

Back up the host `data/` directory and the `nexkord-logs` volume before replacement. Do not run `docker compose down -v` unless permanent log-volume deletion is intended.

WARP is optional and disabled by default. To use the digest-pinned [backplane/wireproxy image](https://hub.docker.com/r/backplane/wireproxy/tags), create the host file `data/warp/wireproxy.conf`, configure the applicable proxy variable such as `AKINATOR_PROXY`, then run:

```powershell
docker compose --profile warp up -d
```

The selfbot is not containerized because it needs host FFmpeg, Chromium, and Discord voice support.

## Usage

- **Akinator:** send a message in `AKINATOR_CHANNEL_ID`, then answer by button or free text (`yes`, `no`, `don't know`, `probably`, `probably not`, `back`, or `stop`).
- **Cinema:** use the V2 dashboard to search, add/download media, schedule verified offline titles, manage progress, and refresh public state.
- **Selfbot:** use the configured prefix, default `!`, with `movie`, `tv`, `play`, `prepare`, `cache`, `schedule`, `shows`, `cancel`, `server`, `search`, `status`, `stop`, `join`, `leave`, or `help`.

## npm scripts

| Script                        | Purpose                                           |
| ----------------------------- | ------------------------------------------------- |
| `npm start`                   | Run the main bot                                  |
| `npm run dev`                 | Run the main bot with nodemon                     |
| `npm run deploy`              | Register definitions when present; otherwise skip |
| `npm run build`               | Run the project lint gate                         |
| `npm run selfbot`             | Run the streaming selfbot                         |
| `npm run selfbot:dev`         | Run the selfbot with Node watch mode              |
| `npm run lint`                | Lint `src` and `scripts`                          |
| `npm run token:grab`          | Open the local token-capture browser flow         |
| `npm run test:akinator:local` | Run the existing local Akinator smoke script      |
| `npm run icons:cinema`        | Generate/upload Cinema emoji assets               |

## Persistence and secrets

Runtime state and media are stored under `data/`; logs are stored under `logs/`. Local runs use those workspace paths. Compose bind-mounts `data/` for host/selfbot interoperability and stores logs in a named volume. Back up the applicable storage before replacing a deployment. Never commit `.env`, tokens, proxy credentials, browser profiles, or runtime data. Rotate any credential that has been copied into logs, chat, or version control.

## Validation

```powershell
npm run lint
node src/deploy-commands.js
docker compose config --quiet
```

Live Discord voice, Components V2 delivery, providers, TMDB, Akinator, Puppeteer, CycleTLS, and FFmpeg transport still require real credentials and network access for end-to-end verification.
