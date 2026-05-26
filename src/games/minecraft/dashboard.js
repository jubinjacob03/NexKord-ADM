import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  AttachmentBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { getServerStatus, setPowerState, sendCommand } from "./pterodactyl.js";
import { logMinecraftConsole, auditLog } from "../../utils/logger.js";
import { eReply } from "../../utils/embed.js";

/**
 * Constructs the Discord UI payload representing the current Minecraft server state,
 * including metrics, power controls, and live console logs.
 *
 * @param {Object|null} [status=null] - Pre-fetched server status data. If null, it will be fetched dynamically.
 * @returns {Promise<Object>} The payload object to be passed to Discord message creation/edit methods.
 */
async function buildDashboardPayload(status = null) {
  if (!status) {
    try {
      status = await getServerStatus();
    } catch (err) {
      status = null;
    }
  }

  const state = status?.current_state || "offline";
  const isRunning = state === "running";
  const isOffline = state === "offline";
  const isStarting = state === "starting";
  const isStopping = state === "stopping";

  const canStart = isOffline;
  const canStop = isRunning;
  const canRestart = isRunning || isOffline;
  const canKill = isStarting || isRunning || isStopping;

  const container = new ContainerBuilder().setAccentColor(0x00ffff);

  let bannerUrl = "attachment://mc-banner-slim.jpeg";
  let filesToUpload = [];
  let attachmentsToKeep = [];

  if (activeDashboardMessage && activeDashboardMessage.attachments.size > 0) {
    const existingAttachment = activeDashboardMessage.attachments.find(
      (a) => a.name === "mc-banner-slim.jpeg",
    );
    if (existingAttachment) {
      attachmentsToKeep.push({ id: existingAttachment.id });
    } else {
      filesToUpload.push(new AttachmentBuilder("./assets/mc-banner-slim.jpeg"));
    }
  } else {
    filesToUpload.push(new AttachmentBuilder("./assets/mc-banner-slim.jpeg"));
  }

  const bannerGallery = new MediaGalleryBuilder().addItems(
    new MediaGalleryItemBuilder().setURL(bannerUrl),
  );
  container.addMediaGalleryComponents(bannerGallery);

  if (consoleBuffer.length > 0) {
    const startIdx = Math.max(
      0,
      consoleBuffer.length - MAX_CONSOLE_LINES - scrollOffset,
    );
    const endIdx = startIdx + MAX_CONSOLE_LINES;
    const visibleLogs = consoleBuffer.slice(startIdx, endIdx);

    let header = "";
    if (scrollOffset > 0) {
      header = `\u001b[33m[ PAUSED - SCROLLED UP ${scrollOffset} LINES ]\u001b[0m\n`;
    }
    let consoleText = header + visibleLogs.join("\n");

    while (consoleText.length > 1950 && visibleLogs.length > 1) {
      visibleLogs.shift();
      consoleText = header + visibleLogs.join("\n");
    }

    if (consoleText.length > 1950) {
      consoleText = consoleText.substring(0, 1950);
    }

    const consoleContent = `\`\`\`ansi\n${consoleText}\n\`\`\``;
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(consoleContent),
    );
    container.addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    );
  }

  if (status && status.resources) {
    const formatMem = (bytes) => {
      const mb = bytes / (1024 * 1024);
      if (mb >= 1024) return (mb / 1024).toFixed(2) + " GB";
      return mb.toFixed(2) + " MB";
    };

    const formatUptime = (ms) => {
      if (!ms) return "";
      const totalSeconds = Math.floor(ms / 1000);
      const d = Math.floor(totalSeconds / 86400);
      const h = Math.floor((totalSeconds % 86400) / 3600);
      const m = Math.floor((totalSeconds % 3600) / 60);
      const s = Math.floor(totalSeconds % 60);

      let parts = [];
      if (d > 0) parts.push(`${d}D`);
      if (h > 0) parts.push(`${h}H`);
      if (m > 0) parts.push(`${m}M`);
      if (d === 0 && h === 0 && m === 0) parts.push(`${s}S`);

      return parts.join(" ");
    };

    const memUsed = formatMem(status.resources.memory_bytes);
    const memLimitBytes = status.resources.memory_limit_bytes;
    const memLimit = memLimitBytes ? formatMem(memLimitBytes) : "4.00 GB";
    const uptimeStr = formatUptime(status.resources.uptime);

    let displayState = status.current_state.toUpperCase();
    if ((isRunning || isStarting) && uptimeStr) {
      displayState = uptimeStr;
    }

    let cpuEmoji = "<:iconMicroBlueOutlined:1508819612098363473>";
    if (
      status.resources.cpu_absolute >= 50 &&
      status.resources.cpu_absolute < 80
    )
      cpuEmoji = "<:iconMicroYellowOutlined:1508819639889559683>";
    else if (status.resources.cpu_absolute >= 80)
      cpuEmoji = "<:iconMicroOrangeOutlined:1508819665957159052>";

    let powerEmoji = "<:iconPowerRedOutlined:1508819583912513607>";
    if (isRunning || isStarting) {
      powerEmoji = "<:iconPowerGreenOutlined:1508819556129312878>";
    } else if (state === "suspended") {
      powerEmoji = "<:iconMicroOrangeOutlined:1508819665957159052>";
    }
    const ramEmoji = "<:iconServerMagentaOutlined:1508819695493447842>";

    if (state === "suspended") {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `\n\u2003${powerEmoji} : \`${displayState}\` \u2003 (Please wait for node to wake or renew on FreeGameHost)\n`,
        ),
      );
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `\n\u2003${powerEmoji} : \`${displayState}\` \u2003 ${cpuEmoji} **CPU :** \`${status.resources.cpu_absolute.toFixed(2)}%\` \u2003 ${ramEmoji} **RAM :** \`${memUsed}/${memLimit}\`\n`,
        ),
      );
    }
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `\n\u2003<:iconPowerRedOutlined:1508819583912513607> : \`ERROR / UNREACHABLE\`\n`,
      ),
    );
  }

  const canStartRestart = isRunning || isOffline || state === "suspended";

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("mc_power_restart")
        .setLabel(isRunning ? "Restart" : "Start")
        .setStyle(isRunning ? ButtonStyle.Primary : ButtonStyle.Success)
        .setDisabled(!canStartRestart),
      new ButtonBuilder()
        .setCustomId("mc_power_kill")
        .setLabel("Kill")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!canKill),
      new ButtonBuilder()
        .setCustomId("mc_send_cmd")
        .setEmoji("1508877020652634233")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("mc_scroll_up")
        .setEmoji("1508822226441343137")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(
          scrollOffset >= Math.max(0, consoleBuffer.length - MAX_CONSOLE_LINES),
        ),
      new ButtonBuilder()
        .setCustomId("mc_scroll_down")
        .setEmoji("1508822271857266839")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(scrollOffset === 0),
    ),
  );

  const payload = {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  };

  if (filesToUpload.length > 0) {
    payload.files = filesToUpload;
  }
  if (attachmentsToKeep.length > 0) {
    payload.attachments = attachmentsToKeep;
  }

  return payload;
}

