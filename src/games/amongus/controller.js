import { createImpostorLobby } from "./impostor.js";
import { auditLog } from "../../utils/logger.js";
import { buildV2Container } from "../../utils/embed.js";
import { icon } from "../../utils/icons.js";
import {
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { logAmongUsConsole } from "./dashboard.js";
import { getCustomPresets, saveCustomPreset, deleteCustomPreset } from "./customPresets.js";
import {
  buildCustomPresetMenu,
  buildPresetBuilderUI,
  buildPresetInfoUI,
  buildSuccessUI,
  buildErrorUI,
} from "./ui-builder.js";
import axios from "axios";

const builderState = new Map();
const stateLocks = new Map();
const THIRTY_MINUTES = 30 * 60 * 1000;
const INTERACTION_TIMEOUT = 2500;
const MAX_PRESETS = 25;

const DEFAULT_STATE = Object.freeze({
  category: "core",
  impostors: 2,
  maxPlayers: 15,
  mapId: 0,
  playerSpeed: 1.0,
  crewVision: 1.0,
  impVision: 1.5,
  killCooldown: 25.0,
  commonTasks: 1,
  longTasks: 1,
  shortTasks: 2,
  shapeshifters: 0,
  phantoms: 0,
  vipers: 0,
  scientists: 0,
  engineers: 0,
  angels: 0,
  noisemakers: 0,
  trackers: 0,
  detectives: 0,
});

/**
 * Validates builder state configuration
 * @param {Object} state - Builder state to validate
 * @returns {Object} Validation result with isValid flag and error message
 */
function validateBuilderState(state) {
  if (!state || typeof state !== "object") {
    return { isValid: false, error: "Invalid state object" };
  }

  const totalRoles =
    (state.shapeshifters || 0) + (state.phantoms || 0) + (state.vipers || 0) +
    (state.scientists || 0) + (state.engineers || 0) + (state.angels || 0) +
    (state.noisemakers || 0) + (state.trackers || 0) + (state.detectives || 0);

  const availableSlots = (state.maxPlayers || 0) - (state.impostors || 0);

  if (totalRoles > availableSlots) {
    return {
      isValid: false,
      error: `Too many roles! You have ${totalRoles} roles but only ${availableSlots} available slots.`,
    };
  }

  const impostorRoles = (state.shapeshifters || 0) + (state.phantoms || 0) + (state.vipers || 0);
  if (impostorRoles > (state.impostors || 0)) {
    return {
      isValid: false,
      error: `Too many impostor roles! You have ${impostorRoles} impostor roles but only ${state.impostors} impostors.`,
    };
  }

  return { isValid: true };
}

/**
 * Validates preset data structure
 * @param {Object} preset - Preset data to validate
 * @returns {boolean} True if valid
 */
function validatePresetData(preset) {
  if (!preset || typeof preset !== "object") return false;

  const requiredFields = ["impostors", "maxPlayers", "map", "killCooldown"];
  return requiredFields.every(field => typeof preset[field] === "number");
}

/**
 * Sanitizes preset name
 * @param {string} name - Raw preset name
 * @returns {string} Sanitized name
 */
function sanitizePresetName(name) {
  if (typeof name !== "string") return "";
  return name.trim().replace(/[^a-zA-Z0-9\s\-_]/g, "").substring(0, 20);
}

/**
 * Cleans up expired builder sessions
 */
function cleanupExpiredSessions() {
  const now = Date.now();

  for (const [userId, state] of builderState.entries()) {
    if (state.lastActivity && now - state.lastActivity > THIRTY_MINUTES) {
      if (!stateLocks.get(userId)) {
        builderState.delete(userId);
        auditLog("info", "BUILDER_CLEANUP", `Cleaned up expired session for user ${userId}`);
      }
    }
  }
}

setInterval(cleanupExpiredSessions, 10 * 60 * 1000);

/**
 * Acquires lock for user state
 * @param {string} userId - User ID
 * @returns {Promise<Function>} Release function
 */
async function acquireStateLock(userId) {
  while (stateLocks.get(userId)) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  stateLocks.set(userId, true);
  return () => stateLocks.delete(userId);
}

/**
 * Gets or initializes builder state for a user
 * @param {string} userId - Discord user ID
 * @returns {Object} Builder state
 */
function getBuilderState(userId) {
  if (!builderState.has(userId)) {
    builderState.set(userId, { ...DEFAULT_STATE, lastActivity: Date.now() });
  }

  const state = builderState.get(userId);
  state.lastActivity = Date.now();
  return state;
}

/**
 * Updates builder state for a user with locking
 * @param {string} userId - Discord user ID
 * @param {Object} updates - State updates to apply
 */
async function updateBuilderState(userId, updates) {
  const release = await acquireStateLock(userId);
  try {
    const state = getBuilderState(userId);
    Object.assign(state, updates, { lastActivity: Date.now() });
  } finally {
    release();
  }
}

/**
 * Creates a lobby and announces it
 * @param {Object} interaction - Discord interaction
 * @param {string} presetName - Name of the preset
 * @param {Object} presetData - Preset configuration
 * @returns {Promise<Object>} Result with success flag and room code
 */
async function createAndAnnounceLobby(interaction, presetName, presetData) {
  if (!validatePresetData(presetData)) {
    throw new Error("Invalid preset configuration");
  }

  try {
    auditLog("info", "AMONGUS_LOBBY", `${interaction.user.tag} requested ${presetName} lobby`);

    const IMPOSTOR_API_URL = process.env.IMPOSTOR_API_URL || "http://impostor:22025";
    const IMPOSTOR_API_KEY = process.env.IMPOSTOR_API_KEY || "your_secret_key";

    const response = await Promise.race([
      axios.post(
        `${IMPOSTOR_API_URL}/api/lobby/create`,
        {
          maxPlayers: presetData.maxPlayers,
          impostorCount: presetData.impostors,
          mapId: presetData.map,
          playerSpeedMod: presetData.playerSpeed || 1.0,
          crewLightMod: presetData.crewVision || 1.0,
          impostorLightMod: presetData.impVision || 1.5,
          killCooldown: presetData.killCooldown,
          numCommonTasks: presetData.commonTasks || 1,
          numLongTasks: presetData.longTasks || 1,
          numShortTasks: presetData.shortTasks || 2,
          shapeshifterCount: presetData.shapeshifters || 0,
          phantomCount: presetData.phantoms || 0,
          viperCount: presetData.vipers || 0,
          scientistCount: presetData.scientists || 0,
          engineerCount: presetData.engineers || 0,
          guardianAngelCount: presetData.angels || 0,
          noisemakerCount: presetData.noisemakers || 0,
          trackerCount: presetData.trackers || 0,
          detectiveCount: presetData.detectives || 0,
        },
        {
          headers: { Authorization: `Bearer ${IMPOSTOR_API_KEY}` },
          timeout: 4000,
        }
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("API request timeout")), 4000)
      ),
    ]);

    if (!response.data?.roomCode || typeof response.data.roomCode !== "string") {
      throw new Error("Invalid API response");
    }

    const code = response.data.roomCode;
    const serverIp = process.env.IMPOSTOR_SERVER_IP || "play.nexkord.com";
    const deepLink = `amongus://init?servername=NexKord&serverip=${serverIp}&serverport=22023&usedtls=false`;

    let clickableLink = deepLink;
    try {
      const res = await axios.get(
        `https://tinyurl.com/api-create.php?url=${encodeURIComponent(deepLink)}`,
        { timeout: 2000 }
      );
      if (res.data && typeof res.data === "string" && res.data.startsWith("http")) {
        clickableLink = res.data;
      }
    } catch (e) {
      auditLog("warn", "AMONGUS", `Shortlink generation failed: ${e.message}`);
    }

    logAmongUsConsole(
      `Room Created | Preset: [1;33m${presetName.toUpperCase()}[0m | Code: [1;32m${code}[0m`
    );

    const targetChannelId = process.env.AMONGUS_ANNOUNCE_CHANNEL_ID || "1506836961263095931";
    const pingRoleId = process.env.AMONGUS_PING_ROLE_ID || "1510515943103664218";

    try {
      const targetChannel = await interaction.client.channels.fetch(targetChannelId);
      if (targetChannel?.isTextBased()) {
        const publicContainer = buildV2Container(
          "Among Us Custom Lobby Created",
          `**${interaction.user.toString()}** has created a new **${presetName.toUpperCase()}** lobby!\n\n` +
            `**Room Code:** \`${code}\`\n\n` +
            `### How to Connect\n` +
            `**PC / Android:** Make sure your \`regionInfo.json\` is set to NexKord.\n` +
            `**iOS / Android (Auto):** Open Among Us in the background, then click this link:\n` +
            `[Tap here to connect to NexKord Server](${clickableLink})`,
          0x00ffff
        );

        await targetChannel.send({
          content: `<@&${pingRoleId}>`,
          components: [publicContainer],
          flags: MessageFlags.IsComponentsV2,
        });
      }
    } catch (channelError) {
      auditLog("error", "AMONGUS", `Failed to announce lobby: ${channelError.message}`);
    }

    return { success: true, code, channelId: targetChannelId };
  } catch (error) {
    auditLog("error", "AMONGUS_LOBBY_FAIL", `${interaction.user.tag} failed: ${error.message}`);
    throw error;
  }
}

