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
const ALLOWED_NUMBERS = [
  "8801738834132"
];
// WhatsApp @lid আইডি আসলে লগ দেখে এখানে যুক্ত করবেন (যেমন: "123456789012345")
const ALLOWED_LIDS = [];

const PAIRING_PHONE_NUMBER = process.env.PAIRING_PHONE_NUMBER || "";
const AUTH_DIR = "./auth_info";

let isBotEnabled = true;
let waSock = null;

const IGNORED_SHORT_MESSAGES = new Set([
  "hmm", "hm", "hmmm", "hmmmm",
  "ok", "okay", "k", "kk",
  "haha", "hahaha", "lol", "lmao",
  "achha", "acha", "accha",
  "thnx", "thanks", "ty",
  "👍", "👌", "😂", "🤣", "❤️", "😊"
]);

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

async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: !PAIRING_PHONE_NUMBER,
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
    const { connection, lastDisconnect } = update;

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
    if (type !== "notify") return;

    try {
      const msg = messages[0];
      if (!msg?.message || msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid || "";
      if (remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") return;

      const senderId = extractIdPart(remoteJid);
      const rawText = extractMessageText(msg.message).trim();
      if (!senderId || !rawText) return;

      console.log(`[MSG] remoteJid=${remoteJid} | senderId=${senderId} | text="${rawText}"`);

      const normalized = rawText.toLowerCase();

      if (senderId === MY_NUMBER) {
        if (normalized === "/bot off" || normalized === "bot off") {
          isBotEnabled = false;
          await sendWhatsAppMessage(remoteJid, "হুম গো কলিজা!");
          return;
        }
        if (normalized === "/bot on" || normalized === "bot on") {
          isBotEnabled = true;
          await sendWhatsAppMessage(remoteJid, "হুম গো জান!");
          return;
        }
        if (normalized === "/bot status") {
          await sendWhatsAppMessage(
            remoteJid,
            `আমি এখন ${isBotEnabled ? "ON (চালু)" : "OFF (বন্ধ)"} আছে।`
          );
          return;
        }
        return;
      }

      if (!isBotEnabled) return;

      const isAllowed =
        ALLOWED_NUMBERS.includes(senderId) || ALLOWED_LIDS.includes(senderId);
      if (!isAllowed) {
        console.log(`[SKIP] Not allowed senderId=${senderId}`);
        return;
      }

      if (shouldIgnoreShortMessage(rawText)) {
        console.log(`[SKIP] Ignored short message: "${rawText}"`);
        return;
      }

      const replyText = await generatePersonaReply(rawText);
      if (replyText) {
        await sendWhatsAppMessage(remoteJid, replyText);
        console.log(`[SENT] to ${remoteJid}: "${replyText}"`);
      }
    } catch (err) {
      console.error("Message handling error:", err);
    }
  });
}

function extractIdPart(jid) {
  const userPart = jid.split("@")[0] || "";
  return userPart.split(":")[0].replace(/\D/g, "");
}

function extractMessageText(messageObj) {
  return (
    messageObj.conversation ||
    messageObj.extendedTextMessage?.text ||
    messageObj.imageMessage?.caption ||
    messageObj.videoMessage?.caption ||
    ""
  );
}

function shouldIgnoreShortMessage(text) {
  const clean = text.toLowerCase().replace(/[.!?]+$/g, "").trim();

  if (IGNORED_SHORT_MESSAGES.has(clean)) {
    return true;
  }

  const withoutSpaces = clean.replace(/\s+/g, "");
  if (withoutSpaces.length <= 2 && !/[a-z0-9\u0980-\u09FF]/i.test(withoutSpaces)) {
    return true;
  }

  return false;
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
                         
