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

const COLORS = {
  PRIMARY: 0x00ffff,
  EPHEMERAL: 0x2b2d31,
  SUCCESS: 0x57f287,
  DANGER: 0xed4245,
  WARNING: 0xfee75c,
};

const MAP_NAMES = ["The Skeld", "Mira HQ", "Polus", "Airship", "The Fungle"];
const MAP_EMOJIS = [
  "AU_MAP_SKELD",
  "AU_MAP_MIRA",
  "AU_MAP_POLUS",
  "AU_MAP_AIRSHIP",
  "AU_MAP_FUNGLE"
];

const CATEGORIES = {
  core: { label: "Core Settings", iconKey: "AU_CAT_CORE", description: "Players, Impostors, Map" },
  game_rules: { label: "Game Rules", iconKey: "AU_CAT_RULES", description: "Speed, Cooldown" },
  game_vision: { label: "Vision Settings", iconKey: "AU_CAT_VISION", description: "Crew & Impostor Vision" },
  tasks: { label: "Task Settings", iconKey: "AU_CAT_TASKS", description: "Common, Long, Short Tasks" },
  roles_imp: { label: "Impostor Roles", iconKey: "ROLE_SHAPESHIFTER", description: "Shapeshifter, Phantom, Viper" },
  roles_crew1: { label: "Crew Roles I", iconKey: "ROLE_SCIENTIST", description: "Scientist, Engineer, Tracker" },
  roles_crew2: { label: "Crew Roles II", iconKey: "ROLE_GUARDIANANGEL", description: "Guardian Angel, Noisemaker, Detective" },
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
      `Create and manage your personalized Among Us lobby configurations.`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  const presetKeys = Object.keys(presets).slice(0, MAX_PRESET_DISPLAY);

  if (presetKeys.length > 0) {
    const presetList = presetKeys.map(key => {
      const p = presets[key];
      if (!p || typeof p !== "object") return null;

      const mapId = validateMapIndex(p.map);
      const mapName = MAP_NAMES[mapId];
      const mapEmoji = icon(MAP_EMOJIS[mapId]);

      const roleCount =
        (p.shapeshifters || 0) + (p.phantoms || 0) + (p.vipers || 0) +
        (p.scientists || 0) + (p.engineers || 0) + (p.angels || 0) +
        (p.noisemakers || 0) + (p.trackers || 0) + (p.detectives || 0);

      return `${icon("LAUNCH_GREEN")} **${key}**\n` +
             `${mapEmoji}  ${mapName}  •  ${p.impostors || 0}  ${icon("AU_IMPOSTOR")}  •  ${p.maxPlayers || 0}  ${icon("MEMBERS")}  •  ${roleCount}  Roles\n` +
             `${icon("TIMER")}  ${p.killCooldown || 0}s  CD  • ${icon("MICRO_YELLOW")}  ${p.playerSpeed || 1.0}x Speed`;
    }).filter(Boolean).join("\n\n");

    if (presetList) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(presetList));

      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
      );

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId("au_select_custom_preset")
        .setPlaceholder("Select a preset to launch...")
        .addOptions(
          presetKeys.map(key => {
            const p = presets[key];
            const mapId = validateMapIndex(p.map);
            const mapEmoji = emojiObj(MAP_EMOJIS[mapId]);
            return {
              label: key.substring(0, 100),
              description: `${p.impostors || 0} Imp • ${p.maxPlayers || 0} Players • ${p.killCooldown || 0}s CD`,
              value: key,
              emoji: mapEmoji,
            };
          })
        );

      container.addActionRowComponents(new ActionRowBuilder().addComponents(selectMenu));
    }
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**No Custom Presets Yet**\n\n` +
        `You haven't created any custom presets. Click the button below to create your first one!\n\n` +
        `Custom presets let you save your favorite game configurations for quick access.`
      )
    );

    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
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
    new ActionRowBuilder().addComponents(createBtn, backBtn)
  );

  return {
    components: [container],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  };
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
    new TextDisplayBuilder().setContent(
      `### ${icon("EDITOR")} Preset Builder`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  const summary = buildConfigurationSummary(state);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(summary));

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
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
      }))
    );

  const rows = [new ActionRowBuilder().addComponents(categorySelect)];

  const categoryRows = buildCategoryControls(state);
  rows.push(...categoryRows);

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

  rows.push(new ActionRowBuilder().addComponents(saveBtn, backBtn, cancelBtn));

  if (rows.length > 5) {
    rows.splice(4, rows.length - 5);
  }

  container.addActionRowComponents(...rows);

  return {
    components: [container],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  };
}

