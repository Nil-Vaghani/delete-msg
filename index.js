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

// ─── Indian Standard Time Helper ────────────────────
function getIST(date) {
  return (date || new Date()).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

// ─── Prevent crash from unhandled promise rejections ──
process.on("unhandledRejection", (reason, promise) => {
  console.error(
    "⚠️ [UNHANDLED] Promise rejection (caught by handler):",
    reason,
  );
});

// ─── MongoDB Models for Persistent Storage ──────────────
const deletedMessageSchema = new mongoose.Schema({
  time: { type: String, required: true },
  where: { type: String, required: true },
  senderName: { type: String, required: true },
  senderNumber: { type: String },
  originalMessage: { type: String },
  sentTime: { type: String },
  mediaFilename: { type: String },
  mediaFileId: { type: mongoose.Schema.Types.ObjectId }, // GridFS file reference
  createdAt: { type: Date, default: Date.now, expires: 68 * 60 * 60 }, // Auto-delete after 68 hours
});

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

function escapeHTML(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendPushNotification(title, body) {
  try {
    const safeTitle = escapeHTML(title);
    const safeBody = escapeHTML(body);
    const text = `<b>${safeTitle}</b>\n\n${safeBody}`;

    // Try with HTML parse mode first
    let res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: text,
          parse_mode: "HTML",
        }),
      },
    );

    // Fallback: retry as plain text if HTML parsing fails
    if (!res.ok) {
      console.warn(
        `Telegram HTML parse failed (${res.status}), retrying as plain text...`,
      );
      const plainText = `${title}\n\n${body}`;
      res = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: plainText,
          }),
        },
      );
    }

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

// ─── Message Cache (for delete-for-everyone detection) ────────
const messageCache = new Map();
const MESSAGE_CACHE_TTL_MS = 68 * 60 * 60 * 1000;
const MAX_CACHE_SIZE = 500; // Limit cache to 500 messages to save memory

function cacheMessage(msgId, data) {
  // Evict oldest entries if cache is too large
  if (messageCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = messageCache.keys().next().value;
    messageCache.delete(oldestKey);
  }
  messageCache.set(msgId, { ...data, cachedAt: Date.now() });
  setTimeout(() => messageCache.delete(msgId), MESSAGE_CACHE_TTL_MS);
}

// ─── Media Tracker (for delete-for-everyone detection) ──
// Key: msg serialized ID → { filePath, filename, timeout, mimetype }
// NOTE: media data is NOT stored in RAM — read from disk when needed
const mediaTracker = new Map();

