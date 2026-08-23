import { REST, Routes } from "discord.js";
import { commandDefinitions } from "./commands.js";
import dotenv from "dotenv";

dotenv.config();

const FORCE_CLEAR = process.argv.includes("--clear");

(async () => {
  if (commandDefinitions.length === 0 && !FORCE_CLEAR) {
    console.log(
      "[deploy] No command definitions on this branch — skipping registration.",
    );
    console.log(
      "[deploy] Pass --clear to deliberately remove all guild commands.",
    );
    return;
  }

  const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
  const missing = Object.entries({ DISCORD_TOKEN, CLIENT_ID, GUILD_ID })
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    console.error(`[deploy] Missing required env: ${missing.join(", ")}`);
    return;
  }

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  try {
    const body = commandDefinitions.map((cmd) => cmd.toJSON());
    console.log(
      FORCE_CLEAR && body.length === 0
        ? "[deploy] Clearing all guild commands."
        : `[deploy] Registering ${body.length} guild command(s).`,
    );

    const data = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body },
    );

    console.log(`[deploy] Guild now has ${data.length} command(s).`);
  } catch (error) {
    console.error("[deploy] Registration failed:", error?.message ?? error);
  }
})();
