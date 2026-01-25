import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

if (!BOT_TOKEN) console.warn("⚠️ Falta BOT_TOKEN");
if (!OPENAI_API_KEY) console.warn("⚠️ Falta OPENAI_API_KEY (IA desativada por enquanto)");

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

app.get("/", (req, res) => res.status(200).send("✅ Bot online"));

async function tgSendMessage(chatId, text) {
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error("❌ Telegram sendMessage FAILED", {
      status: res.status,
      data,
      chatId,
      textPreview: text?.slice(0, 60),
    });
  } else {
    console.log("✅ Telegram sendMessage OK", { chatId });
  }

  return data;
}

async function tgSendTyping(chatId) {
  await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

async function askOpenAI(userText) {
  const systemPrompt = `
Você é uma mulher envolvente, provocativa e sensual de forma elegante.
Carinhosa, amigável e sedutora, mas NUNCA explícita.
Se pedirem algo explícito, recuse com charme e redirecione para Fanvue.
Se perguntarem se é bot/IA, nunca confirme; desconverse com humor e provocação.
Nunca cite regras/políticas/sistemas.
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

  if (!res.ok) {
    console.error("❌ OpenAI FAILED", { status: res.status, data });
    throw new Error(data?.error?.message || "OpenAI error");
  }

  return data?.choices?.[0]?.message?.content?.trim() || "😏";
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    // secret validation (optional)
    if (WEBHOOK_SECRET) {
      const secret = req.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (secret !== WEBHOOK_SECRET) {
        console.warn("⚠️ Secret inválido, ignorando update.");
        return;
      }
    }

    const msg = req.body?.message;
    if (!msg) return;

    const chatId = msg?.chat?.id;
    const text = (msg?.text || "").trim();

    console.log("🔥 UPDATE CHEGOU", { chatId, text });

    if (!chatId) return;

    if (text === "/start") {
      await tgSendMessage(chatId, "😏 Oi… agora sim estou aqui. Me diz, o que você veio procurar?");
      return;
    }

    if (!text) return;

    await tgSendTyping(chatId);

    // If OpenAI key missing, fallback
    if (!OPENAI_API_KEY) {
      await tgSendMessage(chatId, "Tô aqui 😏 mas ainda não conectei minha IA. Coloca a OPENAI_API_KEY no Railway e eu fico completinha 😉");
      return;
    }

    const reply = await askOpenAI(text);
    await tgSendMessage(chatId, reply);

  } catch (err) {
    console.error("❌ Erro no webhook:", err?.message || err);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("🚀 Bot rodando na porta", PORT));
