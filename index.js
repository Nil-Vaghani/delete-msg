const { Client, RemoteAuth } = require("whatsapp-web.js");
const { MongoStore } = require("wwebjs-mongo");
const mongoose = require("mongoose");
const { GridFSBucket } = require("mongodb");
const { Readable } = require("stream");
const QRCode = require("qrcode");
const http = require("http");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ─── Prevent crash from unhandled promise rejections ──
process.on("unhandledRejection", (reason, promise) => {
  console.error("⚠️ [UNHANDLED] Promise rejection (caught by handler):", reason);
});

// ─── MongoDB Models for Persistent Storage ──────────────
const messageSchema = new mongoose.Schema({
  time: { type: String, required: true },
  where: { type: String, required: true },
  senderName: { type: String, required: true },
  senderNumber: { type: String },
  message: { type: String },
  mediaFilename: { type: String },
  mediaFileId: { type: mongoose.Schema.Types.ObjectId }, // GridFS file reference
  createdAt: { type: Date, default: Date.now },
});

const deletedMessageSchema = new mongoose.Schema({
  time: { type: String, required: true },
  where: { type: String, required: true },
  senderName: { type: String, required: true },
  senderNumber: { type: String },
  originalMessage: { type: String },
  sentTime: { type: String },
  mediaFilename: { type: String },
  mediaFileId: { type: mongoose.Schema.Types.ObjectId }, // GridFS file reference
  createdAt: { type: Date, default: Date.now },
});

const Message = mongoose.model("Message", messageSchema);
const DeletedMessage = mongoose.model("DeletedMessage", deletedMessageSchema);

// ─── Validate Environment Variables ─────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!process.env.MONGODB_URI) {
  console.error("❌ MONGODB_URI is required. Exiting.");
  process.exit(1);
}
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn(
    "⚠️ Telegram credentials missing — notifications will be disabled.",
  );
}

// ─── Push Notification via Telegram Bot ──────────────────

async function sendPushNotification(title, body) {
  try {
    const text = `*${title}*\n\n${body}`;
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: text,
          parse_mode: "Markdown",
        }),
      },
    );
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`Telegram API error (${res.status}): ${errBody}`);
    } else {
      console.log("🔔 Telegram notification sent");
    }
  } catch (err) {
    console.error("Telegram notification error:", err);
  }
}

async function sendTelegramMedia(base64data, mimetype, filename, caption) {
  try {
    const buffer = Buffer.from(base64data, "base64");
    const blob = new Blob([buffer], { type: mimetype });
    const formData = new FormData();
    formData.append("chat_id", TELEGRAM_CHAT_ID);
    formData.append("caption", caption);
    formData.append("document", blob, filename);
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
      { method: "POST", body: formData },
    );
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`Telegram media API error (${res.status}): ${errBody}`);
    } else {
      console.log("📎 Telegram media sent");
    }
  } catch (err) {
    console.error("Telegram media send error:", err);
  }
}

// ─── Media Directories ──────────────────────────────────
const TEMP_MEDIA_DIR = path.join(__dirname, "media", "temp");
const SAVED_MEDIA_DIR = path.join(__dirname, "media", "saved");

