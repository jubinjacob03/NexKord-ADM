import path from "node:path";
import {
  readJsonFileSync,
  writeJsonFileAtomicSync,
} from "../../utils/jsonStore.js";

const dataDir = path.join(process.cwd(), "data");
const scheduleFile = path.join(dataDir, "cinema-schedule.json");

let schedule = [];

const validStatuses = new Set([
  "scheduled",
  "claimed",
  "dispatching",
  "dispatch_unknown",
  "dispatched",
  "failed",
  "cancelled",
  "missed",
  "live",
]);

function validPlayback(value) {
  return (
    value?.version === 1 &&
    typeof value.movieId === "string" &&
    value.movieId.length > 0 &&
    typeof value.variantId === "string" &&
    value.variantId.length > 0
  );
}

function validSchedule(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (show) =>
        show &&
        typeof show.id === "string" &&
        typeof show.title === "string" &&
        Number.isSafeInteger(show.showtimeUnix) &&
        Number.isSafeInteger(show.screenId) &&
        validStatuses.has(show.status) &&
        (show.playback === undefined || validPlayback(show.playback)),
    )
  );
}

function save() {
  writeJsonFileAtomicSync(scheduleFile, schedule);
}

function transition(show, status, error = null) {
  const previousStatus = show.status;
  const hadError = Object.hasOwn(show, "error");
  const previousError = show.error;
  show.status = status;
  if (error) show.error = String(error).slice(0, 500);
  else delete show.error;
  try {
    save();
  } catch (failure) {
    show.status = previousStatus;
    if (hadError) show.error = previousError;
    else delete show.error;
    throw failure;
  }
  return show;
}

export function loadSchedule() {
  schedule = readJsonFileSync(scheduleFile, {
    fallback: [],
    validate: validSchedule,
    label: "cinema schedule",
  });

  let changed = false;
  for (const show of schedule) {
    if (show.status === "claimed") {
      show.status = "scheduled";
      delete show.error;
      changed = true;
    } else if (show.status === "dispatching" || show.status === "live") {
      show.status = "dispatch_unknown";
      show.error = "Dispatch was interrupted; delivery could not be confirmed.";
      changed = true;
    }
    if (show.status === "scheduled" && !validPlayback(show.playback)) {
      show.status = "failed";
      show.error = "This legacy show is not pinned to media; reschedule it.";
      changed = true;
    }
  }
  if (changed) save();
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
  playback,
}) {
  if (!validPlayback(playback)) {
    throw new Error(
      "A verified movie and variant are required for scheduling.",
    );
  }
  if (!Number.isSafeInteger(showtimeUnix) || !Number.isSafeInteger(screenId)) {
    throw new Error("Showtime and screen must be valid integers.");
  }

  const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const show = {
    id,
    title: String(title || "Untitled").slice(0, 200),
    year: String(year || "").slice(0, 4),
    overview: String(overview || "").slice(0, 3000),
    posterUrl: String(posterUrl || ""),
    showtimeUnix,
    screenId,
    tmdbId: tmdbId ?? null,
    mediaType: mediaType === "tv" ? "tv" : "movie",
    playback: {
      version: 1,
      movieId: playback.movieId,
      variantId: playback.variantId,
    },
    status: "scheduled",
    messageId: null,
    createdAt: Date.now(),
  };
  schedule.push(show);
  schedule.sort((a, b) => a.showtimeUnix - b.showtimeUnix);
  try {
    save();
  } catch (error) {
    schedule = schedule.filter((item) => item !== show);
    throw error;
  }
  return show;
}

export function cancelShow(id) {
  const show = schedule.find((item) => item.id === id);
  if (!show || show.status !== "scheduled") return null;
  return transition(show, "cancelled");
}

export function getUpcoming(screenId) {
  const now = Math.floor(Date.now() / 1000);
  return schedule.filter(
    (show) =>
      show.status === "scheduled" &&
      show.showtimeUnix > now &&
      (screenId === undefined || show.screenId === screenId),
  );
}

export function getDueShows(graceSeconds = 900) {
  const now = Math.floor(Date.now() / 1000);
  return schedule.filter(
    (show) =>
      show.status === "scheduled" &&
      show.showtimeUnix <= now &&
      now - show.showtimeUnix <= graceSeconds,
  );
}

export function claimShowForDispatch(id, graceSeconds = 900) {
  const show = schedule.find((item) => item.id === id);
  const now = Math.floor(Date.now() / 1000);
  if (
    !show ||
    show.status !== "scheduled" ||
    show.showtimeUnix > now ||
    now - show.showtimeUnix > graceSeconds
  ) {
    return null;
  }
  return transition(show, "claimed");
}

export function markShowDispatchAttempting(id) {
  const show = schedule.find((item) => item.id === id);
  if (!show || show.status !== "claimed") return null;
  return transition(show, "dispatching");
}

export function completeShowDispatch(id, status, error = null) {
  const show = schedule.find((item) => item.id === id);
  const canComplete =
    (status === "dispatched" && show?.status === "dispatching") ||
    (status === "failed" &&
      (show?.status === "claimed" || show?.status === "dispatching"));
  if (!canComplete) return null;
  return transition(show, status, error);
}

export function markShowDispatchUnknown(id, error) {
  const show = schedule.find((item) => item.id === id);
  if (!show || show.status !== "dispatching") return null;
  return transition(
    show,
    "dispatch_unknown",
    error || "Delivery could not be confirmed.",
  );
}

export function expireStaleShows(graceSeconds = 900) {
  const now = Math.floor(Date.now() / 1000);
  const stale = schedule.filter(
    (show) =>
      show.status === "scheduled" && now - show.showtimeUnix > graceSeconds,
  );
  if (stale.length) {
    const previous = stale.map((show) => show.status);
    for (const show of stale) show.status = "missed";
    try {
      save();
    } catch (error) {
      stale.forEach((show, index) => {
        show.status = previous[index];
      });
      throw error;
    }
  }
  return stale;
}

export function setShowMessageId(id, messageId) {
  const show = schedule.find((item) => item.id === id);
  if (!show) return;
  const previous = show.messageId;
  show.messageId = messageId;
  try {
    save();
  } catch (error) {
    show.messageId = previous;
    throw error;
  }
}