// ─── Helper: Read media from disk as base64 ─────────────
function readMediaAsBase64(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath).toString("base64");
    }
  } catch (err) {
    console.error("Error reading media from disk:", err.message);
  }
  return null;
}

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

  // ─── Startup cleanup: remove expired temp media files ──
  try {
    const now = Date.now();
    const tempFiles = fs.readdirSync(TEMP_MEDIA_DIR);
    let cleaned = 0;
    for (const file of tempFiles) {
      const filePath = path.join(TEMP_MEDIA_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > DELETE_WINDOW_MS) {
        fs.unlinkSync(filePath);
        cleaned++;
      }
    }
    if (cleaned > 0)
      console.log(
        `🧹 Startup cleanup: removed ${cleaned} expired temp file(s)`,
      );
  } catch (err) {
    console.error("Startup temp cleanup error:", err.message);
  }

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
        "--no-zygote",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-sync",
        "--disable-translate",
        "--disable-software-rasterizer",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-component-update",
        "--disable-domain-reliability",
        "--metrics-recording-only",
        "--no-first-run",
        "--js-flags=--max-old-space-size=128",
      ],
    },
  });

  console.log("🌐 [CHROME] Client created, initializing WhatsApp Web...");

  // ─── WhatsApp Connection Lifecycle Logging ───────────────
  let qrCount = 0;

  client.on("remote_session_saved", () => {
    console.log("💾 [AUTH] Session saved to MongoDB successfully");
  });

  client.on("qr", async (qr) => {
    qrCount++;
    console.log(`\n📱 [QR] New QR code generated (attempt ${qrCount}/5)`);

    // Send EVERY QR to Telegram so user always has a fresh one to scan
    try {
      const qrBuffer = await QRCode.toBuffer(qr, { width: 300, margin: 2 });
      const blob = new Blob([qrBuffer], { type: "image/png" });
      const formData = new FormData();
      formData.append("chat_id", TELEGRAM_CHAT_ID);
      formData.append(
        "caption",
        `📱 QR Code (attempt ${qrCount}/5)\n⏱️ Scan within ~20 seconds!\n\n👉 WhatsApp → Settings → Linked Devices → Link a Device → Scan QR`,
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
        console.log(`📱 [QR] QR code #${qrCount} sent to Telegram`);
      }
    } catch (err) {
      console.error("[QR] QR image send error:", err);
      await sendPushNotification(
        "📱 QR Code Needed",
        `QR code #${qrCount} was generated but couldn't be sent as image. Check Render logs.`,
      );
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
    console.log(`✅ [READY] Logged in at: ${getIST()}`);
    await sendPushNotification(
      "✅ WhatsApp Connected",
      `Bot is now connected and ready.\nTime: ${getIST()}`,
    );
  });

  // ─── Incoming Messages ──────────────────────────────────
  client.on("message", async (msg) => {
    try {
      const chat = await msg.getChat();
      const contact = await msg.getContact();
      const senderName = contact.name || contact.pushname || contact.number;
      const senderActualNumber = contact.number;
      const time = getIST();
      const messageBody = msg.body || "[<empty>]";
      const chatLocation = chat.isGroup
        ? `Group: ${chat.name}`
        : "Private Chat";

      // Save media temporarily (for delete-for-everyone capture)
      let mediaRef = "";
      if (msg.hasMedia) {
        const filename = await saveMediaToTemp(msg);
        if (filename) {
          mediaRef = `\nMedia: media/temp/${filename}`;
        }
      }

      // ── View-Once Media Capture ──
      const isViewOnce = msg._data && msg._data.isViewOnce;
      if (isViewOnce && msg.hasMedia) {
        console.log(`👁️ View-once media detected from ${senderName}`);
        try {
          const tracked = mediaTracker.get(msg.id._serialized);
          if (tracked) {
            // Save to permanent folder
            const savedPath = path.join(SAVED_MEDIA_DIR, tracked.filename);
            if (fs.existsSync(tracked.filePath)) {
              fs.copyFileSync(tracked.filePath, savedPath);
              console.log(
                `🔒 View-once media saved permanently: ${tracked.filename}`,
              );
            }

            // Upload to MongoDB GridFS
            let mediaFileId = null;
            const viewOnceData = readMediaAsBase64(tracked.filePath);
            if (viewOnceData) {
              mediaFileId = await uploadMediaToGridFS(
                viewOnceData,
                tracked.mimetype,
                tracked.filename,
              );
            }

            // Save record to MongoDB
            await DeletedMessage.create({
              time,
              where: chatLocation,
              senderName,
              senderNumber: senderActualNumber,
              originalMessage: `[👁️ VIEW-ONCE] ${messageBody || "[media]"}`,
              sentTime: getIST(new Date(msg.timestamp * 1000)),
              mediaFilename: tracked.filename,
              mediaFileId: mediaFileId || undefined,
            });

            // Send to Telegram
            await sendPushNotification(
              `👁️ View-Once from ${senderName}`,
              `Where: ${chatLocation}\nWho: ${senderName} (${senderActualNumber})\nTime: ${time}\nMessage: ${messageBody || "[media]"}`,
            );
            if (viewOnceData) {
              await sendTelegramMedia(
                viewOnceData,
                tracked.mimetype,
                tracked.filename,
                `👁️ View-once media from ${senderName} (${senderActualNumber})\nIn: ${chatLocation}`,
              );
            }
          }
        } catch (err) {
          console.error("View-once capture error:", err);
        }
      }

      const logEntry = `Time: ${time}\nWhere: ${chatLocation}\nWho: ${senderName} (${senderActualNumber})\nMessage: ${messageBody}${mediaRef}\n------------------------------\n`;

      fs.appendFileSync("messages_log.txt", logEntry, "utf8");

      // Cache message for delete-for-everyone detection
      cacheMessage(msg.id._serialized, {
        body: messageBody,
        senderName,
        senderNumber: senderActualNumber,
        chatLocation,
        timestamp: msg.timestamp,
      });

      console.log(`💾 Saved: ${chatLocation} - ${senderName}`);
    } catch (err) {
      console.error("Message handler error:", err);
    }
  });

  // ─── Delete-for-Everyone Detection ──────────────────────
  client.on("message_revoke_everyone", async (afterMsg, beforeMsg) => {
    console.log(
      `🗑️ [DELETE EVENT] message_revoke_everyone fired! msgId=${afterMsg?.id?._serialized}, beforeMsg=${!!beforeMsg}`,
    );
    try {
      const time = getIST();

      let chatLocation = "Unknown Chat";
      try {
        const chat = await afterMsg.getChat();
        chatLocation = chat.isGroup ? `Group: ${chat.name}` : "Private Chat";
      } catch (chatErr) {
        console.error("Could not get chat for deleted msg:", chatErr.message);
      }

      let senderName = "Unknown";
      let senderNumber = "Unknown";
      let originalText = "[Unknown - message not cached]";

      // Try whatsapp-web.js cache first
      if (beforeMsg) {
        try {
          const contact = await beforeMsg.getContact();
          senderName = contact.name || contact.pushname || contact.number;
          senderNumber = contact.number;
        } catch (e) {
          console.warn("Could not get contact from beforeMsg:", e.message);
        }
        originalText = beforeMsg.body || "[<empty>]";
      }

      // Fallback: check our manual message cache
      const msgId = beforeMsg
        ? beforeMsg.id._serialized
        : afterMsg.id._serialized;
      const cached = messageCache.get(msgId);
      if (cached) {
        console.log(
          `📋 Found message in manual cache: ${cached.body?.substring(0, 50)}...`,
        );
        if (senderName === "Unknown") senderName = cached.senderName;
        if (senderNumber === "Unknown") senderNumber = cached.senderNumber;
        if (originalText === "[Unknown - message not cached]")
          originalText = cached.body;
        if (chatLocation === "Unknown Chat") chatLocation = cached.chatLocation;
      }

      // Check if we have temp media saved for this message
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

      // Save deleted message media to MongoDB GridFS
      let mediaFileId = null;
      if (tracked) {
        // Read from saved location if moved, otherwise temp
        const mediaPath = fs.existsSync(
          path.join(SAVED_MEDIA_DIR, tracked.filename),
        )
          ? path.join(SAVED_MEDIA_DIR, tracked.filename)
          : tracked.filePath;
        const mediaBase64 = readMediaAsBase64(mediaPath);
        if (mediaBase64) {
          mediaFileId = await uploadMediaToGridFS(
            mediaBase64,
            tracked.mimetype,
            tracked.filename,
          );
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
            ? getIST(new Date(beforeMsg.timestamp * 1000))
            : cached && cached.timestamp
              ? getIST(new Date(cached.timestamp * 1000))
              : "Unknown",
        mediaFilename: tracked ? tracked.filename : undefined,
        mediaFileId: mediaFileId || undefined,
      });

      console.log(`🗑️ Delete detected: ${chatLocation} - ${senderName}`);

      // ── Push notification via Telegram ──
      let ntfySentTime = "Unknown";
      if (beforeMsg && beforeMsg.timestamp) {
        ntfySentTime = getIST(new Date(beforeMsg.timestamp * 1000));
      } else if (cached && cached.timestamp) {
        ntfySentTime = getIST(new Date(cached.timestamp * 1000));
      }

      await sendPushNotification(
        `🗑️ Deleted by ${senderName}`,
        `Where: ${chatLocation}\nWho: ${senderName} (${senderNumber})\nSent: ${ntfySentTime}\nDeleted: ${time}\nMessage: ${originalText}`,
      );

      // Send deleted media to Telegram if available
      if (tracked) {
        const tgMediaPath = fs.existsSync(
          path.join(SAVED_MEDIA_DIR, tracked.filename),
        )
          ? path.join(SAVED_MEDIA_DIR, tracked.filename)
          : tracked.filePath;
        const tgMediaData = readMediaAsBase64(tgMediaPath);
        if (tgMediaData) {
          await sendTelegramMedia(
            tgMediaData,
            tracked.mimetype,
            tracked.filename,
            `📎 Deleted file from ${senderName} (${senderNumber})\nIn: ${chatLocation}`,
          );
        }
      }

      // Clean up tracker and cache
      if (tracked) {
        mediaTracker.delete(msgId);
      }
      messageCache.delete(msgId);
    } catch (err) {
      console.error("Delete detection error:", err);
      // Last resort: try to send a basic notification even if everything else failed
      try {
        await sendPushNotification(
          "🗑️ Message Deleted",
          `A message was deleted for everyone but details could not be retrieved.\nError: ${err.message}`,
        );
      } catch (e) {
        console.error("Even fallback notification failed:", e);
      }
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
