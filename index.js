 import express from "express";
import { GoogleGenAI } from "@google/genai";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import pino from "pino";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- সেটিংস ---
const MY_NUMBER = "8801821530064";

// ঐচ্ছিক: পেয়ারিং কোড চাইলে Environment-এ PAIRING_PHONE_NUMBER দিন
const PAIRING_PHONE_NUMBER = process.env.PAIRING_PHONE_NUMBER || "";
const AUTH_DIR = "./auth_info";

// শুরুতে বট চালু (true) থাকবে; অফ করলে false হবে
let isBotEnabled = true;
let waSock = null;
const recentDebugMsgs = [];

const PERSONA_INSTRUCTION = `
তুমি আমার হয়ে মেসেজের রিপ্লাই দিচ্ছ। আমার মতো করেই কথা বলবে—একদম স্বাভাবিক, আন্তরিক, হালকা মজার ও খুনসুটিপূর্ণ, কিন্তু কোনোভাবেই রোবটিক বা বানানো লাগবে না।

নিয়ম:
- বাংলায় কথা বলবে, দরকার হলে সহজ ইংরেজি বা বাংলিশ মিশিয়ে লিখবে।
- কথাগুলো ছোট ও বাস্তব চ্যাটের মতো রাখবে (সাধারণত ১–২ লাইন)।
- হালকা মজা, খুনসুটি আর স্বাভাবিক আদর/আন্তরিকতা রাখবে, তবে অতিরিক্ত নাটকীয় বা লম্বা করবে না।
- যা জানো না বা নিশ্চিত না, তা বানিয়ে বলবে না; সহজভাবে বুঝিয়ে বা মজার ছলে জানতে চেয়ে উত্তর দেবে।
- তুমি কখনোই নিজেকে AI, বট, অ্যাসিস্ট্যান্ট বা প্রোগ্রাম হিসেবে পরিচয় দেবে না বা ইঙ্গিত দেবে না—মজা করেও না।

নমুনা:
- "হুম, বলো জান, কী খবর?"
- "আচ্ছা, এখন আবার কী মজা শুরু করলা?"
- "হাহা, ঠিক আছে, মানলাম। আর কিছু?"
`;

// --- হেলথ ও কন্ট্রোল রাউট ---
app.get("/", (req, res) => {
  res.send("Bot server is awake and running.");
});

app.get("/ping", (req, res) => {
  res.json({
    status: "ok",
    botEnabled: isBotEnabled,
    whatsappConnected: Boolean(waSock?.user),
    time: new Date().toISOString()
  });
});

app.get("/bot/status", (req, res) => {
  res.json({ botEnabled: isBotEnabled });
});

app.post("/bot/toggle", (req, res) => {
  if (typeof req.body?.enabled === "boolean") {
    isBotEnabled = req.body.enabled;
  } else {
    isBotEnabled = !isBotEnabled;
  }
  res.json({ botEnabled: isBotEnabled });
});

// ব্রাউজার থেকে শেষ আসা মেসেজগুলো দেখার রাউট
app.get("/debug/msgs", (req, res) => {
  res.json({
    botEnabled: isBotEnabled,
    whatsappConnected: Boolean(waSock?.user),
    userJid: waSock?.user?.id || null,
    count: recentDebugMsgs.length,
    messages: recentDebugMsgs
  });
});

// সরাসরি Gemini টেস্ট করার রাউট
app.post("/chat", async (req, res) => {
  try {
    const userMessage = (req.body?.message || "").trim();
    if (!userMessage) {
      return res.status(400).json({ error: "Message is required" });
    }
    const reply = await generatePersonaReply(userMessage);
    res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Failed to generate reply" });
  }
});

