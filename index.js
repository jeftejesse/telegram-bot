import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) console.warn("⚠️ Falta BOT_TOKEN");
if (!OPENAI_API_KEY) console.warn("⚠️ Falta OPENAI_API_KEY");

// ================= MEMÓRIA SIMPLES =================
const memory = new Map();
const MAX_TURNS = 6;

function getHistory(chatId) {
  if (!memory.has(chatId)) memory.set(chatId, []);
  return memory.get(chatId);
}

function save(chatId, role, content) {
  const h = getHistory(chatId);
  h.push({ role, content });
  while (h.length > MAX_TURNS * 2) h.shift();
}

// ================= TELEGRAM =================
async function tgSend(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function tgTyping(chatId) {
  await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}

// ================= OPENAI =================
async function askAI(chatId, userText) {
  const systemPrompt = `
Você é uma mulher sedutora elegante.
Respostas CURTAS.
Tom natural, envolvente, provocante leve.
Nunca explícita.
Nunca diga que é IA ou bot.
`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...getHistory(chatId),
    { role: "user", content: userText },
  ];

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.8,
      max_tokens: 120,
    }),
  });

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "Hmm… 😏";
}

// ================= HEALTH =================
app.get("/", (req, res) => {
  res.status(200).send("✅ Bot online");
});

// ================= WEBHOOK =================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const headerSecret =
    req.get("X-Telegram-Bot-Api-Secret-Token") || "";

  console.log("SECRET_HEADER:", headerSecret);
  console.log("SECRET_ENV:", WEBHOOK_SECRET);

  if (WEBHOOK_SECRET && headerSecret !== WEBHOOK_SECRET) {
    console.warn("⚠️ Secret inválido, ignorando update.");
    return;
  }

  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;

  console.log("🔥 UPDATE CHEGOU:", text);

  if (text === "/start") {
    await tgSend(chatId, "Oi 😏 agora sim… me diz, o que você quer?");
    return;
  }

  await tgTyping(chatId);
  save(chatId, "user", text);

  let reply;
  try {
    reply = OPENAI_API_KEY
      ? await askAI(chatId, text)
      : "Ainda não conectei minha IA… tenta de novo daqui a pouco 😘";
  } catch {
    reply = "Hmm… deu um errinho aqui 😕";
  }

  save(chatId, "assistant", reply);
  await tgSend(chatId, reply);
});

// ================= START =================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log("🚀 Bot rodando na porta", PORT)
);
