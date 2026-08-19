import fs from "fs";
import path from "path";
import { clampServerIndex } from "./resolvers.js";
import { config } from "./config.js";

const dataDir = path.join(process.cwd(), "data");
const panelStoreFile = path.join(dataDir, "panelStore.json");

export class PanelManager {
  constructor(client, streamer, scheduler) {
    this.client = client;
    this.streamer = streamer;
    this.scheduler = scheduler;
    this.activeServerIndex = clampServerIndex(config.defaultServerIndex);
    this.loadStore();
  }

  loadStore() {
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(panelStoreFile)) return;
    try {
      const data = JSON.parse(fs.readFileSync(panelStoreFile, "utf8"));
      if (data.activeServerIndex !== undefined) {
        this.activeServerIndex = clampServerIndex(data.activeServerIndex);
      }
    } catch {}
  }

  saveStore() {
    try {
      fs.writeFileSync(
        panelStoreFile,
        JSON.stringify({ activeServerIndex: this.activeServerIndex }),
        "utf8",
      );
    } catch {}
  }

  async initPanel() {}
  async refreshPanel() {}
}