let activeDashboardMessage = null;
let lastUpdateTimestamp = 0;
let pendingUpdateStats = null;
let updateTimer = null;
const consoleBuffer = [];
const MAX_CONSOLE_LINES = 5;
const MAX_HISTORY = 200;
let scrollOffset = 0;
let lastCommandTimestamp = 0;
let lastPowerActionTimestamp = 0;
let lastScrollTimestamp = 0;
let scrollResetTimer = null;

/**
 * Parses and queues incoming raw console output for display in the dashboard buffer.
 * Processes ANSI formatting, strips redundant metadata, and manages log visibility.
 *
 * @param {string} rawLog - The raw console output received from the server daemon.
 */
export async function updateDashboardWithConsole(rawLog) {
  if (!activeDashboardMessage || typeof rawLog !== "string") return;

  const lines = rawLog.split("\n");
  let updated = false;

  for (let logLine of lines) {
    logLine = logLine.replace(/[\x00-\x09\x0B-\x1A\x1C-\x1F\x7F]/g, "");

    logLine = logLine.replace(/^»\s*(?:\x1b\[[0-9;]*[a-zA-Z])?\s*/, "");
    logLine = logLine.replace(/\r/g, "").trim();
    logLine = logLine.replace(/\x1b\[[0-9;]*m/g, "");

    if ((logLine.match(/»/g) || []).length > 3) continue;

    let isDaemonInfo = false;
    if (
      logLine.match(
        /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s+\[info\s+===\s*\]/i,
      )
    ) {
      isDaemonInfo = true;
    }

    logLine = logLine.replace(
      /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s+\[.*?\]\s*/,
      "",
    );

    logLine = logLine.replace(
      /^\[(?:(?:\d{4}\/\d{2}\/\d{2}\s+)?\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+)?(INFO|WARN|ERROR|SEVERE|FATAL|DEBUG)[^\]]*\]:?/i,
      (match, level) => {
        const upLevel = level.toUpperCase();
        let color = "37";
        if (upLevel === "INFO") color = "34";
        if (upLevel === "WARN") color = "33";
        if (upLevel === "ERROR" || upLevel === "SEVERE" || upLevel === "FATAL")
          color = "31";
        if (upLevel === "DEBUG") color = "36";
        return `\u001b[1;${color}m[${upLevel}]\u001b[0m `;
      },
    );

    logLine = logLine.replace(
      /^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\[.*?\]\s*(?:\[\d{2}:\d{2}:\d{2}\s+(INFO|WARN|ERROR|SEVERE|FATAL|DEBUG)\]:?)?/i,
      (match, level) => {
        if (level) {
          const upLevel = level.toUpperCase();
          let color = "37";
          if (upLevel === "INFO") color = "34";
          if (upLevel === "WARN") color = "33";
          if (
            upLevel === "ERROR" ||
            upLevel === "SEVERE" ||
            upLevel === "FATAL"
          )
            color = "31";
          if (upLevel === "DEBUG") color = "35";
          return `\u001b[1;${color}m[${upLevel}]\u001b[0m`;
        }
        return "\u001b[1;34m[INFO]\u001b[0m";
      },
    );

    logLine = logLine.replace(
      /^(\u001b\[.*?\u001b\[0m)\s*\[([a-zA-Z0-9_-]+)\]/i,
      "$1 \u001b[1;36m$2 »\u001b[0m",
    );

    if (isDaemonInfo) {
      logLine = `\u001b[1;35m[SYS]\u001b[0m \u001b[1m${logLine}\u001b[0m`;
    }

    if (logLine.includes("MINECRAFT SERVER IS ONLINE!")) {
      logLine = logLine.replace(
        "MINECRAFT SERVER IS ONLINE!",
        "\u001b[1;32mMINECRAFT SERVER IS ONLINE!\u001b[0m",
      );
    }

    if (logLine.includes("MINECRAFT SERVER IS STOPPING!")) {
      logLine = logLine.replace(
        "MINECRAFT SERVER IS STOPPING!",
        "\u001b[1;31mMINECRAFT SERVER IS STOPPING!\u001b[0m",
      );
    }
    if (logLine.includes("MINECRAFT SERVER IS OFFLINE!")) {
      logLine = logLine.replace(
        "MINECRAFT SERVER IS OFFLINE!",
        "\u001b[1;31mMINECRAFT SERVER IS OFFLINE!\u001b[0m",
      );
    }

    if (
      logLine.includes("_____                     ____") ||
      logLine.includes("|  ___| _ __   ___   ___  / ___|") ||
      logLine.includes("| |_   | '__| / _ \\ / _ \\| |  _") ||
      logLine.includes("|  _|  | |   |  __/|  __/| |_| |") ||
      logLine.includes("|_|    |_|    \\___| \\___| \\____|") ||
      logLine.includes("Upgrade to Premium:") ||
      logLine.includes("==========") ||
      logLine.trim() === ""
    ) {
      continue;
    }

    if (logLine.includes("Minecraft Server Hibernation Script")) {
      consoleBuffer.push(
        "\u001b[36m _  _         _  __            _ \u001b[0m",
      );
      consoleBuffer.push(
        "\u001b[36m| \\| |_____ _| |/ /___ _ _ __| |\u001b[0m",
      );
      consoleBuffer.push(
        "\u001b[36m| .` / -_) \\ / ' </ _ \\ '_/ _` |\u001b[0m",
      );
      consoleBuffer.push(
        "\u001b[36m|_|\\_\\___/_\\_\\_|\\_\\___/_| \\__,_|\u001b[0m",
      );
      logLine = logLine.replace(
        "Minecraft Server Hibernation Script",
        "\u001b[35mNexKord Server Management System\u001b[0m",
      );
    }

    logMinecraftConsole(logLine);
    consoleBuffer.push(logLine);
    updated = true;
  }

  if (updated) {
    while (consoleBuffer.length > MAX_HISTORY) {
      consoleBuffer.shift();
    }

    queueDashboardUpdate();
  }
}

/**
 * Updates the stored server statistics and triggers a dashboard refresh.
 *
 * @param {Object} stats - The structured statistics object representing server resource utilization.
 */
export async function updateDashboardWithStats(stats) {
  if (!activeDashboardMessage) return;
  pendingUpdateStats = stats;
  queueDashboardUpdate();
}

/**
 * Manages rate-limiting for Discord message edits by debouncing state updates.
 * Guarantees a minimum interval of 5 seconds between dashboard edits to prevent API blocks.
 */
function queueDashboardUpdate() {
  const now = Date.now();
  const timeSinceLastUpdate = now - lastUpdateTimestamp;

  if (timeSinceLastUpdate >= 5000) {
    lastUpdateTimestamp = Date.now();
    triggerDashboardEdit();
  } else {
    if (!updateTimer) {
      const delay = 5000 - timeSinceLastUpdate;
      updateTimer = setTimeout(() => {
        updateTimer = null;
        lastUpdateTimestamp = Date.now();
        triggerDashboardEdit();
      }, delay);
    }
  }
}

/**
 * Executes the actual message edit operation against the Discord API.
 * Automatically recovers standard scroll state on inactivity and handles deleted messages.
 */
async function triggerDashboardEdit() {
  if (!activeDashboardMessage) return;

  if (scrollOffset > 0 && Date.now() - lastScrollTimestamp > 20000) {
    scrollOffset = 0;
  }

  try {
    const payload = await buildDashboardPayload(pendingUpdateStats);
    await activeDashboardMessage.edit(payload);
  } catch (e) {
    console.error("[Dashboard WS] Failed to edit message:", e.message);
    if (e.message.includes("Unknown Message")) {
      console.log(
        "[Dashboard WS] Dashboard message was deleted! Reposting a fresh one...",
      );
      const client = activeDashboardMessage.client;
      activeDashboardMessage = null;
      postMinecraftDashboard(client);
    }
  }
}

/**
 * Initializes and persists the Minecraft dashboard message in the designated control channel.
 * Fetches historical context to reuse the existing dashboard or creates a new one if necessary.
 *
 * @param {Client} client - The active discord.js client instance.
 */
export async function postMinecraftDashboard(client) {
  const channelId = process.env.DASHBOARD_CHANNEL_ID;
  if (!channelId) {
    console.log(
      "[Minecraft Dashboard] DASHBOARD_CHANNEL_ID is not set. Skipping auto-post.",
    );
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.error(
      `[Minecraft Dashboard] Could not find channel with ID ${channelId}`,
    );
    return;
  }

  try {
    const messages = await channel.messages.fetch({ limit: 10 });
    const existing = messages.find(
      (m) =>
        m.author.id === client.user.id &&
        JSON.stringify(m.components ?? []).includes("mc_power_restart"),
    );

    if (existing) {
      activeDashboardMessage = existing;
    }
  } catch (error) {
    console.error(
      "[Minecraft Dashboard] Failed to fetch channel messages:",
      error,
    );
  }

  const payload = await buildDashboardPayload();

  try {
    if (activeDashboardMessage) {
      activeDashboardMessage = await activeDashboardMessage.edit(payload);
      console.log("[Minecraft Dashboard] Updated existing dashboard.");
    } else {
      activeDashboardMessage = await channel.send(payload);
      console.log("[Minecraft Dashboard] Posted new dashboard.");
    }
  } catch (error) {
    console.error(
      "[Minecraft Dashboard] Failed to post/update dashboard:",
      error,
    );
  }
}

/**
 * Intercepts and routes interaction events tied to the Minecraft control dashboard.
 * Processes permission checks, power state operations, scrolling logic, and modal command execution.
 *
 * @param {Interaction} interaction - The discord.js interaction context (Button/Modal/SelectMenu).
 */
export async function handleMinecraftInteraction(interaction) {
  if (
    !interaction.isButton() &&
    !interaction.isModalSubmit() &&
    !interaction.isStringSelectMenu()
  )
    return;

  const memberRoles = interaction.member?.roles?.cache;
  const hasRole =
    memberRoles?.has("1508887584032686201") ||
    memberRoles?.has("1473075468088377352");
  if (!hasRole) {
    return interaction.reply(
      eReply(
        "Access Denied",
        "Please ask the Minecraft Moderator to perform this action.",
      ),
    );
  }

  if (interaction.isButton()) {
    const id = interaction.customId;

    if (
      [
        "mc_power_start",
        "mc_power_stop",
        "mc_power_restart",
        "mc_power_kill",
      ].includes(id)
    ) {
      const now = Date.now();
      if (now - lastPowerActionTimestamp < 3000) {
        return interaction.reply(
          eReply(
            "Cooldown Active",
            "⏳ Please wait 3 seconds before cycling power states to prevent server locking.",
          ),
        );
      }
      lastPowerActionTimestamp = now;

      const action = id.replace("mc_power_", "");
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        auditLog(
          "info",
          `POWER_${action.toUpperCase()}`,
          `${interaction.user.tag} triggered ${action}`,
        );

        const recentLogs = consoleBuffer.slice(-15).join("\n");
        const isHibernatingNow =
          recentLogs.includes("Server is HIBERNATING") &&
          !recentLogs.includes("MINECRAFT SERVER IS ONLINE!");

        if (action === "restart" && isHibernatingNow) {
          await sendCommand("msh start");
          await interaction.editReply(
            eReply(
              "Server Waking Up",
              "✅ Wake signal sent! (Bypassed container restart since server is sleeping)",
            ),
          );
        } else {
          await setPowerState(action);
          await interaction.editReply(
            eReply(
              "Power Action Sent",
              `✅ Successfully sent **${action}** signal to the server.`,
            ),
          );
        }
        setTimeout(() => postMinecraftDashboard(interaction.client), 3000);
      } catch (e) {
        await interaction.editReply(
          eReply("Power Action Failed", `❌ ${e.message}`),
        );
      }
      return;
    }

    if (id === "mc_refresh") {
      const now = Date.now();
      if (now - lastScrollTimestamp < 1000) {
        return interaction.reply(
          eReply("Cooldown Active", "⏳ Please don't spam refresh."),
        );
      }
      lastScrollTimestamp = now;

      await interaction.deferUpdate();
      await postMinecraftDashboard(interaction.client);
      return;
    }

    if (["mc_scroll_up", "mc_scroll_down", "mc_jump_bottom"].includes(id)) {
      const now = Date.now();
      if (now - lastScrollTimestamp < 500) {
        return interaction.reply(
          eReply(
            "Slow Down",
            "⏳ Slow down your scrolling to prevent Discord rate limits!",
          ),
        );
      }
      lastScrollTimestamp = now;

      if (id === "mc_scroll_up") {
        const maxScroll = Math.max(0, consoleBuffer.length - MAX_CONSOLE_LINES);
        scrollOffset = Math.min(maxScroll, scrollOffset + 10);
      } else if (id === "mc_scroll_down") {
        scrollOffset = Math.max(0, scrollOffset - 10);
      } else if (id === "mc_jump_bottom") {
        scrollOffset = 0;
      }

      clearTimeout(scrollResetTimer);
      if (scrollOffset > 0) {
        scrollResetTimer = setTimeout(() => {
          if (scrollOffset > 0) {
            scrollOffset = 0;
            queueDashboardUpdate();
          }
        }, 20000);
      }

      await interaction.update(await buildDashboardPayload(pendingUpdateStats));
      return;
    }

    if (id === "mc_send_cmd") {
      const now = Date.now();
      if (now - lastCommandTimestamp < 2000) {
        return interaction.reply(
          eReply(
            "Cooldown Active",
            "⏳ Please wait a moment before sending another command.",
          ),
        );
      }

      const modal = new ModalBuilder()
        .setCustomId("mc_cmd_modal")
        .setTitle("Send Console Command");

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("cmd_input")
            .setLabel("Enter Command (No / prefix)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(
              "Eg - op, deop, ban, kick, gamemode, tp, time, weather, msh",
            )
            .setRequired(true),
        ),
      );
      await interaction.showModal(modal);
      return;
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === "mc_cmd_modal") {
      const now = Date.now();
      if (now - lastCommandTimestamp < 2000) {
        return interaction.reply(
          eReply(
            "Cooldown Active",
            "⏳ Cooldown active. Please wait 2 seconds between commands.",
          ),
        );
      }
      lastCommandTimestamp = now;

      let command = interaction.fields.getTextInputValue("cmd_input").trim();

      if (command.startsWith("/")) command = command.substring(1);

      if (!command.startsWith("msh ") && !command.startsWith("mine ")) {
        command = `mine ${command}`;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        auditLog(
          "info",
          "COMMAND_EXEC",
          `${interaction.user.tag} executed: ${command}`,
        );
        await sendCommand(command);
        await interaction.editReply(
          eReply(
            "Command Executed",
            `✅ Successfully executed: \`${command}\``,
          ),
        );
      } catch (error) {
        auditLog(
          "error",
          "COMMAND_FAIL",
          `${interaction.user.tag} failed: ${command} | Error: ${error.message}`,
        );
        await interaction.editReply(
          eReply("Command Failed", `❌ ${error.message}`),
        );
      }
      return;
    }
  }
}