/**
 * Builds configuration summary
 * @param {Object} state - Current builder state
 * @returns {string} Formatted summary
 */
function buildConfigurationSummary(state) {
  const mapId = validateMapIndex(state.mapId);
  const mapName = MAP_NAMES[mapId];
  const mapEmoji = icon(MAP_EMOJIS[mapId]);

  const sections = [];

  sections.push(
    `${icon("AU_CAT_CORE")}\u00A0\u00A0**Core**\n` +
    `> ${mapEmoji}\u00A0\u00A0${mapName} \u00A0•\u00A0 ${state.impostors || 0} ${icon("AU_IMPOSTOR")}\u00A0\u00A0Impostors \u00A0•\u00A0 ${state.maxPlayers || 0} ${icon("MEMBERS")}\u00A0\u00A0Players`
  );

  sections.push(
    `${icon("AU_CAT_RULES")}\u00A0\u00A0**Rules**\n` +
    `> ${icon("MICRO_YELLOW")}\u00A0\u00A0${state.playerSpeed || 1.0}x Speed \u00A0•\u00A0 ${icon("TIMER")}\u00A0\u00A0${state.killCooldown || 0}s Kill Cooldown`
  );

  sections.push(
    `${icon("AU_CAT_VISION")}\u00A0\u00A0**Vision**\n` +
    `> ${icon("MEMBERS")}\u00A0\u00A0${state.crewVision || 1.0}x Crew \u00A0•\u00A0 ${icon("AU_IMPOSTOR")}\u00A0\u00A0${state.impVision || 1.5}x Impostor`
  );

  sections.push(
    `${icon("AU_CAT_TASKS")}\u00A0\u00A0**Tasks**\n` +
    `> ${state.commonTasks || 0} Common \u00A0•\u00A0 ${state.longTasks || 0} Long \u00A0•\u00A0 ${state.shortTasks || 0} Short`
  );

  const impRoles = [];
  if (state.shapeshifters > 0) impRoles.push(`${state.shapeshifters} Shapeshifter`);
  if (state.phantoms > 0) impRoles.push(`${state.phantoms} Phantom`);
  if (state.vipers > 0) impRoles.push(`${state.vipers} Viper`);

  if (impRoles.length > 0) {
    sections.push(`${icon("AU_IMPOSTOR")}\u00A0\u00A0**Impostor Roles**\n> ${impRoles.join(" \u00A0•\u00A0 ")}`);
  }

  const crewRoles = [];
  if (state.scientists > 0) crewRoles.push(`${state.scientists} Scientist`);
  if (state.engineers > 0) crewRoles.push(`${state.engineers} Engineer`);
  if (state.angels > 0) crewRoles.push(`${state.angels} Guardian Angel`);
  if (state.noisemakers > 0) crewRoles.push(`${state.noisemakers} Noisemaker`);
  if (state.trackers > 0) crewRoles.push(`${state.trackers} Tracker`);
  if (state.detectives > 0) crewRoles.push(`${state.detectives} Detective`);

  if (crewRoles.length > 0) {
    sections.push(`${icon("POWER_GREEN")}\u00A0\u00A0**Crew Roles**\n> ${crewRoles.join(" \u00A0•\u00A0 ")}`);
  }

  return sections.join("\n\n");
}

/**
 * Builds category-specific controls
 * @param {Object} state - Current builder state
 * @returns {ActionRowBuilder[]} Array of action rows
 */