/**
 * Safely responds to an interaction
 * @param {Object} interaction - Discord interaction
 * @param {Object} payload - Response payload
 * @param {boolean} isUpdate - Whether to update existing message
 */
async function safeRespond(interaction, payload, isUpdate = false) {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(payload);
    } else if (isUpdate) {
      await interaction.update(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (error) {
    if (error.code !== 40060) {
      auditLog("error", "INTERACTION_RESPOND", `Failed to respond: ${error.message}`);
    }
  }
}

/**
 * Checks if interaction is from an ephemeral message
 * @param {Object} interaction - Discord interaction
 * @returns {boolean} True if from ephemeral
 */
function isFromEphemeral(interaction) {
  return !!(
    interaction.message &&
    interaction.message.flags &&
    interaction.message.flags.has(MessageFlags.Ephemeral)
  );
}

/**
 * Handles Among Us interactions
 * @param {Object} interaction - Discord interaction object
 * @returns {Promise<boolean>} True if handled
 */
export async function handleAmongUsInteraction(interaction) {
  if (!interaction.isButton() && !interaction.isModalSubmit() && !interaction.isStringSelectMenu()) {
    return false;
  }

  try {
    if (interaction.isButton()) {
      return await handleButtonInteraction(interaction);
    }

    if (interaction.isModalSubmit()) {
      return await handleModalSubmit(interaction);
    }

    if (interaction.isStringSelectMenu()) {
      return await handleSelectMenu(interaction);
    }
  } catch (error) {
    auditLog("error", "INTERACTION_ERROR", `Error: ${error.message}`);

    try {
      const errorPayload = buildErrorUI(
        "Something Went Wrong",
        "An unexpected error occurred. Please try again or contact an administrator."
      );
      await safeRespond(interaction, errorPayload);
    } catch (replyError) {
      auditLog("error", "ERROR_RESPONSE_FAIL", `Cannot send error: ${replyError.message}`);
    }

    return true;
  }

  return false;
}

/**
 * Handles button interactions
 * @param {Object} interaction - Discord interaction
 * @returns {Promise<boolean>} True if handled
 */
async function handleButtonInteraction(interaction) {
  const { customId } = interaction;

  if (customId === "au_presets") {
    const payload = buildPresetInfoUI();
    await safeRespond(interaction, payload, isFromEphemeral(interaction));
    return true;
  }

  if (customId === "au_reset") {
    const payload = buildSuccessUI(
      "Reset to Official Servers",
      `${icon("INFO")} **How to reset your game back to official servers:**\n\n` +
        `1. Open Among Us.\n2. Click on **Online**.\n3. In the bottom right corner, click the **Globe Icon**.\n` +
        `4. Select **North America**, **Europe**, or **Asia**.\n\nYour game is now disconnected from NexKord!`
    );
    await safeRespond(interaction, payload, isFromEphemeral(interaction));
    return true;
  }

  if (customId === "au_custom_menu") {
    const presets = await getCustomPresets();
    const payload = buildCustomPresetMenu(presets);
    await safeRespond(interaction, payload, isFromEphemeral(interaction));
    return true;
  }

  if (customId === "au_builder_init") {
    const release = await acquireStateLock(interaction.user.id);
    try {
      builderState.set(interaction.user.id, { ...DEFAULT_STATE, lastActivity: Date.now() });
      const state = getBuilderState(interaction.user.id);
      const payload = buildPresetBuilderUI(state);
      await safeRespond(interaction, payload, true);
    } finally {
      release();
    }
    return true;
  }

  if (customId === "au_build_back") {
    const presets = await getCustomPresets();
    const payload = buildCustomPresetMenu(presets);
    await safeRespond(interaction, payload, true);
    return true;
  }

  if (customId === "au_build_cancel") {
    builderState.delete(interaction.user.id);
    const payload = buildSuccessUI("Cancelled", "Preset creation cancelled.");
    await safeRespond(interaction, payload, true);
    return true;
  }

  if (customId === "au_back_to_main") {
    const payload = buildSuccessUI("Returned to Dashboard", "Check the main dashboard channel.");
    await safeRespond(interaction, payload, true);
    return true;
  }

  if (customId === "au_build_save") {
    const state = getBuilderState(interaction.user.id);
    const validation = validateBuilderState(state);

    if (!validation.isValid) {
      const errorPayload = buildErrorUI("Invalid Configuration", validation.error);
      await interaction.reply({ ...errorPayload, ephemeral: true });
      return true;
    }

    const modal = new ModalBuilder()
      .setCustomId("au_builder_name_modal")
      .setTitle("Name Your Preset");

    const nameInput = new TextInputBuilder()
      .setCustomId("preset_name")
      .setLabel("Preset Name")
      .setPlaceholder("e.g., Detective Mode")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(3)
      .setMaxLength(20);

    modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
    await interaction.showModal(modal);
    return true;
  }

  if (customId.startsWith("au_create_")) {
    const preset = customId.replace("au_create_", "");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const presetData = { impostors: 2, maxPlayers: 15, map: 0, killCooldown: 25 };
      const result = await createAndAnnounceLobby(interaction, preset, presetData);

      const successPayload = buildSuccessUI(
        "Lobby Created",
        `${icon("SUCCESS")} Successfully created the lobby!\n\n**Room Code:** \`${result.code}\`\n\nAnnounced in <#${result.channelId}>.`
      );

      await safeRespond(interaction, successPayload);
    } catch (error) {
      const errorPayload = buildErrorUI("Lobby Creation Failed", error.message);
      await safeRespond(interaction, errorPayload);
    }

    return true;
  }

  return false;
}