[TEMP_MEDIA_DIR, SAVED_MEDIA_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Media Tracker (for delete-for-everyone detection) ──
// Key: msg serialized ID → { filePath, filename, timeout, mediaData, mimetype }
const mediaTracker = new Map();

// ─── GridFS & Storage Limit Helpers ─────────────────────
let gridFSBucket = null;
const MONGO_STORAGE_LIMIT_MB = parseInt(
  process.env.MONGO_STORAGE_LIMIT_MB || "450",
); // default 450MB (safe margin for 512MB free tier)

function initGridFS() {
  if (!gridFSBucket) {
    gridFSBucket = new GridFSBucket(mongoose.connection.db, {
      bucketName: "media",
    });
  }
  return gridFSBucket;
}

// Check if MongoDB storage is within limits
async function isStorageWithinLimit() {
  try {
    const stats = await mongoose.connection.db.stats();
    const usedMB = stats.dataSize / (1024 * 1024);
    console.log(
      `📊 MongoDB storage: ${usedMB.toFixed(1)}MB / ${MONGO_STORAGE_LIMIT_MB}MB`,
    );
    return usedMB < MONGO_STORAGE_LIMIT_MB;
  } catch (err) {
    console.error("Storage check error:", err.message);
    return false; // fail-safe: don't store if we can't check
  }
}

// Upload media to GridFS, returns file ID or null
async function uploadMediaToGridFS(base64data, mimetype, filename) {
  try {
    if (!(await isStorageWithinLimit())) {
      console.warn("⚠️ MongoDB storage limit reached — skipping media upload");
      return null;
    }
    const bucket = initGridFS();
    const buffer = Buffer.from(base64data, "base64");
    const readable = new Readable();
    readable.push(buffer);
    readable.push(null);

    return new Promise((resolve, reject) => {
      const uploadStream = bucket.openUploadStream(filename, {
        contentType: mimetype,
      });
      readable
        .pipe(uploadStream)
        .on("error", (err) => {
          console.error("GridFS upload error:", err);
          reject(err);
        })
        .on("finish", () => {
          console.log(`📦 Media uploaded to MongoDB: ${filename}`);
          resolve(uploadStream.id);
        });
    });
  } catch (err) {
    console.error("GridFS upload error:", err.message);
    return null;
  }
}

// WhatsApp "Delete for Everyone" window ≈ 68 hours
const DELETE_WINDOW_MS = 68 * 60 * 60 * 1000;

// ─── Helper: mimetype → file extension ──────────────────
function getExtension(mimetype) {
  const map = {
    // Images
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "image/svg+xml": ".svg",
    // Videos
    "video/mp4": ".mp4",
    "video/3gpp": ".3gp",
    "video/quicktime": ".mov",
    "video/x-msvideo": ".avi",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    // Audio
    "audio/ogg; codecs=opus": ".ogg",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/amr": ".amr",
    // Documents
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      ".docx",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      ".xlsx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      ".pptx",
    "application/vnd.ms-powerpoint": ".ppt",
    "text/plain": ".txt",
    "text/csv": ".csv",
    // Archives
    "application/zip": ".zip",
    "application/x-rar-compressed": ".rar",
    "application/x-7z-compressed": ".7z",
    "application/gzip": ".gz",
    // Other
    "application/json": ".json",
    "application/octet-stream": ".bin",
    "application/vnd.android.package-archive": ".apk",
  };
  if (map[mimetype]) return map[mimetype];
  const sub = mimetype ? mimetype.split(";")[0].split("/")[1] : "bin";
  return "." + sub;
}

// ─── Save media to temp folder ──────────────────────────
async function saveMediaToTemp(msg) {
  try {
    if (!msg.hasMedia) return null;
    const media = await msg.downloadMedia();
    if (!media || !media.data) return null;

    const ext = getExtension(media.mimetype);
    const timestamp = Date.now();
    const filename = `${timestamp}_${msg.id.id}${ext}`;
    const filePath = path.join(TEMP_MEDIA_DIR, filename);

    fs.writeFileSync(filePath, Buffer.from(media.data, "base64"));

    // Auto-delete after delete window expires
    const timeout = setTimeout(() => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`🧹 Auto-removed (68h expired): ${filename}`);
        }
      } catch (e) {
        console.error("Auto-cleanup error:", e);
      }
      mediaTracker.delete(msg.id._serialized);
    }, DELETE_WINDOW_MS);

    mediaTracker.set(msg.id._serialized, {
      filePath,
      filename,
      timeout,
      mediaData: media.data,
      mimetype: media.mimetype,
      sentTimestamp: msg.timestamp,
    });
    console.log(`📎 Temp media saved: ${filename}`);
    return filename;
  } catch (err) {
    console.error("Media download error:", err);
    return null;
  }
}

