import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const GAME_LIMITS = JSON.parse(fs.readFileSync(path.join(__dirname, "game-limits.json"), "utf8"));

export const generateArray = (limitKey) => {
  const limit = GAME_LIMITS[limitKey];
  if (!limit) return [];
  const { min, max, step } = limit;
  const arr = [];
  for (let i = min; i <= max; i += step) {
    arr.push(Number(i.toFixed(2)));
  }
  return arr;
};

export const clampValue = (val, limitKey) => {
  const limit = GAME_LIMITS[limitKey];
  if (!limit) return val;
  const { min, max, step } = limit;
  
  if (val < min) return min;
  if (val > max) return max;
  
  const steps = Math.round((val - min) / step);
  return Number((min + (steps * step)).toFixed(2));
};
