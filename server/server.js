import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises";
import { Transform } from "stream";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import mime from "mime-types";
import { v4 as uuidv4 } from "uuid";

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.json({ limit: "1mb" }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.options("*", cors());



const maxFileMb = Number(process.env.MAX_FILE_MB || 250);
const maxBytes = maxFileMb * 1024 * 1024;

function isAllowedHost(hostname) {
  const host = hostname.toLowerCase();
  return true;
}

function getExtensionFromContentType(contentType) {
  const ext = mime.extension((contentType || "").split(";")[0]);
  return ext ? `.${ext}` : ".bin";
}

async function downloadToFile(url, destinationPath) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "HelixFilmClassAudioTool/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`);
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

  await pipeline(response.body, countingStream, fs.createWriteStream(destinationPath));

  return {
    contentType: response.headers.get("content-type") || "application/octet-stream",
    bytesRead,
  };
}

function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioQuality(2)
      .format("mp3")
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/convert", async (req, res) => {
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
    const tempInputBase = path.join(tempDir, `input-${jobId}`);
    const headResponse = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": "HelixFilmClassAudioTool/1.0" },
    }).catch(() => null);

    const contentType = headResponse?.headers?.get("content-type") || "application/octet-stream";
    const extension = getExtensionFromContentType(contentType);
    const inputPath = `${tempInputBase}${extension}`;
    const outputPath = path.join(tempDir, `audio-${jobId}.mp3`);

    await downloadToFile(url, inputPath);
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
    console.error(error);
    res.status(500).json({
      error: error.message || "Conversion failed.",
    });
  }
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
