import path from "node:path";
import { clampServerIndex } from "./resolvers.js";
import { config } from "./config.js";
import {
  readJsonFileSync,
  writeJsonFileAtomicSync,
} from "../utils/jsonStore.js";

const dataDir = path.join(process.cwd(), "data");
const panelStoreFile = path.join(dataDir, "panelStore.json");

function validPanelStore(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number.isSafeInteger(value.activeServerIndex)
  );
}

export class PanelManager {
  constructor(client, streamer, scheduler) {
    this.client = client;
    this.streamer = streamer;
    this.scheduler = scheduler;
    this.activeServerIndex = clampServerIndex(config.defaultServerIndex);
    this.loadStore();
  }

  loadStore() {
    const stored = readJsonFileSync(panelStoreFile, {
      fallback: { activeServerIndex: this.activeServerIndex },
      validate: validPanelStore,
      label: "selfbot panel state",
    });
    this.activeServerIndex = clampServerIndex(stored.activeServerIndex);
  }

  saveStore() {
    writeJsonFileAtomicSync(panelStoreFile, {
      activeServerIndex: this.activeServerIndex,
    });
  }

  setActiveServerIndex(value) {
    const next = clampServerIndex(value);
    writeJsonFileAtomicSync(panelStoreFile, { activeServerIndex: next });
    this.activeServerIndex = next;
    return next;
  }
}
