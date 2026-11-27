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
const MY_NUMBER = "8801821530064"; // আপনার নিজের WhatsApp নম্বর (কান্ট্রি কোডসহ, + ছাড়া)
const ALLOWED_NUMBERS = [
  "8801738834132" // গার্লফ্রেন্ডের WhatsApp নম্বর (কান্ট্রি কোডসহ, + ছাড়া)
];

// ঐচ্ছিক: Render Logs-এ Pairing Code চাইলে আপনার নম্বর দিন, নাহলে QR কোড দেখাবে
const PAIRING_PHONE_NUMBER = process.env.PAIRING_PHONE_NUMBER || "";
const AUTH_DIR = "./auth_info";

// যখন ইচ্ছা তখন বট অন/অফ করার স্টেট (শুরুতে true)
let isBotEnabled = true;
let waSock = null;

// যেসব ছোট মেসেজে অযথা রিপ্লাই দিয়ে কোটা নষ্ট করবে না
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

// --- হেলথ ও পিং রাউট ---
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

// ব্রাউজার বা API দিয়ে বট অন/অফ করার সহজ রাউট
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

// --- সরাসরি Gemini টেস্ট করার রাউট ---
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
    printQRInTerminal: !PAIRING_PHONE_NUMBER,
    browser: ["Ubuntu", "Chrome", "20.0.04"]
  });

  waSock = sock;
  sock.ev.on("creds.update", saveCreds);

  // Pairing Code ব্যবহার করতে চাইলে (ঐচ্ছিক)
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
      console.log("QR কোড জেনারেট হয়েছে (লগ দেখুন বা পেয়ারিং কোড ব্যবহার করুন)।");
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
    if (type !== "notify") return;

    try {
      const msg = messages[0];
      if (!msg?.message || msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid || "";
      // গ্রুপ চ্যাট এড়িয়ে শুধু ব্যক্তিগত চ্যাট নেওয়া
      if (remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") return;

      const senderNumber = extractPhoneNumber(remoteJid);
      const rawText = extractMessageText(msg.message).trim();
      if (!senderNumber || !rawText) return;

      const normalized = rawText.toLowerCase();

      // ১. আপনি নিজে নিজের নম্বর (বা নিজের চ্যাট) থেকে কমান্ড পাঠালে বট অন/অফ হবে
      if (senderNumber === MY_NUMBER) {
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

      // ২. বট বন্ধ থাকলে কোনো রিপ্লাই দেবে না
      if (!isBotEnabled) return;

      // ৩. শুধু অনুমোদিত নম্বরে (গার্লফ্রেন্ডের নম্বর) রিপ্লাই দেবে
      if (!ALLOWED_NUMBERS.includes(senderNumber)) return;

      // ৪. অপ্রয়োজনীয় ছোট মেসেজ এড়িয়ে চলবে
      if (shouldIgnoreShortMessage(rawText)) return;

      // ৫. Gemini দিয়ে রিপ্লাই তৈরি করে পাঠানো
      const replyText = await generatePersonaReply(rawText);
      if (replyText) {
        await sendWhatsAppMessage(remoteJid, replyText);
      }
    } catch (err) {
      console.error("Message handling error:", err);
    }
  });
}

// --- Helper Functions ---
function extractPhoneNumber(jid) {
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