function buildCategoryControls(state) {
  const rows = [];

  switch (state.category) {
    case "core":
      rows.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_imp")
            .setPlaceholder("Impostors")
            .addOptions([1, 2, 3].map(n => ({
              label: `${n} Impostor${n > 1 ? "s" : ""}`,
              value: n.toString(),
              emoji: emojiObj("AU_IMPOSTOR"),
              default: state.impostors === n,
            })))
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_ply")
            .setPlaceholder("Max Players")
            .addOptions([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(n => ({
              label: `${n} Players`,
              value: n.toString(),
              emoji: emojiObj("MEMBERS"),
              default: state.maxPlayers === n,
            })))
        ),
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
              }))
            )
        )
      );
      break;

    case "game_rules":
      rows.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_spd")
            .setPlaceholder("Player Speed")
            .addOptions([0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0].map(n => ({
              label: `${n}x Speed`,
              value: n.toString(),
              default: state.playerSpeed === n,
            })))
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_cd")
            .setPlaceholder("Kill Cooldown")
            .addOptions([10, 15, 20, 22.5, 25, 27.5, 30, 35, 40, 45, 50, 60].map(n => ({
              label: `${n}s Cooldown`,
              value: n.toString(),
              default: state.killCooldown === n,
            })))
        )
      );
      break;

    case "game_vision":
      rows.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_cv")
            .setPlaceholder("Crewmate Vision")
            .addOptions([0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 5.0].map(n => ({
              label: `${n}x Crew Vision`,
              value: n.toString(),
              emoji: emojiObj("MEMBERS"),
              default: state.crewVision === n,
            })))
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_iv")
            .setPlaceholder("Impostor Vision")
            .addOptions([0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 5.0].map(n => ({
              label: `${n}x Imp Vision`,
              value: n.toString(),
              emoji: emojiObj("AU_IMPOSTOR"),
              default: state.impVision === n,
            })))
        )
      );
      break;

    case "tasks":
      rows.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_tcom")
            .setPlaceholder("Common Tasks")
            .addOptions([0, 1, 2].map(n => ({
              label: `${n} Common Task${n !== 1 ? "s" : ""}`,
              value: n.toString(),
              default: state.commonTasks === n,
            })))
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_tlng")
            .setPlaceholder("Long Tasks")
            .addOptions([0, 1, 2, 3].map(n => ({
              label: `${n} Long Task${n !== 1 ? "s" : ""}`,
              value: n.toString(),
              default: state.longTasks === n,
            })))
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_tsht")
            .setPlaceholder("Short Tasks")
            .addOptions([0, 1, 2, 3, 4, 5].map(n => ({
              label: `${n} Short Task${n !== 1 ? "s" : ""}`,
              value: n.toString(),
              default: state.shortTasks === n,
            })))
        )
      );
      break;

    case "roles_imp":
      rows.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_ss")
            .setPlaceholder("Shapeshifters")
            .addOptions([0, 1, 2, 3, 4, 5].map(n => ({
              label: `${n} Shapeshifter${n !== 1 ? "s" : ""}`,
              value: n.toString(),
              emoji: emojiObj("ROLE_SHAPESHIFTER"),
              default: state.shapeshifters === n,
            })))
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_phantom")
            .setPlaceholder("Phantoms")
            .addOptions([0, 1, 2, 3, 4, 5].map(n => ({
              label: `${n} Phantom${n !== 1 ? "s" : ""}`,
              value: n.toString(),
              emoji: emojiObj("ROLE_PHANTOM"),
              default: state.phantoms === n,
            })))
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_viper")
            .setPlaceholder("Vipers")
            .addOptions([0, 1, 2, 3, 4, 5].map(n => ({
              label: `${n} Viper${n !== 1 ? "s" : ""}`,
              value: n.toString(),
              emoji: emojiObj("ROLE_VIPER"),
              default: state.vipers === n,
            })))
        )
      );
      break;

    case "roles_crew1":
      rows.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_sci")
            .setPlaceholder("Scientists")
            .addOptions([0, 1, 2, 3, 4, 5].map(n => ({
              label: `${n} Scientist${n !== 1 ? "s" : ""}`,
              value: n.toString(),
              emoji: emojiObj("ROLE_SCIENTIST"),
              default: state.scientists === n,
            })))
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_eng")
            .setPlaceholder("Engineers")
            .addOptions([0, 1, 2, 3, 4, 5].map(n => ({
              label: `${n} Engineer${n !== 1 ? "s" : ""}`,
              value: n.toString(),
              emoji: emojiObj("ROLE_ENGINEER"),
              default: state.engineers === n,
            })))
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_tracker")
            .setPlaceholder("Trackers")
            .addOptions([0, 1, 2, 3, 4, 5].map(n => ({
              label: `${n} Tracker${n !== 1 ? "s" : ""}`,
              value: n.toString(),
              emoji: emojiObj("ROLE_TRACKER"),
              default: state.trackers === n,
            })))
        )
      );
      break;

    case "roles_crew2":
      rows.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_ga")
            .setPlaceholder("Guardian Angels")
            .addOptions([0, 1, 2, 3, 4, 5].map(n => ({
              label: `${n} Guardian Angel${n !== 1 ? "s" : ""}`,
              value: n.toString(),
              emoji: emojiObj("ROLE_GUARDIANANGEL"),
              default: state.angels === n,
            })))
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_noise")
            .setPlaceholder("Noisemakers")
            .addOptions([0, 1, 2, 3, 4, 5].map(n => ({
              label: `${n} Noisemaker${n !== 1 ? "s" : ""}`,
              value: n.toString(),
              emoji: emojiObj("ROLE_NOISEMAKER"),
              default: state.noisemakers === n,
            })))
        ),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("au_build_det")
            .setPlaceholder("Detectives")
            .addOptions([0, 1, 2, 3, 4, 5].map(n => ({
              label: `${n} Detective${n !== 1 ? "s" : ""}`,
              value: n.toString(),
              emoji: emojiObj("ROLE_DETECTIVE"),
              default: state.detectives === n,
            })))
        )
      );
      break;
  }

  return rows;
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
      `Quick-launch presets for instant gameplay.`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `${icon("LAUNCH_GREEN")} **Classic**\n` +
      `${icon("AU_MAP_SKELD")} The Skeld • 2 ${icon("AU_IMPOSTOR")} • 15 ${icon("MEMBERS")}\n` +
      `${icon("TIMER")} 25s Kill Cooldown\n\n` +

      `${icon("LAUNCH_MAGENTA")} **Chaos**\n` +
      `${icon("AU_MAP_SKELD")} The Skeld • 3 ${icon("AU_IMPOSTOR")} • 15 ${icon("MEMBERS")}\n` +
      `${icon("TIMER")} 25s Kill Cooldown\n\n` +

      `${icon("LAUNCH_VIOLET")} **Shapeshifter**\n` +
      `${icon("AU_MAP_SKELD")} The Skeld • 3 ${icon("AU_IMPOSTOR")} • 15 ${icon("MEMBERS")}\n` +
      `${icon("ROLE_SHAPESHIFTER")} 1 Shapeshifter • ${icon("TIMER")} 25s Kill Cooldown`
    )
  );

  const backBtn = new ButtonBuilder()
    .setCustomId("au_back_to_main")
    .setLabel("Back")
    .setEmoji(emojiObj("SCROLL_UP"))
    .setStyle(ButtonStyle.Secondary);

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  container.addActionRowComponents(new ActionRowBuilder().addComponents(backBtn));

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
    new TextDisplayBuilder().setContent(`### ${icon("SUCCESS")} ${title}\n\n${message}`)
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
    new TextDisplayBuilder().setContent(`### ${icon("ERROR")} ${title}\n\n${message}`)
  );

  return {
    components: [container],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  };
}
