import fs from "fs";
import path from "path";

const dataDir = path.join(process.cwd(), "data");
const scheduleFile = path.join(dataDir, "cinema-schedule.json");

let schedule = [];

export function loadSchedule() {
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    schedule = JSON.parse(fs.readFileSync(scheduleFile, "utf8"));
    if (!Array.isArray(schedule)) schedule = [];
  } catch {
    schedule = [];
  }
}

function save() {
  fs.writeFileSync(scheduleFile, JSON.stringify(schedule), "utf8");
}

export function addShow({
  title,
  year,
  overview,
  posterUrl,
  showtimeUnix,
  screenId,
  tmdbId,
  mediaType,
}) {
  const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const show = {
    id,
    title,
    year: year || "",
    overview: overview || "",
    posterUrl: posterUrl || "",
    showtimeUnix,
    screenId,
    tmdbId: tmdbId || null,
    mediaType: mediaType || "movie",
    status: "scheduled",
    messageId: null,
    createdAt: Date.now(),
  };
  schedule.push(show);
  schedule.sort((a, b) => a.showtimeUnix - b.showtimeUnix);
  save();
  return show;
}

export function cancelShow(id) {
  const show = schedule.find((s) => s.id === id);
  if (!show || show.status !== "scheduled") return null;
  show.status = "cancelled";
  save();
  return show;
}

export function getUpcoming(screenId) {
  const now = Math.floor(Date.now() / 1000);
  return schedule.filter(
    (s) =>
      s.status === "scheduled" &&
      s.showtimeUnix > now &&
      (screenId === undefined || s.screenId === screenId),
  );
}

export function getDueShows(graceSeconds = 900) {
  const now = Math.floor(Date.now() / 1000);
  return schedule.filter(
    (s) =>
      s.status === "scheduled" &&
      s.showtimeUnix <= now &&
      now - s.showtimeUnix <= graceSeconds,
  );
}

export function setShowStatus(id, status) {
  const show = schedule.find((s) => s.id === id);
  if (!show) return null;
  show.status = status;
  save();
  return show;
}

export function expireStaleShows(graceSeconds = 900) {
  const now = Math.floor(Date.now() / 1000);
  const stale = schedule.filter(
    (s) => s.status === "scheduled" && now - s.showtimeUnix > graceSeconds,
  );
  if (stale.length) {
    stale.forEach((s) => {
      s.status = "missed";
    });
    save();
  }
  return stale;
}

export function getAllShows() {
  return schedule;
}

export function getShow(id) {
  return schedule.find((s) => s.id === id) || null;
}

export function setShowMessageId(id, messageId) {
  const show = schedule.find((s) => s.id === id);
  if (show) {
    show.messageId = messageId;
    save();
  }
}
