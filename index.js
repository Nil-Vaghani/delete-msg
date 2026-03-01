const { Client, LocalAuth } = require("whatsapp-web.js");
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
  console.error("⚠️ [UNHANDLED] Promise rejection:", reason);
});

// ─── Validate Environment Variables ─────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WA_PHONE_NUMBER = process.env.WA_PHONE_NUMBER;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.");
  process.exit(1);
}
if (!WA_PHONE_NUMBER) {
  console.error("❌ WA_PHONE_NUMBER is required for pairing code auth.");
  process.exit(1);
}

// ─── Constants ──────────────────────────────────────────
const AUTH_DATA_PATH = path.join(__dirname, ".wwebjs_auth");
const TEMP_MEDIA_DIR = path.join(__dirname, "media", "temp");
const SAVED_MEDIA_DIR = path.join(__dirname, "media", "saved");
const DELETE_WINDOW_MS = 68 * 60 * 60 * 1000; // 68 hours
const MAX_CACHE_SIZE = 500;
const MESSAGE_CACHE_TTL_MS = DELETE_WINDOW_MS;
const STARTUP_GRACE_MS = 30 * 1000;
const REVOKE_DEDUP_TTL_MS = 60 * 1000;
const MAX_MEDIA_SIZE_MB = 10;

// ─── Ensure directories ─────────────────────────────────
[TEMP_MEDIA_DIR, SAVED_MEDIA_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── State ──────────────────────────────────────────────
let currentClient = null;
let pairingCodeSent = false;
let readyTimestamp = 0;
const messageCache = new Map();
const mediaTracker = new Map();
const processedRevokes = new Set();
let telegramPollingActive = true;
let telegramUpdateOffset = 0;

// ─── Telegram Helpers ───────────────────────────────────

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

    let res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
        }),
      },
    );

    if (!res.ok) {
      const plainText = `${title}\n\n${body}`;
      res = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: plainText }),
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

// ─── Message Cache ──────────────────────────────────────
function cacheMessage(msgId, data) {
  if (messageCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = messageCache.keys().next().value;
    messageCache.delete(oldestKey);
  }
  messageCache.set(msgId, { ...data, cachedAt: Date.now() });
  setTimeout(() => messageCache.delete(msgId), MESSAGE_CACHE_TTL_MS);
}

// ─── Helpers ────────────────────────────────────────────

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

