# NexKord-ADM

Discord bot focused on the Akinator game flow with low-overhead runtime defaults.

## Quick start

### Prerequisites

- Docker and Docker Compose
- Discord bot token

### Installation

```bash
git clone https://github.com/jubinjacob03/NexKord-ADM.git
cd NexKord-ADM
cp .env.example .env
docker-compose build
docker-compose up -d
```

## Environment

Required variables:

```env
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_client_id
GUILD_ID=your_guild_id
AKINATOR_CHANNEL_ID=your_channel_id
```

Optional Akinator networking values:

```env
# AKINATOR_PROXY=socks5://host:port
# AKINATOR_PROXY_USER=...
# AKINATOR_PROXY_PASS=...
# AKINATOR_REQUEST_TIMEOUT_MS=15000
```

See `.env.example` for the full template.
