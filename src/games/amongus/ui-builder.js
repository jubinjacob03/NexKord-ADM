import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} from "discord.js";
import { icon, emojiObj } from "../../utils/icons.js";
import { generateArray } from "./limits.js";

const COLORS = {
  PRIMARY: 0x00ffff,
  EPHEMERAL: 0x2b2d31,
  SUCCESS: 0x57f287,
  DANGER: 0xed4245,
  WARNING: 0xfee75c,
};

export const pad = (str, len = 11) => str.padEnd(len, " ");
export const padV1 = (str) => {
  const plainLength = str.replace(/<a?:[a-zA-Z0-9_]+:[0-9]+>/g, "xx").length;
  return str + "\u00A0".repeat(Math.max(0, 24 - plainLength));
};
export const padV2 = (str) => {
  const plainLength = str.replace(/<a?:[a-zA-Z0-9_]+:[0-9]+>/g, "xx").length;
  return str + "\u00A0".repeat(Math.max(0, 20 - plainLength));
};

const col1 = (str) => {
  const plainLength = str.replace(/<a?:[a-zA-Z0-9_]+:[0-9]+>/g, "xx").length;
  return str + "\u2002".repeat(Math.max(0, 22 - plainLength));
};
const col2 = (str) => {
  const plainLength = str.replace(/<a?:[a-zA-Z0-9_]+:[0-9]+>/g, "xx").length;
  return str + "\u2002".repeat(Math.max(0, 20 - plainLength));
};

const MAP_NAMES = ["The Skeld", "Mira HQ", "Polus", "Airship", "The Fungle"];
const MAP_EMOJIS = [
  "AU_MAP_SKELD",
  "AU_MAP_MIRA",
  "AU_MAP_POLUS",
  "AU_MAP_AIRSHIP",
  "AU_MAP_FUNGLE",
];

const CATEGORIES = {
  core: {
    label: "Core Settings",
    iconKey: "AU_CAT_CORE",
    description: "Players, Impostors, Map",
  },
  game_rules: {
    label: "Game Rules",
    iconKey: "AU_CAT_RULES",
    description: "Speed, Cooldown, Voting",
  },
  game_vision: {
    label: "Vision Settings",
    iconKey: "AU_CAT_VISION",
    description: "Crew & Impostor Vision",
  },
  tasks: {
    label: "Task Settings",
    iconKey: "AU_CAT_TASKS",
    description: "Tasks & Visuals",
  },
  roles_imp: {
    label: "Impostor Roles",
    iconKey: "ROLE_SHAPESHIFTER",
    description: "Shapeshifter, Phantom, Viper",
  },
  roles_crew1: {
    label: "Crew Roles I",
    iconKey: "ROLE_SCIENTIST",
    description: "Scientist, Engineer, Tracker",
  },
  roles_crew2: {
    label: "Crew Roles II",
    iconKey: "ROLE_GUARDIANANGEL",
    description: "Guardian Angel, Noisemaker, Detective",
  },
};

const MAX_PRESET_DISPLAY = 20;

/**
 * Validates map index
 * @param {number} mapId - Map index
 * @returns {number} Valid map index
 */
function validateMapIndex(mapId) {
  const index = parseInt(mapId);
  return isNaN(index) || index < 0 || index >= MAP_NAMES.length ? 0 : index;
}

/**
 * Builds custom preset menu UI
 * @param {Object} presets - Saved presets
 * @returns {Object} Discord message payload
 */
