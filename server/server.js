import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises";
import { Transform } from "stream";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { v4 as uuidv4 } from "uuid";

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const maxFileMb = Number(process.env.MAX_FILE_MB || 250);
const maxBytes = maxFileMb * 1024 * 1024;

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "1mb" }));

function isAllowedHost(_hostname) {
  return true;
}

function guessExtensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const ext = path.extname(pathname);
    if (ext) return ext;
  } catch {}
  return ".mp4";
}

async function downloadToFile(url, destinationPath) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 HelixFilmClassAudioTool/1.0",
      "Accept": "*/*",
    },
  });

  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    throw new Error("Source URL returned an HTML page instead of a media file.");
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength && contentLength > maxBytes) {
    throw new Error(`File exceeds ${maxFileMb} MB limit`);
  }

  let bytesRead = 0;
  const countingStream = new Transform({
    transform(chunk, _encoding, callback) {
      bytesRead += chunk.length;
      if (bytesRead > maxBytes) {
        callback(new Error(`File exceeds ${maxFileMb} MB limit`));
        return;
      }
      callback(null, chunk);
    },
  });

  if (!response.body) {
    throw new Error("No response body received from source URL");
  }

  await pipeline(response.body, countingStream, fs.createWriteStream(destinationPath));

  return { bytesRead, contentType };
}

function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioQuality(2)
      .format("mp3")
      .on("start", (commandLine) => {
        console.log("FFmpeg started:", commandLine);
      })
      .on("end", resolve)
      .on("error", (err) => reject(err))
      .save(outputPath);
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/convert", async (req, res, next) => {
  const { url } = req.body || {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "A media URL is required." });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL." });
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: "Only http and https links are allowed." });
  }

  if (!isAllowedHost(parsedUrl.hostname)) {
    return res.status(403).json({
      error: "That source is not on the approved host list.",
    });
  }

  const jobId = uuidv4();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "approved-media-"));

  try {
    const extension = guessExtensionFromUrl(url);
    const inputPath = path.join(tempDir, `input-${jobId}${extension}`);
    const outputPath = path.join(tempDir, `audio-${jobId}.mp3`);

    const downloadInfo = await downloadToFile(url, inputPath);
    console.log("Downloaded file:", {
      url,
      bytesRead: downloadInfo.bytesRead,
      contentType: downloadInfo.contentType,
      inputPath,
    });

    await convertToMp3(inputPath, outputPath);

    res.download(outputPath, "audio.mp3", (err) => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}

      if (err) {
        console.error("Download response error:", err);
      }
    });
  } catch (error) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}

    next(error);
  }
});

app.use((err, req, res, _next) => {
  console.error("Unhandled server error:", err);

  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
  }

  if (res.headersSent) {
    return;
  }

  res.status(500).json({
    error: err.message || "Internal server error",
  });
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
