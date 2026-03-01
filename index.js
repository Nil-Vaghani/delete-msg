const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ─── Indian Standard Time Helper ────────────────────
function getIST(date) {
  return (date || new Date()).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  });
}

// ─── Prevent crash from unhandled promise rejections ──
process.on("unhandledRejection", (reason, promise) => {
  console.error(
    "⚠️ [UNHANDLED] Promise rejection (caught by handler):",
    reason,
  );
});

// ─── Validate Environment Variables ─────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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
const MAX_CACHE_SIZE = 500;

// Dedup set for revoke events (prevents processing same deletion twice)
const processedRevokes = new Set();
const REVOKE_DEDUP_TTL_MS = 60 * 1000;

// Startup grace period — ignore old revocations synced on connect
let readyTimestamp = 0;
const STARTUP_GRACE_MS = 30 * 1000;

function cacheMessage(msgId, data) {
  if (messageCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = messageCache.keys().next().value;
    messageCache.delete(oldestKey);
  }
  messageCache.set(msgId, { ...data, cachedAt: Date.now() });
  setTimeout(() => messageCache.delete(msgId), MESSAGE_CACHE_TTL_MS);
}

// ─── Media Tracker (for delete-for-everyone detection) ──
// Key: msg serialized ID → { filePath, filename, timeout, mimetype, msgFilePath, ... }
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

// WhatsApp "Delete for Everyone" window ≈ 68 hours
const DELETE_WINDOW_MS = 68 * 60 * 60 * 1000;

// ─── Helper: mimetype → file extension ──────────────────
function getExtension(mimetype) {
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "image/svg+xml": ".svg",
    "video/mp4": ".mp4",
    "video/3gpp": ".3gp",
    "video/quicktime": ".mov",
    "video/x-msvideo": ".avi",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "audio/ogg; codecs=opus": ".ogg",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/amr": ".amr",
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
    "application/zip": ".zip",
    "application/x-rar-compressed": ".rar",
    "application/x-7z-compressed": ".7z",
    "application/gzip": ".gz",
    "application/json": ".json",
    "application/octet-stream": ".bin",
    "application/vnd.android.package-archive": ".apk",
  };
  if (map[mimetype]) return map[mimetype];
  const sub = mimetype ? mimetype.split(";")[0].split("/")[1] : "bin";
  return "." + sub;
}

