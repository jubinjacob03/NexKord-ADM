import dotenv from "dotenv";
dotenv.config();

function loadScreens() {
  const screens = [];
  for (let i = 1; i <= 10; i++) {
    const name = process.env[`CINEMA_SCREEN_${i}_NAME`];
    if (!name) break;
    screens.push({
      id: i,
      name,
      channelId: process.env[`CINEMA_SCREEN_${i}_CHANNEL_ID`] || "",
      voiceChannelId: process.env[`CINEMA_SCREEN_${i}_VOICE_CHANNEL_ID`] || "",
      prefix: process.env[`CINEMA_SCREEN_${i}_PREFIX`] || "!",
    });
  }
  return screens;
}

let screens = [];

export function initScreens() {
  screens = loadScreens();
  if (screens.length === 0) {
    console.warn(
      "[CINEMA] No screens configured. Add CINEMA_SCREEN_1_NAME etc. to .env",
    );
  } else {
    console.log(
      `[CINEMA] ${screens.length} screen(s) loaded: ${screens.map((s) => s.name).join(", ")}`,
    );
  }
}

export function getScreens() {
  return screens;
}

export function getScreen(id) {
  return screens.find((s) => s.id === id) || null;
}

export function screenChoices() {
  return screens.map((s) => ({ label: s.name, value: String(s.id) }));
}
