import { MessageFlags } from "discord.js";
import { eReply } from "./utils/embed.js";

export const commandDefinitions = [];

export async function handleSlashCommand(interaction) {
  if (interaction.isAutocomplete()) {
    await interaction.respond([]);
    return;
  }

  if (interaction.isChatInputCommand()) {
    await interaction.reply({
      ...eReply(
        "Unavailable",
        "This command is no longer available in this branch.",
      ),
      flags: MessageFlags.Ephemeral,
    });
  }
}