// ─── Save media to temp folder ──────────────────────────
const MAX_MEDIA_SIZE_MB = 10;
async function saveMediaToTemp(msg) {
  try {
    if (!msg.hasMedia) return null;
    const media = await msg.downloadMedia();
    if (!media || !media.data) return null;

    const sizeBytes = Buffer.byteLength(media.data, "base64");
    if (sizeBytes > MAX_MEDIA_SIZE_MB * 1024 * 1024) {
      console.log(
        `⚠️ Skipping large media (${(sizeBytes / 1024 / 1024).toFixed(1)}MB > ${MAX_MEDIA_SIZE_MB}MB limit)`,
      );
      return null;
    }

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

// ─── Save deleted message record as JSON file ───────────
function saveDeletedRecord(data) {
  try {
    const timestamp = Date.now();
    const safeName = (data.senderName || "unknown")
      .replace(/[^a-zA-Z0-9]/g, "_")
      .substring(0, 20);
    const filename = `deleted_${timestamp}_${safeName}.json`;
    const filePath = path.join(SAVED_MEDIA_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    console.log(`📝 Deleted record saved: ${filename}`);
  } catch (err) {
    console.error("Error saving deleted record:", err.message);
  }
}

// ─── Client Setup ────────────────────────────────────────
async function start() {
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
    authStrategy: new LocalAuth({
      clientId: "wa-agent",
      dataPath: path.join(__dirname, ".wwebjs_auth"),
    }),
    authTimeoutMs: 120000,
    qrMaxRetries: 5,
    puppeteer: {
      headless: "shell",
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
        "--disable-features=TranslateUI,BlinkGenPropertyTrees",
        "--disable-ipc-flooding-protection",
      ],
    },
  });

  console.log("🌐 [CHROME] Client created, initializing WhatsApp Web...");

  // ─── WhatsApp Connection Lifecycle Logging ───────────────
  let qrCount = 0;

  client.on("qr", async (qr) => {
    qrCount++;
    console.log(`\n📱 [QR] New QR code generated (attempt ${qrCount}/5)`);

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
        `QR code #${qrCount} was generated but couldn't be sent as image. Check logs.`,
      );
    }
  });

  client.on("authenticated", () => {
    console.log(
      "✅ [AUTH] WhatsApp authenticated successfully! Session saved locally.",
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

    readyTimestamp = Date.now();
    console.log(
      `⏳ Startup grace period: ignoring old revocations for ${STARTUP_GRACE_MS / 1000}s`,
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

            // Send to Telegram
            await sendPushNotification(
              `👁️ View-Once from ${senderName}`,
              `Where: ${chatLocation}\nWho: ${senderName} (${senderActualNumber})\nTime: ${time}\nMessage: ${messageBody || "[media]"}`,
            );
            const viewOnceData = readMediaAsBase64(tracked.filePath);
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

      // Save message as .txt file in media/temp (for delete-for-everyone recovery)
      let msgFilePath = null;
      try {
        const timestamp = Date.now();
        const safeName = senderName
          .replace(/[^a-zA-Z0-9]/g, "_")
          .substring(0, 20);
        const msgFilename = `${timestamp}_${safeName}_${msg.id.id}.txt`;
        msgFilePath = path.join(TEMP_MEDIA_DIR, msgFilename);
        const fileContent = `Time: ${time}\nWhere: ${chatLocation}\nWho: ${senderName} (${senderActualNumber})\nSent: ${getIST(new Date(msg.timestamp * 1000))}\nMessage: ${messageBody}${mediaRef ? `\nMedia: ${mediaRef.trim().replace("Media: ", "")}` : ""}`;
        fs.writeFileSync(msgFilePath, fileContent, "utf8");

        // Auto-delete after 68h window
        const msgFileTimeout = setTimeout(() => {
          try {
            if (fs.existsSync(msgFilePath)) {
              fs.unlinkSync(msgFilePath);
            }
          } catch (e) {
            /* ignore cleanup errors */
          }
        }, DELETE_WINDOW_MS);

        // Store in tracker
        if (!mediaTracker.has(msg.id._serialized)) {
          mediaTracker.set(msg.id._serialized, {
            msgFilePath,
            msgFilename,
            msgFileTimeout,
          });
        } else {
          const existing = mediaTracker.get(msg.id._serialized);
          existing.msgFilePath = msgFilePath;
          existing.msgFilename = msgFilename;
          existing.msgFileTimeout = msgFileTimeout;
        }
      } catch (fileErr) {
        console.error("Error saving message file:", fileErr.message);
      }

      // Cache message for delete-for-everyone detection
      cacheMessage(msg.id._serialized, {
        body: messageBody,
        senderName,
        senderNumber: senderActualNumber,
        chatLocation,
        timestamp: msg.timestamp,
        msgFilePath,
      });

      console.log(`💾 Saved: ${chatLocation} - ${senderName}`);
    } catch (err) {
      console.error("Message handler error:", err);
    }
  });

  // ─── Also cache messages from message_create ──
  client.on("message_create", async (msg) => {
    try {
      if (msg.fromMe) return;
      if (!messageCache.has(msg.id._serialized)) {
        const chat = await msg.getChat();
        const contact = await msg.getContact();
        cacheMessage(msg.id._serialized, {
          body: msg.body || "[<empty>]",
          senderName: contact.name || contact.pushname || contact.number,
          senderNumber: contact.number,
          chatLocation: chat.isGroup ? `Group: ${chat.name}` : "Private Chat",
          timestamp: msg.timestamp,
        });
      }
    } catch (err) {
      // Silently ignore — backup cache
    }
  });

  // ─── Delete-for-Everyone Detection ──────────────────────
  client.on("message_revoke_everyone", async (afterMsg, beforeMsg) => {
    const msgId_dedup = afterMsg?.id?._serialized;
    console.log(
      `🗑️ [DELETE EVENT] message_revoke_everyone fired! msgId=${msgId_dedup}, beforeMsg=${!!beforeMsg}`,
    );

    // Skip during startup grace period
    if (Date.now() - readyTimestamp < STARTUP_GRACE_MS) {
      console.log(`⏩ Skipping (startup grace period): ${msgId_dedup}`);
      return;
    }

    // Skip duplicates
    if (processedRevokes.has(msgId_dedup)) {
      console.log(`⏩ Skipping duplicate: ${msgId_dedup}`);
      return;
    }
    processedRevokes.add(msgId_dedup);
    setTimeout(() => processedRevokes.delete(msgId_dedup), REVOKE_DEDUP_TTL_MS);

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

      // Check if we have temp media/message files for this message
      const tracked = mediaTracker.get(msgId);
      let mediaRef = "";

      if (tracked) {
        // Move media file to saved
        if (tracked.filePath) {
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

        // Move message .txt file to saved
        if (tracked.msgFilePath) {
          clearTimeout(tracked.msgFileTimeout);
          const savedMsgPath = path.join(SAVED_MEDIA_DIR, tracked.msgFilename);
          if (fs.existsSync(tracked.msgFilePath)) {
            fs.renameSync(tracked.msgFilePath, savedMsgPath);
            console.log(
              `🔒 Permanently saved deleted message file: ${tracked.msgFilename}`,
            );
          }
        }
      }

      // Also check cache for msgFilePath (text-only messages without media tracker entry)
      if (!tracked && cached && cached.msgFilePath) {
        try {
          const txtBasename = path.basename(cached.msgFilePath);
          const savedTxtPath = path.join(SAVED_MEDIA_DIR, txtBasename);
          if (fs.existsSync(cached.msgFilePath)) {
            fs.renameSync(cached.msgFilePath, savedTxtPath);
            console.log(
              `🔒 Permanently saved deleted message file: ${txtBasename}`,
            );
          }
        } catch (moveErr) {
          console.error("Error moving message file:", moveErr.message);
        }
      }

      // Log to file
      const logEntry = `\n🗑️ DELETED MESSAGE DETECTED\nTime: ${time}\nWhere: ${chatLocation}\nWho: ${senderName} (${senderNumber})\nOriginal Message: ${originalText}${mediaRef}\n==============================\n`;
      fs.appendFileSync("messages_log.txt", logEntry, "utf8");

      // Save deleted record as JSON file in media/saved
      saveDeletedRecord({
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
        mediaFilename:
          tracked && tracked.filename ? tracked.filename : undefined,
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
      if (tracked && tracked.filePath) {
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

  console.log("✅ WhatsApp Agent started via PM2.");
}

start().catch((err) => {
  console.error("Startup error:", err);
  process.exit(1);
});
