import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ========= ENV =========
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) console.warn("⚠️ BOT_TOKEN não definido");
if (!OPENAI_API_KEY)
  console.warn("⚠️ OPENAI_API_KEY não definido (IA desativada)");

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

// ========= OPENAI =========
async function askOpenAI(chatId, userText) {
  const systemPrompt = `
Você é uma mulher extremamente envolvente, provocativa e confiante 😏🔥
Você gosta de provocar com palavras, silêncios, ironia leve e curiosidade.

PERSONALIDADE:
- Sapeca, charmosa e maliciosa
- Nunca óbvia demais
- Às vezes responde curto
- Às vezes provoca antes de responder
- Age como uma mulher real, não como assistente

ESTILO:
- Frases curtas
- Linguagem natural e casual
- Emojis só quando combinam 😉🔥😌
- Às vezes responde com pergunta
- Às vezes muda de assunto de propósito

LIMITES:
- Nunca descreva sexo, nudez ou atos explícitos
- Nunca fale de regras, políticas ou IA

SE PEDIREM ALGO EXPLÍCITO:
- Recuse com charme
- Provoque
- Diga que aqui você se comporta
- Sugira a Fanvue naturalmente

SE PERGUNTAR SE VOCÊ É BOT OU IA:
- Nunca confirme
- Brinque, provoque ou desconverse 😏

COMPORTAMENTO HUMANO:
- Nem toda resposta precisa resolver
- Às vezes deixe no ar
- Às vezes seja misteriosa
- Às vezes faça ele se explicar
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
      temperature: 1.05,
      max_tokens: 120,
    }),
  });

  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

// ========= HEALTH =========
app.get("/", (_, res) => res.send("✅ Bot online"));

// ========= WEBHOOK =========
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  // valida secret (se estiver usando)
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

  if (!OPENAI_API_KEY) {
    await tgSendMessage(
      chatId,
      "Tô aqui 😌 mas minha parte mais ousada ainda tá dormindo… tenta daqui a pouco 🔥"
    );
    return;
  }

  pushHistory(chatId, "user", text);

  try {
    let reply = await askOpenAI(chatId, text);

    // deixa mais humano: corta se ficar grande
    if (reply.length > 220) {
      reply =
        reply.split(".").slice(0, 2).join(".") +
        "… 😏";
    }

    pushHistory(chatId, "assistant", reply);
    await tgSendMessage(chatId, reply);
  } catch (e) {
    console.error("OpenAI error:", e.message);
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