// ─── Client Setup ────────────────────────────────────────
async function start() {
  // Connect to MongoDB for session persistence
  console.log("🔗 [MONGO] Connecting to MongoDB...");
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ [MONGO] Connected to MongoDB successfully");
  } catch (err) {
    console.error("❌ [MONGO] MongoDB connection FAILED:", err.message);
    process.exit(1);
  }

  mongoose.connection.on("error", (err) => {
    console.error("❌ [MONGO] MongoDB connection error:", err.message);
  });
  mongoose.connection.on("disconnected", () => {
    console.warn("⚠️ [MONGO] MongoDB disconnected");
  });
  mongoose.connection.on("reconnected", () => {
    console.log("🔗 [MONGO] MongoDB reconnected");
  });

  const store = new MongoStore({ mongoose });

  console.log("🌐 [CHROME] Launching Chrome browser via Puppeteer...");

  const client = new Client({
    authStrategy: new RemoteAuth({
      clientId: "wa-agent",
      store: store,
      backupSyncIntervalMs: 60000, // backup session every 1 min
    }),
    authTimeoutMs: 120000, // 2 min timeout for WhatsApp Web page load (Render free tier is slow)
    qrMaxRetries: 5, // give up after 5 QR rotations (~100 seconds)
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    },
  });

  console.log("🌐 [CHROME] Client created, initializing WhatsApp Web...");

  // ─── WhatsApp Connection Lifecycle Logging ───────────────
  let qrSentToTelegram = false;

  client.on("remote_session_saved", () => {
    console.log("💾 [AUTH] Session saved to MongoDB successfully");
  });

  client.on("qr", async (qr) => {
    console.log("\n📱 [QR] New QR code generated");

    // Send QR to Telegram only ONCE (first time)
    if (!qrSentToTelegram) {
      qrSentToTelegram = true;
      try {
        const qrBuffer = await QRCode.toBuffer(qr, { width: 300, margin: 2 });
        const blob = new Blob([qrBuffer], { type: "image/png" });
        const formData = new FormData();
        formData.append("chat_id", TELEGRAM_CHAT_ID);
        formData.append(
          "caption",
          "📱 Scan this QR code with WhatsApp to connect\n⏱️ QR expires in ~20s — if expired, bot will retry up to 5 times\n\n👉 WhatsApp → Settings → Linked Devices → Link a Device → Scan QR",
        );
        formData.append("photo", blob, "qr-code.png");
        const res = await fetch(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
          { method: "POST", body: formData },
        );
        if (!res.ok) {
          const errBody = await res.text();
          console.error(`Telegram QR photo error (${res.status}): ${errBody}`);
        } else {
          console.log("📱 [QR] QR code image sent to Telegram (first QR only)");
        }
      } catch (err) {
        console.error("[QR] QR image send error:", err);
        await sendPushNotification("📱 QR Code Needed", "A QR code was generated but couldn't be sent as image. Check Render logs.");
      }
    } else {
      console.log("📱 [QR] QR rotated (not re-sending to Telegram — scan quickly or restart bot for a fresh Telegram QR)");
    }
  });

  client.on("authenticated", () => {
    console.log(
      "✅ [AUTH] WhatsApp authenticated successfully! Waiting for session to load...",
    );
  });

  client.on("auth_failure", async (message) => {
    console.error(`❌ [AUTH] Authentication FAILED: ${message}`);
    await sendPushNotification(
      "❌ Auth Failed",
      `WhatsApp authentication failed:\n${message}\n\nA new QR code will be generated.`,
    );
  });

  client.on("loading_screen", (percent, message) => {
    console.log(`⏳ [LOADING] WhatsApp loading: ${percent}% — ${message}`);
  });

  client.on("disconnected", async (reason) => {
    console.error(`🔌 [DISCONNECTED] WhatsApp disconnected: ${reason}`);
    await sendPushNotification(
      "🔌 Disconnected",
      `WhatsApp disconnected.\nReason: ${reason}\n\nThe bot will try to reconnect.`,
    );
  });

  client.on("change_state", (state) => {
    console.log(`🔄 [STATE] WhatsApp connection state changed: ${state}`);
  });

  client.on("ready", async () => {
    console.log(
      "\n✅ [READY] WhatsApp connected & ready! Logging all incoming messages.",
    );
    console.log(`✅ [READY] Logged in at: ${new Date().toLocaleString()}`);
    await sendPushNotification(
      "✅ WhatsApp Connected",
      `Bot is now connected and ready.\nTime: ${new Date().toLocaleString()}`,
    );
  });

  // ─── Incoming Messages ──────────────────────────────────
  client.on("message", async (msg) => {
    try {
      const chat = await msg.getChat();
      const contact = await msg.getContact();
      const senderID = msg.isGroupMsg ? msg.author : msg.from;
      const senderName = contact.name || contact.pushname || contact.number;
      const senderActualNumber = contact.number;
      const time = new Date().toLocaleString();
      const messageBody = msg.body || "[<empty>]";
      const chatLocation = chat.isGroup
        ? `Group: ${chat.name}`
        : "Private Chat";

      // Save media temporarily (for delete-for-everyone capture)
      let mediaRef = "";
      let mediaFileId = null;
      if (msg.hasMedia) {
        const filename = await saveMediaToTemp(msg);
        if (filename) {
          mediaRef = `\nMedia: media/temp/${filename}`;
          // Upload media to MongoDB GridFS
          const tracked = mediaTracker.get(msg.id._serialized);
          if (tracked && tracked.mediaData) {
            mediaFileId = await uploadMediaToGridFS(
              tracked.mediaData,
              tracked.mimetype,
              filename,
            );
          }
        }
      }

      const logEntry = `Time: ${time}\nWhere: ${chatLocation}\nWho: ${senderName} (${senderActualNumber})\nMessage: ${messageBody}${mediaRef}\n------------------------------\n`;

      fs.appendFileSync("messages_log.txt", logEntry, "utf8");

      // Save to MongoDB for persistence
      await Message.create({
        time,
        where: chatLocation,
        senderName,
        senderNumber: senderActualNumber,
        message: messageBody,
        mediaFilename: mediaRef ? mediaRef.replace("\nMedia: ", "") : undefined,
        mediaFileId: mediaFileId || undefined,
      });

      console.log(`💾 Saved: ${chatLocation} - ${senderName}`);
    } catch (err) {
      console.error("Message handler error:", err);
    }
  });

  // ─── Delete-for-Everyone Detection ──────────────────────
  client.on("message_revoke_everyone", async (afterMsg, beforeMsg) => {
    try {
      const time = new Date().toLocaleString();
      const chat = await afterMsg.getChat();
      const chatLocation = chat.isGroup
        ? `Group: ${chat.name}`
        : "Private Chat";

      let senderName = "Unknown";
      let senderNumber = "Unknown";
      let originalText = "[Unknown - message not cached]";

      if (beforeMsg) {
        const contact = await beforeMsg.getContact();
        senderName = contact.name || contact.pushname || contact.number;
        senderNumber = contact.number;
        originalText = beforeMsg.body || "[<empty>]";
      }

      // Check if we have temp media saved for this message
      const msgId = beforeMsg
        ? beforeMsg.id._serialized
        : afterMsg.id._serialized;
      const tracked = mediaTracker.get(msgId);
      let mediaRef = "";

      if (tracked) {
        clearTimeout(tracked.timeout);
        const savedPath = path.join(SAVED_MEDIA_DIR, tracked.filename);
        if (fs.existsSync(tracked.filePath)) {
          fs.renameSync(tracked.filePath, savedPath);
          mediaRef = `\nSaved Media: media/saved/${tracked.filename}`;
          console.log(
            `🔒 Permanently saved deleted media: ${tracked.filename}`,
          );
        }
      }

      // Log to file
      const logEntry = `\n🗑️ DELETED MESSAGE DETECTED\nTime: ${time}\nWhere: ${chatLocation}\nWho: ${senderName} (${senderNumber})\nOriginal Message: ${originalText}${mediaRef}\n==============================\n`;
      fs.appendFileSync("messages_log.txt", logEntry, "utf8");

      // Save to MongoDB for persistence — REUSE existing GridFS file ID from original message
      let mediaFileId = null;
      if (tracked && tracked.filename) {
        // Look up the original message's GridFS file ID instead of re-uploading
        const originalMsg = await Message.findOne({
          mediaFilename: `media/temp/${tracked.filename}`,
        });
        if (originalMsg && originalMsg.mediaFileId) {
          mediaFileId = originalMsg.mediaFileId;
          console.log(`♻️ Reusing existing GridFS file for deleted media: ${tracked.filename}`);
        } else if (tracked.mediaData) {
          // Fallback: upload if original wasn't found (shouldn't happen normally)
          mediaFileId = await uploadMediaToGridFS(
            tracked.mediaData,
            tracked.mimetype,
            tracked.filename,
          );
          console.log(`📦 Fallback: uploaded deleted media to GridFS: ${tracked.filename}`);
        }
      }

      await DeletedMessage.create({
        time,
        where: chatLocation,
        senderName,
        senderNumber,
        originalMessage: originalText,
        sentTime:
          beforeMsg && beforeMsg.timestamp
            ? new Date(beforeMsg.timestamp * 1000).toLocaleString()
            : "Unknown",
        mediaFilename: tracked ? tracked.filename : undefined,
        mediaFileId: mediaFileId || undefined,
      });

      console.log(`🗑️ Delete detected: ${chatLocation} - ${senderName}`);

      // ── Push notification via Telegram ──
      const ntfySentTime =
        beforeMsg && beforeMsg.timestamp
          ? new Date(beforeMsg.timestamp * 1000).toLocaleString()
          : "Unknown";
      await sendPushNotification(
        `🗑️ Deleted by ${senderName}`,
        `Where: ${chatLocation}\nWho: ${senderName} (${senderNumber})\nSent: ${ntfySentTime}\nDeleted: ${time}\nMessage: ${originalText}`,
      );

      // Send deleted media to Telegram if available
      if (tracked && tracked.mediaData) {
        await sendTelegramMedia(
          tracked.mediaData,
          tracked.mimetype,
          tracked.filename,
          `📎 Deleted file from ${senderName} (${senderNumber})\nIn: ${chatLocation}`,
        );
      }

      // Clean up tracker
      if (tracked) {
        mediaTracker.delete(msgId);
      }
    } catch (err) {
      console.error("Delete detection error:", err);
    }
  });

  // ─── Graceful Shutdown ─────────────────────────────────
  const shutdown = async (signal) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    try {
      await client.destroy();
      await mongoose.disconnect();
      console.log("👋 Cleanup complete. Bye!");
    } catch (e) {
      console.error("Shutdown error:", e);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log(
    "🚀 [INIT] Calling client.initialize() — Chrome will open and WhatsApp Web will load...",
  );
  client.initialize().catch(async (err) => {
    const msg = typeof err === "string" ? err : err?.message || String(err);
    console.error("❌ [INIT] client.initialize() FAILED:", msg);
    if (err?.stack) console.error(err.stack);
    await sendPushNotification(
      "❌ Init Failed",
      `WhatsApp client.initialize() failed:\n${msg}`,
    );
    // If auth timeout, retry once after a delay
    if (msg.includes("auth timeout") || msg.includes("timeout")) {
      console.log("🔄 [INIT] Retrying client.initialize() in 10 seconds...");
      setTimeout(() => {
        client.initialize().catch((retryErr) => {
          console.error(
            "❌ [INIT] Retry also failed:",
            retryErr?.message || retryErr,
          );
        });
      }, 10000);
    }
  });

  // ─── Health Check Server (for Render) ──────────────────
  const PORT = process.env.PORT || 3000;
  http
    .createServer((req, res) => {
      res.writeHead(200);
      res.end("WhatsApp Agent is running");
    })
    .listen(PORT, () => console.log(`🌐 Health server on port ${PORT}`));

  // ─── Self-Ping Keep-Alive (prevents Render free tier sleep) ────
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    const PING_INTERVAL_MS = 14 * 60 * 1000; // 14 minutes
    setInterval(async () => {
      try {
        const res = await fetch(RENDER_URL);
        console.log(`🏓 Self-ping: ${res.status}`);
      } catch (err) {
        console.error("Self-ping error:", err.message);
      }
    }, PING_INTERVAL_MS);
    console.log(`🏓 Self-ping enabled: every 14 min → ${RENDER_URL}`);
  } else {
    console.log(
      "ℹ️ RENDER_EXTERNAL_URL not set — self-ping disabled (use cron-job.org instead)",
    );
  }
}

start().catch((err) => {
  console.error("Startup error:", err);
  process.exit(1);
});