async function saveMediaToTemp(msg) {
  try {
    if (!msg.hasMedia) return null;
    const media = await msg.downloadMedia();
    if (!media || !media.data) return null;

    const sizeBytes = Buffer.byteLength(media.data, "base64");
    if (sizeBytes > MAX_MEDIA_SIZE_MB * 1024 * 1024) {
      console.log(
        `⚠️ Skipping large media (${(sizeBytes / 1024 / 1024).toFixed(1)}MB > ${MAX_MEDIA_SIZE_MB}MB)`,
      );
      return null;
    }

    const ext = getExtension(media.mimetype);
    const timestamp = Date.now();
    const filename = `${timestamp}_${msg.id.id}${ext}`;
    const filePath = path.join(TEMP_MEDIA_DIR, filename);

    fs.writeFileSync(filePath, Buffer.from(media.data, "base64"));

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

// ─── Telegram Bot Command Polling ───────────────────────
async function pollTelegramCommands() {
  console.log(
    "🤖 Telegram bot command polling started. Send /rebuild to re-authenticate.",
  );

  while (telegramPollingActive) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${telegramUpdateOffset}&timeout=30&allowed_updates=["message"]`,
      );
      const data = await res.json();
      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          telegramUpdateOffset = update.update_id + 1;
          const text = update.message?.text?.trim();
          const chatId = String(update.message?.chat?.id);

          // Only accept commands from the authorized chat
          if (chatId !== TELEGRAM_CHAT_ID) continue;

          if (text === "/rebuild") {
            console.log("🔄 /rebuild command received from Telegram");
            await handleReauth();
          } else if (text === "/status") {
            const status = currentClient?.info
              ? `✅ Connected as ${currentClient.info.pushname}`
              : "❌ Not connected";
            await sendPushNotification(
              "📊 Status",
              `${status}\nTime: ${getIST()}\nCache: ${messageCache.size} messages\nMedia tracked: ${mediaTracker.size}`,
            );
          }
        }
      }
    } catch (err) {
      // Polling error — retry after delay
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ─── Reauth Handler ─────────────────────────────────────
async function handleReauth() {
  try {
    await sendPushNotification(
      "🔄 Re-authenticating",
      "Clearing old session and requesting new pairing code...",
    );

    // Destroy current client
    if (currentClient) {
      try {
        await currentClient.destroy();
      } catch (e) {
        console.error("Client destroy error (ignored):", e.message);
      }
      currentClient = null;
    }

    // Delete auth data
    const sessionPath = path.join(AUTH_DATA_PATH, "session-wa-agent");
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log("🗑️ Old auth session deleted");
    }

    // Start fresh client
    await startClient();
  } catch (err) {
    console.error("Reauth error:", err);
    await sendPushNotification("❌ Reauth Failed", `Error: ${err.message}`);
  }
}

// ─── Create WhatsApp Client with all event handlers ─────
function createClient() {
  pairingCodeSent = false;

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: "wa-agent",
      dataPath: AUTH_DATA_PATH,
    }),
    pairWithPhoneNumber: {
      phoneNumber: WA_PHONE_NUMBER,
      showNotification: true,
      intervalMs: 86400000, // 24h — effectively no auto-retry (user must /rebuild)
    },
    authTimeoutMs: 120000,
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

  // ─── Pairing Code Auth (replaces QR scanning) ──────────
  client.on("code", async (code) => {
    console.log(`🔑 Pairing code received: ${code}`);
    await sendPushNotification(
      "🔑 WhatsApp Pairing Code",
      `Your code: ${code}\n\n👉 WhatsApp → Settings → Linked Devices → Link a Device → Link with Phone Number\n\nEnter this code when prompted.\n\n⚠️ Code expires in ~20 seconds. If it expires, send /rebuild to get a new one.`,
    );
  });

  client.on("authenticated", () => {
    console.log("✅ [AUTH] WhatsApp authenticated! Session saved locally.");
  });

  client.on("auth_failure", async (message) => {
    console.error(`❌ [AUTH] Authentication FAILED: ${message}`);
    await sendPushNotification(
      "❌ Auth Failed",
      `Authentication failed: ${message}\n\nSend /rebuild to try again.`,
    );
  });

  client.on("loading_screen", (percent, message) => {
    console.log(`⏳ [LOADING] WhatsApp loading: ${percent}% — ${message}`);
  });

  client.on("disconnected", async (reason) => {
    console.error(`🔌 [DISCONNECTED] WhatsApp disconnected: ${reason}`);
    await sendPushNotification(
      "🔌 Disconnected",
      `WhatsApp disconnected: ${reason}\n\nSend /rebuild to reconnect.`,
    );
  });

  client.on("change_state", (state) => {
    console.log(`🔄 [STATE] Connection state: ${state}`);
  });

  client.on("ready", async () => {
    console.log("\n✅ [READY] WhatsApp connected & ready!");
    console.log(`✅ [READY] Logged in at: ${getIST()}`);
    await sendPushNotification(
      "✅ WhatsApp Connected",
      `Bot is now connected and ready.\nTime: ${getIST()}\n\nCommands:\n/status — Check bot status\n/rebuild — Re-authenticate`,
    );

    readyTimestamp = Date.now();
    console.log(`⏳ Startup grace period: ${STARTUP_GRACE_MS / 1000}s`);
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

      // Save media temporarily
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
            const savedPath = path.join(SAVED_MEDIA_DIR, tracked.filename);
            if (fs.existsSync(tracked.filePath)) {
              fs.copyFileSync(tracked.filePath, savedPath);
              console.log(`🔒 View-once saved: ${tracked.filename}`);
            }

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
                `👁️ View-once from ${senderName} (${senderActualNumber})\nIn: ${chatLocation}`,
              );
            }
          }
        } catch (err) {
          console.error("View-once capture error:", err);
        }
      }

      // Log to file
      const logEntry = `Time: ${time}\nWhere: ${chatLocation}\nWho: ${senderName} (${senderActualNumber})\nMessage: ${messageBody}${mediaRef}\n------------------------------\n`;
      fs.appendFileSync("messages_log.txt", logEntry, "utf8");

      // Save message as .txt file in media/temp
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

        const msgFileTimeout = setTimeout(() => {
          try {
            if (fs.existsSync(msgFilePath)) fs.unlinkSync(msgFilePath);
          } catch (e) {
            /* ignore */
          }
        }, DELETE_WINDOW_MS);

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

      // Cache message
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

  // ─── Backup cache from message_create ──
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
      // Silently ignore
    }
  });

  // ─── Delete-for-Everyone Detection ──────────────────────
  client.on("message_revoke_everyone", async (afterMsg, beforeMsg) => {
    const msgId_dedup = afterMsg?.id?._serialized;
    console.log(`🗑️ [DELETE] msgId=${msgId_dedup}, beforeMsg=${!!beforeMsg}`);

    if (Date.now() - readyTimestamp < STARTUP_GRACE_MS) {
      console.log(`⏩ Skipping (startup grace): ${msgId_dedup}`);
      return;
    }

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
        console.error("Could not get chat:", chatErr.message);
      }

      let senderName = "Unknown";
      let senderNumber = "Unknown";
      let originalText = "[Unknown - message not cached]";

      if (beforeMsg) {
        try {
          const contact = await beforeMsg.getContact();
          senderName = contact.name || contact.pushname || contact.number;
          senderNumber = contact.number;
        } catch (e) {
          console.warn("Could not get contact:", e.message);
        }
        originalText = beforeMsg.body || "[<empty>]";
      }

      const msgId = beforeMsg
        ? beforeMsg.id._serialized
        : afterMsg.id._serialized;
      const cached = messageCache.get(msgId);
      if (cached) {
        console.log(`📋 Cache hit: ${cached.body?.substring(0, 50)}...`);
        if (senderName === "Unknown") senderName = cached.senderName;
        if (senderNumber === "Unknown") senderNumber = cached.senderNumber;
        if (originalText === "[Unknown - message not cached]")
          originalText = cached.body;
        if (chatLocation === "Unknown Chat") chatLocation = cached.chatLocation;
      }

      // Move files from temp to saved
      const tracked = mediaTracker.get(msgId);
      let mediaRef = "";

      if (tracked) {
        if (tracked.filePath) {
          clearTimeout(tracked.timeout);
          const savedPath = path.join(SAVED_MEDIA_DIR, tracked.filename);
          if (fs.existsSync(tracked.filePath)) {
            fs.renameSync(tracked.filePath, savedPath);
            mediaRef = `\nSaved Media: media/saved/${tracked.filename}`;
            console.log(`🔒 Saved deleted media: ${tracked.filename}`);
          }
        }
        if (tracked.msgFilePath) {
          clearTimeout(tracked.msgFileTimeout);
          const savedMsgPath = path.join(SAVED_MEDIA_DIR, tracked.msgFilename);
          if (fs.existsSync(tracked.msgFilePath)) {
            fs.renameSync(tracked.msgFilePath, savedMsgPath);
            console.log(`🔒 Saved deleted msg file: ${tracked.msgFilename}`);
          }
        }
      }

      // Text-only fallback
      if (!tracked && cached && cached.msgFilePath) {
        try {
          const txtBasename = path.basename(cached.msgFilePath);
          const savedTxtPath = path.join(SAVED_MEDIA_DIR, txtBasename);
          if (fs.existsSync(cached.msgFilePath)) {
            fs.renameSync(cached.msgFilePath, savedTxtPath);
            console.log(`🔒 Saved deleted msg file: ${txtBasename}`);
          }
        } catch (moveErr) {
          console.error("Error moving message file:", moveErr.message);
        }
      }

      // Log to file
      const logEntry = `\n🗑️ DELETED MESSAGE\nTime: ${time}\nWhere: ${chatLocation}\nWho: ${senderName} (${senderNumber})\nOriginal: ${originalText}${mediaRef}\n==============================\n`;
      fs.appendFileSync("messages_log.txt", logEntry, "utf8");

      // Save deleted record
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

      // Telegram notification
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

      // Send deleted media to Telegram
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

      // Cleanup
      if (tracked) mediaTracker.delete(msgId);
      messageCache.delete(msgId);
    } catch (err) {
      console.error("Delete detection error:", err);
      try {
        await sendPushNotification(
          "🗑️ Message Deleted",
          `A message was deleted but details could not be retrieved.\nError: ${err.message}`,
        );
      } catch (e) {
        console.error("Fallback notification failed:", e);
      }
    }
  });

  // ─── Graceful Shutdown ─────────────────────────────────
  const shutdown = async (signal) => {
    console.log(`\n${signal} received. Shutting down...`);
    telegramPollingActive = false;
    try {
      await client.destroy();
      console.log("👋 Bye!");
    } catch (e) {
      console.error("Shutdown error:", e);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return client;
}

// ─── Start Client ───────────────────────────────────────
async function startClient() {
  // Startup cleanup: remove expired temp files
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
    if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} expired temp file(s)`);
  } catch (err) {
    console.error("Temp cleanup error:", err.message);
  }

  console.log("🌐 Launching Chrome...");
  currentClient = createClient();

  console.log("🚀 Initializing WhatsApp Web...");
  currentClient.initialize().catch(async (err) => {
    const msg = typeof err === "string" ? err : err?.message || String(err);
    console.error("❌ Initialize failed:", msg);
    await sendPushNotification(
      "❌ Init Failed",
      `WhatsApp failed to start: ${msg}\n\nSend /rebuild to try again.`,
    );
  });
}

// ─── Main Entry Point ───────────────────────────────────
async function main() {
  console.log("🤖 WhatsApp Agent starting...");

  // Start Telegram command polling (runs in background)
  pollTelegramCommands();

  // Start WhatsApp client
  await startClient();

  console.log("✅ WhatsApp Agent started.");
}

main().catch((err) => {
  console.error("Startup error:", err);
  process.exit(1);
});
