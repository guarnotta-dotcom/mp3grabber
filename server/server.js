import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

if (!ffmpegPath) {
  throw new Error("ffmpeg-static did not provide a binary path.");
}
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const maxFileMb = Number(process.env.MAX_FILE_MB || 100);
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

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length === 0) {
    throw new Error("Downloaded file was empty.");
  }

  if (buffer.length > maxBytes) {
    throw new Error(`File exceeds ${maxFileMb} MB limit.`);
  }

  fs.writeFileSync(destinationPath, buffer);
}

function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioBitrate("192k")
      .format("mp3")
      .on("start", (cmd) => {
        console.log("FFmpeg command:", cmd);
      })
      .on("end", () => {
        console.log("FFmpeg finished successfully.");
        resolve();
      })
      .on("error", (err) => {
        console.error("FFmpeg error:", err);
        reject(err);
      })
      .save(outputPath);
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/test", (req, res) => {
  res.json({
    ok: true,
    body: req.body || null,
    origin: req.headers.origin || null,
  });
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

  const jobId = uuidv4();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "approved-media-"));
  const extension = guessExtensionFromUrl(url);
  const inputPath = path.join(tempDir, `input-${jobId}${extension}`);
  const outputPath = path.join(tempDir, `audio-${jobId}.mp3`);

  try {
    console.log("Starting download:", url);
    await downloadToFile(url, inputPath);

    if (!fs.existsSync(inputPath)) {
      throw new Error("Input file was not created.");
    }

    const inputStats = fs.statSync(inputPath);
    console.log("Downloaded input size:", inputStats.size);

    await convertToMp3(inputPath, outputPath);

    if (!fs.existsSync(outputPath)) {
      throw new Error("MP3 output file was not created.");
    }

    const outputStats = fs.statSync(outputPath);
    console.log("Created output size:", outputStats.size);

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

  if (res.headersSent) return;

  res.status(500).json({
    error: err.message || "Internal server error",
  });
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  console.log(`Using ffmpeg binary: ${ffmpegPath}`);
});
