import { createImpostorLobby } from "./impostor.js";
import { auditLog } from "../../utils/logger.js";
import { eReply } from "../../utils/embed.js";
import { icon } from "../../utils/icons.js";
import { MessageFlags } from "discord.js";

/**
 * Handles Among Us button interactions from the dashboard.
 * Processes lobby creation requests and responds with room codes and connection instructions.
 *
 * @async
 * @param {import('discord.js').Interaction} interaction - The Discord interaction object
 * @returns {Promise<boolean>} True if the interaction was handled, false otherwise
 *
 * @description
 * This function intercepts button clicks with custom IDs starting with "au_create_".
 * It creates a lobby on the Impostor server and provides users with:
 * - A 6-character room code
 * - Connection instructions for PC/Android (regionInfo.json method)
 * - A deep link for iOS/Android (no app modification required)
 *
 * @example
 * client.on('interactionCreate', async (interaction) => {
 *   const handled = await handleAmongUsInteraction(interaction);
 *   if (!handled) {
 *     // Handle other interactions
 *   }
 * });
 */
export async function handleAmongUsInteraction(interaction) {
  if (!interaction.isButton()) return false;

  if (interaction.customId.startsWith("au_create_")) {
    const preset = interaction.customId.replace("au_create_", "");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      auditLog("info", "AMONGUS_LOBBY", `${interaction.user.tag} requested ${preset} lobby via dashboard`);
      const code = await createImpostorLobby(preset);

      const serverIp = process.env.IMPOSTOR_SERVER_IP || "play.nexkord.com";
      const deepLink = `amongus://init?servername=NexKord&serverip=${serverIp}&serverport=22023&usedtls=false`;

      await interaction.editReply(
        eReply(
          "Among Us Custom Lobby Created",
          `${icon("SUCCESS")} Successfully created a lobby on the NexKord Custom Server!\n\n` +
          `**Room Code:** \`${code}\`\n` +
          `**Preset:** \`${preset}\`\n\n` +
          `### How to Connect\n` +
          `**PC / Android:** Make sure your \`regionInfo.json\` is set to NexKord.\n` +
          `**iOS / Android (Auto):** Open Among Us in the background, then click this link:\n` +
          `[Tap here to connect to NexKord Server](${deepLink})`
        )
      );
    } catch (error) {
      auditLog("error", "AMONGUS_LOBBY_FAIL", `${interaction.user.tag} failed to create lobby: ${error.message}`);
      await interaction.editReply(
        eReply("Lobby Creation Failed", `${icon("ERROR")} ${error.message}`)
      );
    }
    return true;
  }

  return false;
}