export function buildCustomPresetMenu(presets) {
  const container = new ContainerBuilder().setAccentColor(COLORS.WARNING);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### ${icon("EDITOR")} Custom Presets\n` +
        `Create and manage your personalized Among Us lobby configurations.`,
    ),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );

  const presetKeys = Object.keys(presets).slice(0, MAX_PRESET_DISPLAY);

  if (presetKeys.length > 0) {
    const presetList = presetKeys
      .map((key) => {
        const p = presets[key];
        if (!p || typeof p !== "object") return null;

        const mapId = validateMapIndex(p.map);
        const mapName = MAP_NAMES[mapId];
        const mapEmoji = icon(MAP_EMOJIS[mapId]);

        const roleCount =
          (p.shapeshifters || 0) +
          (p.phantoms || 0) +
          (p.vipers || 0) +
          (p.scientists || 0) +
          (p.engineers || 0) +
          (p.angels || 0) +
          (p.noisemakers || 0) +
          (p.trackers || 0) +
          (p.detectives || 0);

        return (
          `${icon("LAUNCH_GREEN")} **${key}**\n` +
          `${mapEmoji}  ${mapName}  •  ${p.impostors || 0}  ${icon("AU_IMPOSTOR")}  •  ${p.maxPlayers || 0}  ${icon("MEMBERS")}  •  ${roleCount}  Roles\n` +
          `${icon("TIMER")}  ${p.killCooldown || 0}s  CD  • ${icon("MICRO_YELLOW")}  ${p.playerSpeed || 1.0}x Speed`
        );
      })
      .filter(Boolean)
      .join("\n\n");

    if (presetList) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(presetList),
      );

      container.addSeparatorComponents(
        new SeparatorBuilder()
          .setDivider(true)
          .setSpacing(SeparatorSpacingSize.Small),
      );

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId("au_select_custom_preset")
        .setPlaceholder("Select a preset to launch...")
        .addOptions(
          presetKeys.map((key) => {
            const p = presets[key];
            const mapId = validateMapIndex(p.map);
            const mapEmoji = emojiObj(MAP_EMOJIS[mapId]);
            return {
              label: key.substring(0, 100),
              description: `${p.impostors || 0} Imp • ${p.maxPlayers || 0} Players • ${p.killCooldown || 0}s CD`,
              value: key,
              emoji: mapEmoji,
            };
          }),
        );

      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(selectMenu),
      );
    }
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**No Custom Presets Yet**\n\n` +
          `You haven't created any custom presets. Click the button below to create your first one!\n\n` +
          `Custom presets let you save your favorite game configurations for quick access.`,
      ),
    );

    container.addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    );
  }

  const createBtn = new ButtonBuilder()
    .setCustomId("au_builder_init")
    .setLabel("Create New Preset")
    .setEmoji(emojiObj("EDITOR"))
    .setStyle(ButtonStyle.Secondary);

  const backBtn = new ButtonBuilder()
    .setCustomId("au_back_to_main")
    .setLabel("Back")
    .setEmoji(emojiObj("SCROLL_UP"))
    .setStyle(ButtonStyle.Secondary);

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(createBtn, backBtn),
  );

  return {
    components: [container],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  };
}

/**
 * Builds the public lobby announcement UI
 * @param {string} presetName - Name of the preset
 * @param {Object} presetData - Preset configuration
 * @param {string} code - Room code
 * @param {string} clickableLink - Connection link
 * @param {Object} hostUser - Discord user who hosted
 * @param {string} pingRoleId - Role ID to ping
 * @returns {ContainerBuilder} Discord container payload
 */
export function buildLobbyAnnounceUI(presetName, presetData, code, clickableLink, hostUser, pingRoleId) {
  const container = new ContainerBuilder().setAccentColor(COLORS.PRIMARY);

  const mapId = validateMapIndex(presetData.map);
  const mapName = MAP_NAMES[mapId];
  const mapEmoji = icon(MAP_EMOJIS[mapId]);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `<@&${pingRoleId}>\n` +
      `### ${icon("LAUNCH_VIOLET")} Among Us Custom Lobby\n` +
      `**${hostUser.toString()}** has hosted a new **${presetName.toUpperCase()}** game!`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# \` ${code} \``
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  const roleCount =
    (presetData.shapeshifters || 0) +
    (presetData.phantoms || 0) +
    (presetData.vipers || 0) +
    (presetData.scientists || 0) +
    (presetData.engineers || 0) +
    (presetData.angels || 0) +
    (presetData.noisemakers || 0) +
    (presetData.trackers || 0) +
    (presetData.detectives || 0);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### ${icon("AU_CAT_CORE")} Lobby Info\n\n` +
      `### \` ${pad("Map")} \` ${padV1(`${mapEmoji} ${mapName}`)}\` ${pad("Imposters")} \` ${padV2(`${icon("AU_IMPOSTOR")} ${presetData.impostors || 0}`)}\` ${pad("Players")} \` ${icon("MEMBERS")} ${presetData.maxPlayers || 0}\n\n` +
      `### \` ${pad("Speed")} \` ${padV1(`${icon("MICRO_YELLOW")} ${presetData.playerSpeed || 1.0}x`)}\` ${pad("Cooldown")} \` ${padV2(`${icon("TIMER")} ${presetData.killCooldown || 0}s`)}\` ${pad("Roles")} \` ${icon("ROLE_SHAPESHIFTER")} ${roleCount}`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### ${icon("HELP_WORLD")} How to Connect\n` +
      `**PC / Android:** Make sure your \`regionInfo.json\` is set to NexKord.\n` +
      `**iOS / Android (Auto):** Open Among Us in the background, then click the button below.`
    )
  );

  if (clickableLink.startsWith("http")) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("Connect to Lobby")
          .setURL(clickableLink)
          .setStyle(ButtonStyle.Link)
          .setEmoji(emojiObj("LAUNCH_GREEN"))
      )
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`[Tap here to connect to NexKord Server](${clickableLink})`)
    );
  }

  const ts = Math.floor(Date.now() / 1000);
  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# NexKord Server · <t:${ts}:f>`)
  );

  return container;
}