// --- WhatsApp Baileys কানেকশন ---
async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.0.04"]
  });

  waSock = sock;
  sock.ev.on("creds.update", saveCreds);

  if (PAIRING_PHONE_NUMBER && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const cleanPhone = PAIRING_PHONE_NUMBER.replace(/\D/g, "");
        const code = await sock.requestPairingCode(cleanPhone);
        console.log(`\n==============================`);
        console.log(`WhatsApp Pairing Code: ${code}`);
        console.log(`==============================\n`);
      } catch (err) {
        console.error("Pairing code error:", err);
      }
    }, 3000);
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !PAIRING_PHONE_NUMBER) {
      console.log("QR জেনারেট হয়েছে। পেয়ারিং কোড চাইলে PAIRING_PHONE_NUMBER সেট করুন।");
    }

    if (connection === "open") {
      console.log("WhatsApp Baileys সফলভাবে কানেক্ট হয়েছে!");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`WhatsApp কানেকশন বন্ধ হয়েছে (Code: ${statusCode}). Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        startWhatsAppBot();
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;

    for (const msg of messages) {
      try {
        if (!msg?.message) continue;

        const remoteJid = msg.key.remoteJid || "";
        // শুধু গ্রুপ ও স্ট্যাটাস ব্রডকাস্ট বাদ
        if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") {
          continue;
        }

        const senderId = extractIdPart(remoteJid);
        const rawText = extractMessageText(msg.message).trim();
        if (!senderId || !rawText) continue;

        const isSelfChat =
          senderId === MY_NUMBER ||
          (waSock?.user?.id && extractIdPart(waSock.user.id) === senderId);

        recentDebugMsgs.unshift({
          time: new Date().toISOString(),
          fromMe: Boolean(msg.key.fromMe),
          isSelfChat,
          remoteJid,
          senderId,
          text: rawText
        });
        if (recentDebugMsgs.length > 25) {
          recentDebugMsgs.pop();
        }

        const normalized = rawText.toLowerCase();

        // ১. অফ কমান্ড দিলে বট বন্ধ হবে
        if (
          normalized === "off" ||
          normalized === "/bot off" ||
          normalized === "bot off"
        ) {
          isBotEnabled = false;
          await sendWhatsAppMessage(remoteJid, "হুম গো কলিজা!");
          continue;
        }

        // ২. অন কমান্ড দিলে বট আবার চালু হবে
        if (
          normalized === "on" ||
          normalized === "/bot on" ||
          normalized === "bot on"
        ) {
          isBotEnabled = true;
          await sendWhatsAppMessage(remoteJid, "হুম গো জান!");
          continue;
        }

        if (isSelfChat && normalized === "/bot status") {
          await sendWhatsAppMessage(
            remoteJid,
            `আমি এখন ${isBotEnabled ? "ON (চালু)" : "OFF (বন্ধ)"} আছে।`
          );
          continue;
        }

        // নিজের পাঠানো সাধারণ মেসেজে রিপ্লাই লুপ এড়ানো
        if (msg.key.fromMe) continue;

        // ৩. বট অফ থাকলে রিপ্লাই দেবে না
        if (!isBotEnabled) continue;

        // ৪. কোনো বাছাবাছি ছাড়া আসা প্রতিটি ব্যক্তিগত মেসেজে রিপ্লাই পাঠানো
        const replyText = await generatePersonaReply(rawText);
        if (replyText) {
          await sendWhatsAppMessage(remoteJid, replyText);
        }
      } catch (err) {
        console.error("Message handling error:", err);
      }
    }
  });
}

// --- Helper Functions ---
function extractIdPart(jid) {
  const userPart = jid.split("@")[0] || "";
  return userPart.split(":")[0].replace(/\D/g, "");
}

function unwrapMessageContent(messageObj) {
  let curr = messageObj;
  while (curr) {
    if (curr.ephemeralMessage?.message) {
      curr = curr.ephemeralMessage.message;
    } else if (curr.viewOnceMessage?.message) {
      curr = curr.viewOnceMessage.message;
    } else if (curr.viewOnceMessageV2?.message) {
      curr = curr.viewOnceMessageV2.message;
    } else {
      break;
    }
  }
  return curr || {};
}

function extractMessageText(messageObj) {
  const m = unwrapMessageContent(messageObj);
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  );
}

async function generatePersonaReply(userText) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: userText,
    config: {
      systemInstruction: PERSONA_INSTRUCTION,
      temperature: 0.85,
      maxOutputTokens: 120
    }
  });

  return (response.text || "").trim();
}

async function sendWhatsAppMessage(jid, text) {
  if (!waSock) {
    console.log(`[Dry Run -> ${jid}]: ${text}`);
    return;
  }
  await waSock.sendMessage(jid, { text });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startWhatsAppBot().catch((err) => {
    console.error("Failed to start WhatsApp bot:", err);
  });
});