/**
 * Handles modal submissions
 * @param {Object} interaction - Discord interaction
 * @returns {Promise<boolean>} True if handled
 */
async function handleModalSubmit(interaction) {
  if (interaction.customId === "au_builder_name_modal") {
    const rawName = interaction.fields.getTextInputValue("preset_name");
    const name = sanitizePresetName(rawName);

    if (!name || name.length < 3) {
      const errorPayload = buildErrorUI("Invalid Name", "Preset name must be at least 3 characters.");
      await safeRespond(interaction, errorPayload);
      return true;
    }

    const state = builderState.get(interaction.user.id);
    if (!state) {
      const errorPayload = buildErrorUI("Session Expired", "Your builder session has expired. Please start over.");
      await safeRespond(interaction, errorPayload);
      return true;
    }

    const existingPresets = await getCustomPresets();
    if (Object.keys(existingPresets).length >= MAX_PRESETS) {
      const errorPayload = buildErrorUI("Too Many Presets", `You can only have ${MAX_PRESETS} presets. Delete some first.`);
      await safeRespond(interaction, errorPayload);
      return true;
    }

    if (existingPresets[name]) {
      const errorPayload = buildErrorUI("Preset Exists", `A preset named **${name}** already exists.`);
      await safeRespond(interaction, errorPayload);
      return true;
    }

    await saveCustomPreset(name, {
      impostors: state.impostors,
      maxPlayers: state.maxPlayers,
      map: state.mapId,
      playerSpeed: state.playerSpeed,
      crewVision: state.crewVision,
      impVision: state.impVision,
      killCooldown: state.killCooldown,
      commonTasks: state.commonTasks,
      longTasks: state.longTasks,
      shortTasks: state.shortTasks,
      shapeshifters: state.shapeshifters,
      phantoms: state.phantoms,
      vipers: state.vipers,
      scientists: state.scientists,
      engineers: state.engineers,
      angels: state.angels,
      noisemakers: state.noisemakers,
      trackers: state.trackers,
      detectives: state.detectives,
    });

    builderState.delete(interaction.user.id);

    const successPayload = buildSuccessUI(
      "Preset Saved",
      `${icon("SUCCESS")} Successfully saved **${name}**!\n\nYou can now launch it from the Custom menu.`
    );

    await safeRespond(interaction, successPayload);
    return true;
  }

  return false;
}