/**
 * Builds preset builder UI
 * @param {Object} state - Current builder state
 * @returns {Object} Discord message payload
 */
export function buildPresetBuilderUI(state) {
  if (!state || typeof state !== "object") {
    throw new Error("Invalid builder state");
  }

  const container = new ContainerBuilder().setAccentColor(COLORS.PRIMARY);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`### ${icon("EDITOR")} Preset Builder`),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Large),
  );

  buildConfigurationSummary(container, state);

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Large),
  );

  const categorySelect = new StringSelectMenuBuilder()
    .setCustomId("au_build_category")
    .setPlaceholder("Select Settings Category")
    .addOptions(
      Object.entries(CATEGORIES).map(([key, meta]) => ({
        label: meta.label,
        value: key,
        description: meta.description,
        emoji: emojiObj(meta.iconKey),
        default: state.category === key,
      })),
    );

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(categorySelect),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Large),
  );

  buildCategoryControls(container, state);

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Large),
  );

  const saveBtn = new ButtonBuilder()
    .setCustomId("au_build_save")
    .setLabel("Save Preset")
    .setEmoji(emojiObj("SAVED"))
    .setStyle(ButtonStyle.Success);

  const backBtn = new ButtonBuilder()
    .setCustomId("au_build_back")
    .setLabel("Back")
    .setEmoji(emojiObj("SCROLL_UP"))
    .setStyle(ButtonStyle.Secondary);

  const cancelBtn = new ButtonBuilder()
    .setCustomId("au_build_cancel")
    .setLabel("Cancel")
    .setEmoji(emojiObj("ERROR"))
    .setStyle(ButtonStyle.Danger);

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(saveBtn, backBtn, cancelBtn),
  );

  return {
    components: [container],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  };
}

/**
 * Builds configuration summary and appends it to the container
 * @param {ContainerBuilder} container - The container builder
 * @param {Object} state - Current builder state
 */
