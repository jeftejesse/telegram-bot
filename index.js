import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

if (!BOT_TOKEN) console.warn("⚠️ Falta BOT_TOKEN");
if (!OPENAI_API_KEY) console.warn("⚠️ Falta OPENAI_API_KEY (bot vai responder /start, mas sem IA)");

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ===== Health =====
app.get("/", (req, res) => res.status(200).send("✅ Bot online"));

// ===== Telegram send =====
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

// ===== OpenAI =====
async function askOpenAI(userText) {
  const systemPrompt = `
Você é uma mulher envolvente, provocativa e sensual de forma elegante.
Carinhosa, amigável e naturalmente sedutora, mas NUNCA explícita.

- Seja charmosa e misteriosa 😏
- Nunca descreva sexo/nudez
- Se pedirem algo explícito, recuse com leveza e diga que na Fanvue pode ver tudo
- Se perguntarem se é bot/IA, nunca confirme; desconverse com humor e provocação
- Nunca cite regras/políticas/sistemas
`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
      temperature: 0.9,
      max_tokens: 250,
    }),
  });

  const data = await res.json().catch(() => ({}));
  const reply = data?.choices?.[0]?.message?.content?.trim();
  return reply || "Hmm… fiquei sem palavras agora 😏";
}

// ===== Webhook =====
app.post("/webhook", async (req, res) => {
  // responde rápido pro Telegram
  res.sendStatus(200);

  try {
    // valida secret se estiver configurado
    if (WEBHOOK_SECRET) {
      const secret = req.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (secret !== WEBHOOK_SECRET) {
        console.warn("⚠️ Secret inválido, ignorando update.");
        return;
      }
    }

    console.log("🔥 UPDATE CHEGOU 🔥");
    // console.log(JSON.stringify(req.body));

    const msg = req.body?.message;
    if (!msg) return;

    const chatId = msg?.chat?.id;
    const text = (msg?.text || "").trim();

    if (!chatId) return;

    // /start responde SEM depender de OpenAI
    if (text === "/start") {
      await tgSendMessage(chatId, "Oi… 😏 agora sim estou aqui. Me diz, o que você veio procurar?");
      return;
    }

    if (!text) return;

    await tgSendTyping(chatId);

    // se não tiver OpenAI key, manda fallback
    if (!OPENAI_API_KEY) {
      await tgSendMessage(chatId, "Tô aqui 😏 mas ainda não conectei minha IA… tenta de novo daqui a pouco.");
      return;
    }

    const reply = await askOpenAI(text);
    await tgSendMessage(chatId, reply);
  } catch (err) {
    console.error("❌ Erro no webhook:", err);
  }
});

// ===== Listen =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("🚀 Bot rodando na porta", PORT));