/**
 * Handles select menu interactions
 * @param {Object} interaction - Discord interaction
 * @returns {Promise<boolean>} True if handled
 */
async function handleSelectMenu(interaction) {
  const { customId } = interaction;

  if (customId === "au_select_custom_preset") {
    const presetName = interaction.values[0];
    const presets = await getCustomPresets();
    const presetData = presets[presetName];

    if (!presetData || !validatePresetData(presetData)) {
      const errorPayload = buildErrorUI("Invalid Preset", "The selected preset is invalid or corrupted.");
      await safeRespond(interaction, errorPayload);
      return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const result = await createAndAnnounceLobby(interaction, presetName, presetData);

      const successPayload = buildSuccessUI(
        "Lobby Created",
        `${icon("SUCCESS")} Successfully created the lobby!\n\n**Room Code:** \`${result.code}\`\n\nAnnounced in <#${result.channelId}>.`
      );

      await safeRespond(interaction, successPayload);
    } catch (error) {
      const errorPayload = buildErrorUI("Lobby Creation Failed", error.message);
      await safeRespond(interaction, errorPayload);
    }

    return true;
  }

  if (customId.startsWith("au_build_")) {
    const state = getBuilderState(interaction.user.id);

    if (!state) {
      const errorPayload = buildErrorUI("Session Expired", "Your builder session has expired.");
      await safeRespond(interaction, errorPayload);
      return true;
    }

    const release = await acquireStateLock(interaction.user.id);
    try {
      const rawValue = interaction.values[0];

      if (customId === "au_build_category") {
        state.category = rawValue;
      } else {
        const value = parseFloat(rawValue);
        if (isNaN(value)) {
          throw new Error("Invalid value selected");
        }
        if (customId === "au_build_imp") state.impostors = value;
        else if (customId === "au_build_ply") state.maxPlayers = value;
        else if (customId === "au_build_map") state.mapId = value;
        else if (customId === "au_build_spd") state.playerSpeed = value;
        else if (customId === "au_build_cv") state.crewVision = value;
        else if (customId === "au_build_iv") state.impVision = value;
        else if (customId === "au_build_cd") state.killCooldown = value;
        else if (customId === "au_build_tcom") state.commonTasks = value;
        else if (customId === "au_build_tlng") state.longTasks = value;
        else if (customId === "au_build_tsht") state.shortTasks = value;
        else if (customId === "au_build_ss") state.shapeshifters = value;
        else if (customId === "au_build_phantom") state.phantoms = value;
        else if (customId === "au_build_viper") state.vipers = value;
        else if (customId === "au_build_sci") state.scientists = value;
        else if (customId === "au_build_eng") state.engineers = value;
        else if (customId === "au_build_ga") state.angels = value;
        else if (customId === "au_build_noise") state.noisemakers = value;
        else if (customId === "au_build_tracker") state.trackers = value;
        else if (customId === "au_build_det") state.detectives = value;
      }

      state.lastActivity = Date.now();

      const payload = buildPresetBuilderUI(state);
      await safeRespond(interaction, payload, true);
    } finally {
      release();
    }

    return true;
  }

  return false;
}