function buildConfigurationSummary(container, state) {
  const mapId = validateMapIndex(state.mapId);
  const mapName = MAP_NAMES[mapId];
  const mapEmoji = icon(MAP_EMOJIS[mapId]);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### ${icon("AU_CAT_CORE")} Core\n\n` +
        `### \` ${pad("Map")} \` ${padV1(`${mapEmoji} ${mapName}`)}\` ${pad("Imposters")} \` ${padV2(`${icon("AU_IMPOSTOR")} ${state.impostors || 0}`)}\` ${pad("Players")} \` ${icon("MEMBERS")} ${state.maxPlayers || 0}`,
    ),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### ${icon("AU_CAT_RULES")} Rules\n\n` +
        `### \` ${pad("Speed")} \` ${padV1(`${icon("DONE")} ${state.playerSpeed || 1.0}x`)}\` ${pad("Cooldown")} \` ${padV2(`${icon("TIMER")} ${state.killCooldown || 0}s`)}\` ${pad("Anonymous")} \` : ${state.anonymousVotes === 1 ? "On" : "Off"}\n\n` +
        `### \` ${pad("Confirm")} \` : ${state.confirmImpostor === 1 ? "On" : "Off"}`,
    ),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### ${icon("AU_CAT_VISION")} Vision\n\n` +
        `### \` ${pad("Crewmate")} \` ${padV1(`${icon("MEMBERS")} ${state.crewVision || 1.0}x`)}\` ${pad("Imposter")} \` ${icon("AU_IMPOSTOR")} ${state.impVision || 1.5}x`,
    ),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
  );

  const tbuMap = { 0: "Always", 1: "Meetings", 2: "Never" };
  const visualVal = `: ${state.visualTasks === 1 ? "On" : "Off"}`;
  const visualPadded =
    visualVal + "\u00A0".repeat(state.visualTasks === 1 ? 12 : 11);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### ${icon("AU_CAT_TASKS")} Tasks\n\n` +
        `### \` ${pad("Common")} \` ${padV1(`: ${state.commonTasks || 0}`)}\` ${pad("Long")} \` ${padV2(`: ${state.longTasks || 0}`)}\` ${pad("Short")} \` : ${state.shortTasks || 0}\n\n` +
        `### \` ${pad("Visuals")} \` ${visualPadded}\` ${pad("Task Bar")} \` : ${tbuMap[state.taskBarUpdate] || "Always"}`,
    ),
  );

  const impRoles = [];
  if (state.shapeshifters > 0) impRoles.push(`${state.shapeshifters}x Shape`);
  if (state.phantoms > 0) impRoles.push(`${state.phantoms}x Phantom`);
  if (state.vipers > 0) impRoles.push(`${state.vipers}x Viper`);

  if (impRoles.length > 0) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### ${icon("AU_IMPOSTOR")} Impostor Roles\n\n` +
          `### \` ${pad("Roles")} \` ${impRoles.join(", ")}`,
      ),
    );
  }

  const crewRoles = [];
  if (state.scientists > 0) crewRoles.push(`${state.scientists}x Sci`);
  if (state.engineers > 0) crewRoles.push(`${state.engineers}x Eng`);
  if (state.angels > 0) crewRoles.push(`${state.angels}x Angel`);
  if (state.noisemakers > 0) crewRoles.push(`${state.noisemakers}x Noise`);
  if (state.trackers > 0) crewRoles.push(`${state.trackers}x Track`);
  if (state.detectives > 0) crewRoles.push(`${state.detectives}x Detec`);

  if (crewRoles.length > 0) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### ${icon("POWER_GREEN")} Crew Roles\n\n` +
          `### \` ${pad("Roles")} \` ${crewRoles.join(", ")}`,
      ),
    );
  }
}

/**
 * Builds category-specific controls and appends them to the container
 * @param {ContainerBuilder} container - The container builder
 * @param {Object} state - Current builder state
 */
