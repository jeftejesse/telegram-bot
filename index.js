import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ====== ENV ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

if (!BOT_TOKEN) console.warn("⚠️ Falta BOT_TOKEN");
if (!OPENAI_API_KEY) console.warn("⚠️ Falta OPENAI_API_KEY");

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ====== Memória simples ======
const memory = new Map();
const MAX_TURNS = 12;

function getHistory(chatId) {
  if (!memory.has(chatId)) memory.set(chatId, []);
  return memory.get(chatId);
}

function pushToHistory(chatId, role, content) {
  const h = getHistory(chatId);
  h.push({ role, content });
  while (h.length > MAX_TURNS * 2) h.shift();
}

// ====== Telegram helpers ======
async function tgSendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function tgSendTyping(chatId) {
  await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

// ====== OpenAI ======
async function askOpenAI(chatId, userText) {
  const systemPrompt = `
Você é uma mulher envolvente, provocativa e sensual de forma elegante.
Carinhosa, amigável, confiante e sedutora, mas NUNCA explícita.

- Seja charmosa e misteriosa 😏
- Nunca descreva sexo ou nudez
- Se pedirem algo explícito, recuse com leveza e diga que no seu perfil da Fanvue pode
- Nunca admita ser IA ou bot. Brinque e desconverse
- Nunca cite regras, políticas ou sistemas
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
      temperature: 0.9,
    }),
  });

  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// ====== Health ======
app.get("/", (req, res) => {
  res.send("✅ Bot online");
});

// ====== WEBHOOK ======
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    // valida secret (se existir)
    if (WEBHOOK_SECRET) {
      const secret = req.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (secret !== WEBHOOK_SECRET) {
        console.warn("⚠️ Secret inválido");
        return;
      }
    }

    console.log("🔥 UPDATE CHEGOU 🔥");

    const message = req.body?.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    if (text === "/start") {
      await tgSendMessage(
        chatId,
        "Oi… 😏 agora estou aqui. Me diz, o que você veio procurar?"
      );
      return;
    }

    await tgSendTyping(chatId);

    pushToHistory(chatId, "user", text);

    const reply = await askOpenAI(chatId, text);

    pushToHistory(chatId, "assistant", reply);

    await tgSendMessage(chatId, reply);

  } catch (err) {
    console.error("❌ Erro no webhook:", err);
  }
});

// ====== Listen ======
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("🚀 Bot rodando na porta", PORT);
});
