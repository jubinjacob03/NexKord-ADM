# NexKord-ADM

**Multi-Game Management Discord Bot**

A professional, production-ready Discord bot designed to manage multiple game servers seamlessly. Built with a modular architecture, NexKord-ADM provides interactive dashboards, real-time monitoring, and direct server control straight from your Discord community.

## 🎮 Supported Integrations

### ✅ Among Us (Custom Server)
- **Interactive Dashboard:** One-click lobby creation via Discord UI.
- **Cross-Platform Deep Linking:** Seamless connection for iOS and Android users via native `amongus://` URL schemes (no app modification required).
- **Custom Presets:** Instantly spin up lobbies with predefined rulesets (Classic, Chaos, Ranked).
- **Impostor Server Integration:** Utilizes a custom C# HTTP API plugin for programmatic lobby generation.

### ✅ Minecraft (Pterodactyl Integration)
- **Server Control:** Start, stop, and restart servers directly from Discord.
- **Live Console:** View real-time server logs and execute console commands.
- **Uptime Monitoring:** Automated tracking and statistics reporting.
- **Auto-Renewal:** Automated renewal handling for supported hosting providers.

## 🚀 Quick Start

### Prerequisites

- Docker & Docker Compose
- Git
- Discord Bot Token

### Installation

```bash
# Clone the repository
git clone https://github.com/jubinjacob03/NexKord-ADM.git
cd NexKord-ADM

# Configure environment
cp .env.example .env
nano .env  # Edit with your credentials

# Deploy
docker-compose build
docker-compose up -d
```

The deployment process will automatically compile the necessary C# plugins, build the Docker images, and start all services.

## 📋 Configuration

### Required Environment Variables

```env
# Discord Bot
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_client_id
GUILD_ID=your_guild_id

# Among Us Server
IMPOSTOR_SERVER_IP=play.yourdomain.com
IMPOSTOR_API_URL=http://impostor:22025
AMONGUS_DASHBOARD_CHANNEL_ID=your_channel_id
```

See `.env.example` for all available configuration options.

## 🏗️ Architecture

NexKord-ADM is built with a highly modular structure, allowing for easy expansion to new games.

```text
NexKord-ADM/
├── src/
│   ├── games/
│   │   ├── amongus/
│   │   │   ├── ImpostorApiPlugin/    # Native C# API plugin for Impostor
│   │   │   ├── controller.js         # Interaction logic
│   │   │   ├── dashboard.js          # UI generation
│   │   │   └── impostor.js           # API client
│   │   └── minecraft/
│   │       ├── dashboard.js          # Live console & metrics UI
│   │       └── pterodactyl.js        # Panel API client
│   ├── utils/
│   ├── commands.js                   # Slash command definitions
│   └── index.js                      # Event routing
├── docker-compose.yml
└── Dockerfile.impostor               # Multi-stage build for C# plugin
```

## 🔧 Commands

### Among Us
- `/amongus room <preset>` - Create a custom lobby manually.
- `/amongus help` - Display the command reference and connection guide.

### Minecraft
- `/mine command <cmd>` - Execute a console command on the server.
- `/mine help` - Display the Minecraft command reference.

### Security & Performance

- **Containerized Isolation:** All services run in isolated Docker containers.
- **Multi-Stage Builds:** The C# API plugin is compiled natively during the Docker build process, ensuring a lightweight final image.
- **Audit Logging:** Comprehensive logging for all administrative actions taken via Discord.
- **Resource Optimization:** Configured with strict memory limits and reservations to ensure stable performance alongside other services.

## ©️ Copyright & Credits

Developed by **God Blaze**  
Owned by **NexKord** © 2026