function buildCategoryControls(container, state) {
  switch (state.category) {
    case "core":
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### Lobby Size`),
      );
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_imp")
            .setPlaceholder("Impostors")
            .addOptions(
              [1, 2, 3].map((n) => ({
                label: `${n} Impostor${n > 1 ? "s" : ""}`,
                value: n.toString(),
                emoji: emojiObj("AU_IMPOSTOR"),
                default: state.impostors === n,
              })),
            ),
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_ply")
            .setPlaceholder("Max Players")
            .addOptions(
              [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((n) => ({
                label: `${n} Players`,
                value: n.toString(),
                emoji: emojiObj("MEMBERS"),
                default: state.maxPlayers === n,
              })),
            ),
        ),
      );

      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
      );

      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### Location`),
      );
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_map")
            .setPlaceholder("Map Selection")
            .addOptions(
              MAP_NAMES.map((name, i) => ({
                label: name,
                value: i.toString(),
                emoji: emojiObj(MAP_EMOJIS[i]),
                default: state.mapId === i,
              })),
            ),
        ),
      );
      break;

    case "game_rules":
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### Movement & Cooldown`),
      );
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_spd")
            .setPlaceholder("Player Speed")
            .addOptions(
              generateArray("playerSpeed").map((n) => ({
                label: `${n}x Speed`,
                value: n.toString(),
                default: state.playerSpeed === n,
              })),
            ),
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_cd")
            .setPlaceholder("Kill Cooldown")
            .addOptions(
              generateArray("killCooldown").map((n) => ({
                label: `${n}s Cooldown`,
                value: n.toString(),
                default: state.killCooldown === n,
              })),
            ),
        ),
      );

      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
      );

      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### Meetings & Times`),
      );
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_meet")
            .setPlaceholder("Emergency Meetings")
            .addOptions(
              generateArray("emergencyMeetings").map((n) => ({
                label: `${n} Meeting${n !== 1 ? "s" : ""}`,
                value: n.toString(),
                default: state.emergencyMeetings === n,
              })),
            ),
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_mcd")
            .setPlaceholder("Emergency Cooldown")
            .addOptions(
              generateArray("emergencyCooldown").map((n) => ({
                label: `${n}s Cooldown`,
                value: n.toString(),
                default: state.emergencyCooldown === n,
              })),
            ),
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_disc")
            .setPlaceholder("Discussion Time")
            .addOptions(
              generateArray("discussionTime").map((n) => ({
                label: `${n}s Discussion`,
                value: n.toString(),
                default: state.discussionTime === n,
              })),
            ),
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_vote")
            .setPlaceholder("Voting Time")
            .addOptions(
              generateArray("votingTime").map((n) => ({
                label: `${n}s Voting`,
                value: n.toString(),
                default: state.votingTime === n,
              })),
            ),
        ),
      );

      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
      );

      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### Voting & Ejects`),
      );
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_anon")
            .setPlaceholder("Anonymous Votes")
            .addOptions([
              {
                label: "Anonymous Votes: Off",
                value: "0",
                default: state.anonymousVotes === 0,
              },
              {
                label: "Anonymous Votes: On",
                value: "1",
                default: state.anonymousVotes === 1,
              },
            ]),
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_conf")
            .setPlaceholder("Confirm Ejects")
            .addOptions([
              {
                label: "Confirm Ejects: Off",
                value: "0",
                default: state.confirmImpostor === 0,
              },
              {
                label: "Confirm Ejects: On",
                value: "1",
                default: state.confirmImpostor === 1,
              },
            ]),
        ),
      );
      break;

    case "game_vision":
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### Vision Multipliers`),
      );
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_cv")
            .setPlaceholder("Crewmate Vision")
            .addOptions(
              generateArray("crewVision").map((n) => ({
                label: `${n}x Crew Vision`,
                value: n.toString(),
                emoji: emojiObj("MEMBERS"),
                default: state.crewVision === n,
              })),
            ),
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_iv")
            .setPlaceholder("Impostor Vision")
            .addOptions(
              generateArray("impVision").map((n) => ({
                label: `${n}x Imp Vision`,
                value: n.toString(),
                emoji: emojiObj("AU_IMPOSTOR"),
                default: state.impVision === n,
              })),
            ),
        ),
      );
      break;

    case "tasks":
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### Task Distribution`),
      );
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_tcom")
            .setPlaceholder("Common Tasks")
            .addOptions(
              generateArray("commonTasks").map((n) => ({
                label: `${n} Common Task${n !== 1 ? "s" : ""}`,
                value: n.toString(),
                default: state.commonTasks === n,
              })),
            ),
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_tlng")
            .setPlaceholder("Long Tasks")
            .addOptions(
              generateArray("longTasks").map((n) => ({
                label: `${n} Long Task${n !== 1 ? "s" : ""}`,
                value: n.toString(),
                default: state.longTasks === n,
              })),
            ),
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_tsht")
            .setPlaceholder("Short Tasks")
            .addOptions(
              generateArray("shortTasks").map((n) => ({
                label: `${n} Short Task${n !== 1 ? "s" : ""}`,
                value: n.toString(),
                default: state.shortTasks === n,
              })),
            ),
        ),
      );

      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
      );

      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### Visuals & Updates`),
      );
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_vis")
            .setPlaceholder("Visual Tasks")
            .addOptions([
              {
                label: "Visual Tasks: Off",
                value: "0",
                default: state.visualTasks === 0,
              },
              {
                label: "Visual Tasks: On",
                value: "1",
                default: state.visualTasks === 1,
              },
            ]),
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_tbar")
            .setPlaceholder("Task Bar Updates")
            .addOptions([
              {
                label: "Task Bar: Always",
                value: "0",
                default: state.taskBarUpdate === 0,
              },
              {
                label: "Task Bar: Meetings",
                value: "1",
                default: state.taskBarUpdate === 1,
              },
              {
                label: "Task Bar: Never",
                value: "2",
                default: state.taskBarUpdate === 2,
              },
            ]),
        ),
      );
      break;

    case "roles_imp":
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### Impostor Roles Allocation`),
      );
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_ss")
            .setPlaceholder("Shapeshifters")
            .addOptions(
              [0, 1, 2, 3, 4, 5].map((n) => ({
                label: `${n} Shapeshifter${n !== 1 ? "s" : ""}`,
                value: n.toString(),
                emoji: emojiObj("ROLE_SHAPESHIFTER"),
                default: state.shapeshifters === n,
              })),
            ),
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_phantom")
            .setPlaceholder("Phantoms")
            .addOptions(
              [0, 1, 2, 3, 4, 5].map((n) => ({
                label: `${n} Phantom${n !== 1 ? "s" : ""}`,
                value: n.toString(),
                emoji: emojiObj("ROLE_PHANTOM"),
                default: state.phantoms === n,
              })),
            ),
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_viper")
            .setPlaceholder("Vipers")
            .addOptions(
              [0, 1, 2, 3, 4, 5].map((n) => ({
                label: `${n} Viper${n !== 1 ? "s" : ""}`,
                value: n.toString(),
                emoji: emojiObj("ROLE_VIPER"),
                default: state.vipers === n,
              })),
            ),
        ),
      );
      break;

    case "roles_crew1":
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### Crewmate Roles I`),
      );
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_sci")
            .setPlaceholder("Scientists")
            .addOptions(
              [0, 1, 2, 3, 4, 5].map((n) => ({
                label: `${n} Scientist${n !== 1 ? "s" : ""}`,
                value: n.toString(),
                emoji: emojiObj("ROLE_SCIENTIST"),
                default: state.scientists === n,
              })),
            ),
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_eng")
            .setPlaceholder("Engineers")
            .addOptions(
              [0, 1, 2, 3, 4, 5].map((n) => ({
                label: `${n} Engineer${n !== 1 ? "s" : ""}`,
                value: n.toString(),
                emoji: emojiObj("ROLE_ENGINEER"),
                default: state.engineers === n,
              })),
            ),
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_tracker")
            .setPlaceholder("Trackers")
            .addOptions(
              [0, 1, 2, 3, 4, 5].map((n) => ({
                label: `${n} Tracker${n !== 1 ? "s" : ""}`,
                value: n.toString(),
                emoji: emojiObj("ROLE_TRACKER"),
                default: state.trackers === n,
              })),
            ),
        ),
      );
      break;

    case "roles_crew2":
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### Crewmate Roles II`),
      );
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_ga")
            .setPlaceholder("Guardian Angels")
            .addOptions(
              [0, 1, 2, 3, 4, 5].map((n) => ({
                label: `${n} Guardian Angel${n !== 1 ? "s" : ""}`,
                value: n.toString(),
                emoji: emojiObj("ROLE_GUARDIANANGEL"),
                default: state.angels === n,
              })),
            ),
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_noise")
            .setPlaceholder("Noisemakers")
            .addOptions(
              [0, 1, 2, 3, 4, 5].map((n) => ({
                label: `${n} Noisemaker${n !== 1 ? "s" : ""}`,
                value: n.toString(),
                emoji: emojiObj("ROLE_NOISEMAKER"),
                default: state.noisemakers === n,
              })),
            ),
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_det")
            .setPlaceholder("Detectives")
            .addOptions(
              [0, 1, 2, 3, 4, 5].map((n) => ({
                label: `${n} Detective${n !== 1 ? "s" : ""}`,
                value: n.toString(),
                emoji: emojiObj("ROLE_DETECTIVE"),
                default: state.detectives === n,
              })),
            ),
        ),
      );
      break;
  }
}

