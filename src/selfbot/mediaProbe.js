import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

function parseRate(rate) {
  if (!rate || rate === "0/0") return 0;
  const [num, den] = rate.split("/").map(Number);
  if (!den) return num || 0;
  return num / den;
}

export async function probeSource(
  input,
  timeoutMs = 15000,
  attempts = 2,
  signal,
) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await probeOnce(input, timeoutMs, signal);
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      lastError = err;
      if (attempt < attempts) {
        console.warn(
          `[PROBE] Attempt ${attempt}/${attempts} failed; retrying.`,
        );
      }
    }
  }
  throw lastError;
}

async function probeOnce(input, timeoutMs, signal) {
  const source = String(input);
  const windowsPath = /^[A-Za-z]:[\\/]/.test(source);
  const hasScheme = !windowsPath && /^[A-Za-z][A-Za-z\d+.-]*:/.test(source);
  if (hasScheme) {
    throw new Error("Media probing is limited to local files.");
  }

  const args = [
    "-v",
    "error",
    "-hide_banner",
    "-protocol_whitelist",
    "file,pipe",
    "-probesize",
    "2M",
    "-analyzeduration",
    "2M",
  ];

  args.push(
    "-show_entries",
    "stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,bit_rate",
    "-show_entries",
    "format=bit_rate,duration",
    "-of",
    "json",
    source,
  );

  const { stdout } = await run("ffprobe", args, {
    maxBuffer: 8 * 1024 * 1024,
    signal,
    timeout: timeoutMs,
    windowsHide: true,
  });

  const parsed = JSON.parse(stdout);
  const streams = parsed.streams || [];

  const videoStreams = streams
    .filter((stream) => stream.codec_type === "video")
    .map((stream, order) => {
      const fps =
        parseRate(stream.avg_frame_rate) || parseRate(stream.r_frame_rate);
      const absoluteIndex = Number(stream.index);
      return {
        index:
          Number.isInteger(absoluteIndex) && absoluteIndex >= 0
            ? absoluteIndex
            : null,
        order,
        width: Number(stream.width) || 0,
        height: Number(stream.height) || 0,
        fps:
          Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : 0,
        codec: stream.codec_name || "unknown",
        bitrateKbps: Math.round((Number(stream.bit_rate) || 0) / 1000),
      };
    })
    .sort((a, b) => b.width - a.width);

  if (videoStreams.length === 0) {
    throw new Error("no video stream found in source");
  }

  const audioCount = streams.filter(
    (stream) => stream.codec_type === "audio",
  ).length;
  const best = videoStreams[0];
  const formatBitrate = Number(parsed.format?.bit_rate) || 0;

  return {
    ...best,
    videoStreams,
    audioCount,
    hasAudio: audioCount > 0,
    durationSeconds: Number(parsed.format?.duration) || 0,
    bitrateKbps:
      best.bitrateKbps ||
      Math.round(Math.max(0, formatBitrate - 160000) / 1000),
  };
}

function selectRendition(probe, maxWidth) {
  if (!probe?.videoStreams?.length) return null;

  const tolerated = Math.round(maxWidth * 1.05);
  const withinCap = probe.videoStreams.filter(
    (stream) => stream.width <= tolerated,
  );
  return withinCap[0] || probe.videoStreams[probe.videoStreams.length - 1];
}

export function planEncoding(probe, limits) {
  const plan = {
    reason: [],
    excludeFlags: [],
    selectedVideoStreamIndex: null,
  };

  const chosen = selectRendition(probe, limits.maxWidth);
  if (Number.isInteger(chosen?.index) && chosen.index >= 0) {
    plan.selectedVideoStreamIndex = chosen.index;
  }

  if (chosen && probe.videoStreams.length > 1) {
    plan.reason.push(
      `rendition ${chosen.width}x${chosen.height} of ${probe.videoStreams.length}`,
    );
    for (const stream of probe.videoStreams) {
      if (stream.order === chosen.order) continue;
      const streamSpecifier =
        Number.isInteger(stream.index) && stream.index >= 0
          ? `-0:${stream.index}?`
          : `-0:v:${stream.order}?`;
      plan.excludeFlags.push("-map", streamSpecifier);
    }
  }

  for (let index = 1; index < (probe?.audioCount ?? 0); index += 1) {
    plan.excludeFlags.push("-map", `-0:a:${index}?`);
  }

  const sourceWidth = chosen?.width ?? probe?.width ?? 0;
  const sourceHeight = chosen?.height ?? probe?.height ?? 0;
  const sourceFps = chosen?.fps ?? probe?.fps ?? 0;
  const widthCeiling = Math.round(limits.maxWidth * 1.05);

  if (limits.forceWidth > 0) {
    plan.width = limits.forceWidth;
    plan.reason.push(`width forced to ${limits.forceWidth}`);
  } else if (sourceWidth > widthCeiling) {
    plan.width = limits.maxWidth;
    plan.reason.push(`downscaled ${sourceWidth}->${limits.maxWidth} wide`);
  } else {
    plan.reason.push(
      sourceWidth ? `native ${sourceWidth}x${sourceHeight}` : "native size",
    );
  }

  if (limits.forceFps > 0) {
    plan.frameRate = limits.forceFps;
    plan.reason.push(`fps forced to ${limits.forceFps}`);
  } else if (sourceFps > limits.maxFps) {
    plan.frameRate = limits.maxFps;
    plan.reason.push(`fps capped ${sourceFps}->${limits.maxFps}`);
  } else {
    plan.reason.push(sourceFps ? `native ${sourceFps}fps` : "native fps");
  }

  const outWidth = plan.width || sourceWidth || 1280;
  const outHeight =
    plan.width && sourceWidth
      ? Math.round((sourceHeight * plan.width) / sourceWidth)
      : sourceHeight || 720;
  const outFps = plan.frameRate || sourceFps || 30;

  if (limits.bitrateVideo > 0) {
    plan.bitrateVideo = limits.bitrateVideo;
  } else {
    let estimate = Math.round((outWidth * outHeight * outFps * 0.09) / 1000);

    const sourceKbps = chosen?.bitrateKbps || probe?.bitrateKbps || 0;
    if (sourceKbps > 0) {
      const transparent = Math.round(
        sourceKbps * (limits.bitrateFactor ?? 2.5),
      );
      estimate = Math.min(estimate, Math.max(transparent, limits.bitrateFloor));
    }

    plan.bitrateVideo = Math.min(
      Math.max(estimate, limits.bitrateFloor),
      limits.bitrateCeiling,
    );
    plan.reason.push(`bitrate auto ${plan.bitrateVideo}kbps`);
  }

  plan.estimatedBytesPerSecond =
    ((plan.bitrateVideo + (limits.bitrateAudio ?? 192)) * 1000) / 8;

  plan.bitrateVideoMax = Math.max(plan.bitrateVideo, limits.bitrateCeiling);
  return plan;
}
