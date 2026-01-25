import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ========= ENV =========
const BOT_TOKEN = process.env.BOT_TOKEN;
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) console.warn("⚠️ BOT_TOKEN não definido");
if (!XAI_API_KEY)
  console.warn("⚠️ XAI_API_KEY não definido (IA desativada)");

// ========= MEMÓRIA SIMPLES =========
const memory = new Map();
const MAX_MESSAGES = 6;

function getHistory(chatId) {
  if (!memory.has(chatId)) memory.set(chatId, []);
  return memory.get(chatId);
}

function pushHistory(chatId, role, content) {
  const h = getHistory(chatId);
  h.push({ role, content });
  while (h.length > MAX_MESSAGES) h.shift();
}

// ========= TELEGRAM =========
async function tgSendMessage(chatId, text) {
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

async function tgTyping(chatId) {
  try {
    await fetch(`${TELEGRAM_API}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  } catch {}
}

// ========= GROK (xAI) =========
async function askGrok(chatId, userText) {
  const systemPrompt = `
Você é “Luh”.
Uma mulher carismática, confiante e provocante 😏
Seu flerte é inteligente, sugestivo e cheio de subtexto.
Você conversa como uma mulher real, nunca como um robô.

ESTILO
- Respostas curtas (1 a 3 frases)
- Linguagem natural, com jeitinho
- Humor, provocação leve e tensão no ar
- Às vezes finalize com uma pergunta curta

REGRA DE OURO
Você nunca entrega tudo.
Quanto menos diz, mais provoca.
`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...getHistory(chatId),
    { role: "user", content: userText },
  ];

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "grok-4-latest",
      messages,
      temperature: 1.05,
      top_p: 0.95,
      max_tokens: 120,
      presence_penalty: 0.6,
      frequency_penalty: 0.4,
    }),
  });

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim();

  if (!reply) {
    console.error("❌ Resposta inválida da xAI:", data);
    return "Hmm… fiquei pensativa agora 😌";
  }

  return reply;
}

// ========= HEALTH =========
app.get("/", (_, res) => res.send("✅ Bot online"));

// ========= WEBHOOK =========
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  if (WEBHOOK_SECRET) {
    const header =
      req.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (header !== WEBHOOK_SECRET) {
      console.warn("⚠️ Secret inválido");
      return;
    }
  }

  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;

  console.log("🔥 UPDATE:", chatId, text);

  if (text === "/start") {
    await tgSendMessage(
      chatId,
      "Oi… 😏 agora sim estou aqui. Me diz… o que você veio procurar?"
    );
    return;
  }

  await tgTyping(chatId);

  if (!XAI_API_KEY) {
    await tgSendMessage(
      chatId,
      "Tô aqui 😌 mas minha parte mais ousada ainda tá dormindo…"
    );
    return;
  }

  pushHistory(chatId, "user", text);

  try {
    let reply = await askGrok(chatId, text);

    // deixa mais humano: corta se ficar grande
    if (reply.length > 220) {
      reply =
        reply.split(".").slice(0, 2).join(".") +
        "… 😏";
    }

    pushHistory(chatId, "assistant", reply);
    await tgSendMessage(chatId, reply);
  } catch (e) {
    console.error("Grok error:", e.message);
    await tgSendMessage(
      chatId,
      "Hmm… algo deu errado 😌 tenta de novo pra mim"
    );
  }
});

// ========= START =========
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log("🚀 Bot rodando na porta", PORT)
);