/**
 * Builds preset info UI
 * @returns {Object} Discord message payload
 */
export function buildPresetInfoUI() {
  const container = new ContainerBuilder().setAccentColor(COLORS.EPHEMERAL);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### ${icon("HELP_HEADER")} Among Us Presets\n` +
        `Quick-launch presets for instant gameplay.`,
    ),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${icon("LAUNCH_GREEN")}  Classic\n` +
        `### ${col1(`${icon("AU_MAP_SKELD")} The Skeld`)}${col2(`${icon("AU_IMPOSTOR")} 2 Imposters`)}${icon("MEMBERS")} 15 Players\n` +
        `### ${icon("TIMER")} 27.5s Cooldown`,
    ),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${icon("LAUNCH_MAGENTA")}  Chill\n` +
        `### ${col1(`${icon("AU_MAP_SKELD")} The Skeld`)}${col2(`${icon("AU_IMPOSTOR")} 2 Imposters`)}${icon("MEMBERS")} 15 Players\n` +
        `### ${col1(`${icon("ROLE_GUARDIANANGEL")} 1 Angel`)}${icon("TIMER")} 27.5s Cooldown`,
    ),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${icon("LAUNCH_VIOLET")}  Chaos\n` +
        `### ${col1(`${icon("AU_MAP_SKELD")} The Skeld`)}${col2(`${icon("AU_IMPOSTOR")} 2 Imposters`)}${icon("MEMBERS")} 15 Players\n` +
        `### ${col1(`${icon("ROLE_SHAPESHIFTER")} 1 Shape`)}${col2(`${icon("ROLE_GUARDIANANGEL")} 1 Angel`)}${icon("TIMER")} 27.5s Cooldown`,
    ),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${icon("LAUNCH_YELLOW")}  Trio-Mess\n` +
        `### ${col1(`${icon("AU_MAP_SKELD")} The Skeld`)}${col2(`${icon("AU_IMPOSTOR")} 3 Imposters`)}${icon("MEMBERS")} 15 Players\n` +
        `### ${col1(`${icon("ROLE_GUARDIANANGEL")} 2 Angel`)}${icon("TIMER")} 30s Cooldown`,
    ),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${icon("LAUNCH_TEAL")}  Hardcore\n` +
        `### ${col1(`${icon("AU_MAP_SKELD")} The Skeld`)}${col2(`${icon("AU_IMPOSTOR")} 2 Imposters`)}${icon("MEMBERS")} 15 Players\n` +
        `### ${col1(`${icon("ROLE_SHAPESHIFTER")} 1 Shape`)}${col2(`${icon("ROLE_VIPER")} 1 Viper`)}${icon("TIMER")} 27.5s Cooldown\n` +
        `### ${col1(`${icon("ROLE_DETECTIVE")} 1 Detec`)}${icon("ROLE_GUARDIANANGEL")} 2 Angel`,
    ),
  );

  const backBtn = new ButtonBuilder()
    .setCustomId("au_back_to_main")
    .setLabel("Back")
    .setEmoji(emojiObj("SCROLL_UP"))
    .setStyle(ButtonStyle.Secondary);

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(backBtn),
  );

  return {
    components: [container],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  };
}

/**
 * Builds success message UI
 * @param {string} title - Success title
 * @param {string} message - Success message
 * @returns {Object} Discord message payload
 */
export function buildSuccessUI(title, message) {
  const container = new ContainerBuilder().setAccentColor(COLORS.SUCCESS);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### ${icon("SUCCESS")} ${title}\n\n${message}`,
    ),
  );

  return {
    components: [container],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  };
}

/**
 * Builds error message UI
 * @param {string} title - Error title
 * @param {string} message - Error message
 * @returns {Object} Discord message payload
 */
export function buildErrorUI(title, message) {
  const container = new ContainerBuilder().setAccentColor(COLORS.DANGER);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### ${icon("ERROR")} ${title}\n\n${message}`,
    ),
  );

  return {
    components: [container],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  };
}

/**
 * Builds the Help/FAQ UI
 * @returns {Object} Discord message payload
 */
export function buildHelpUI() {
  const container = new ContainerBuilder().setAccentColor(COLORS.PRIMARY);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`### ${icon("HELP_HEADER")} NexKord Among Us FAQ`)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**Q: How does the connection work?**\n` +
      `**A:** NexKord runs a custom Among Us server. When you click "Connect to Lobby", it uses a deep-link (\`amongus://init...\`) that temporarily configures your game to connect to our private server instead of InnerSloth's.`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**Q: Is it safe to play on NexKord?**\n` +
      `**A:** Yes, 100% safe. We only change the network endpoint your game connects to. Your account data, cosmetics, and game files remain perfectly secure, and playing on private servers is fully allowed.`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**Q: How do I reset my game back to normal?**\n` +
      `**A:** You can click the **Reset** button on the dashboard for instructions, or simply open Among Us, go to **Online**, click the **Globe Icon** in the bottom right, and select a default region (North America, Europe, or Asia).`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**Q: How do I enable Free Chat in my lobby?**\n` +
      `**A:** Chat mode is determined by the **first person who joins the room (the Host)**. To ensure the lobby is Free Chat, the host must have an authenticated 13+ account with "Free or Quick Chat" enabled in their in-game Data settings. If the first person to join has a guest or underage account, the entire room will be restricted to Quick Chat Only.`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  const backBtn = new ButtonBuilder()
    .setCustomId("au_back_to_main")
    .setLabel("Back to Dashboard")
    .setEmoji(emojiObj("SCROLL_UP"))
    .setStyle(ButtonStyle.Secondary);

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(backBtn)
  );

  return {
    components: [container],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  };
}
