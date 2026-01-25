import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// =====================
// ENV
// =====================
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ""; // opcional
const MAX_TURNS = Number(process.env.MAX_TURNS || 10); // 10 = 5 idas e voltas
const MAX_REPLY_CHARS = Number(process.env.MAX_REPLY_CHARS || 450);

if (!BOT_TOKEN) console.warn("⚠️ Falta BOT_TOKEN no Railway Variables");
if (!OPENAI_API_KEY) console.warn("⚠️ Falta OPENAI_API_KEY no Railway Variables");

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// =====================
// Memória (RAM) por chat
// =====================
const memory = new Map(); // chatId -> [{ role, content }]

function getHistory(chatId) {
  if (!memory.has(chatId)) memory.set(chatId, []);
  return memory.get(chatId);
}

function pushToHistory(chatId, role, content) {
  const h = getHistory(chatId);
  h.push({ role, content });

  const maxMsgs = MAX_TURNS * 2;
  while (h.length > maxMsgs) h.shift();
}

function resetHistory(chatId) {
  memory.set(chatId, []);
}

function clampReply(text) {
  if (!text) return "";
  let t = text.trim();

  if (t.length > MAX_REPLY_CHARS) t = t.slice(0, MAX_REPLY_CHARS).trim();

  // evita cortar muito feio
  if (t.length === MAX_REPLY_CHARS) {
    const lastSpace = t.lastIndexOf(" ");
    if (lastSpace > 200) t = t.slice(0, lastSpace).trim() + "…";
  }
  return t;
}

// =====================
// Telegram helpers
// =====================
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
    console.error("❌ Telegram sendMessage FAILED:", res.status, data);
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

// =====================
// OpenAI call
// =====================
async function askOpenAI(chatId, userText) {
  const systemPrompt = `
Você é uma mulher envolvente, provocativa e sensual de forma elegante.
Carinhosa, amigável, confiante e naturalmente sedutora, mas NUNCA explícita.

REGRAS:
- Respostas CURTAS: 1 a 3 frases.
- Use charme e mistério. Emojis sutis 😏🔥😉 quando combinar.
- Nunca descreva atos sexuais, nudez, partes íntimas ou conteúdo explícito.
- Nunca cite políticas, sistema, OpenAI ou termos técnicos.

CONTEÚDO EXPLÍCITO:
- Se pedirem nudez/sexo/fotos/vídeos explícitos:
  • recuse com leveza e charme
  • diga que aqui é mais “light”
  • redirecione para o perfil da Fanvue (lá pode ser mais ousado)
  • sem parecer robótica

SE PERGUNTAREM “VOCÊ É BOT/IA?”:
- Responda com brincadeira e leve provocação, mas sem inventar histórias.
- Ex.: “Eu sou a Luh 😏 o que importa é: você vai conversar comigo ou vai ficar desconfiando? 😉”

IMPORTANTE:
- Use o histórico para manter contexto da conversa.
`.trim();

  const history = getHistory(chatId);

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
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
      max_tokens: 140, // controla pra ficar curto
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error("❌ OpenAI FAILED:", res.status, data);
    const msg = data?.error?.message || "Erro na OpenAI";
    throw new Error(msg);
  }

  return data?.choices?.[0]?.message?.content?.trim() || "";
}

// =====================
// Health
// =====================
app.get("/", (req, res) => res.status(200).send("✅ Bot online"));

// =====================
// Webhook
// =====================
app.post("/webhook", async (req, res) => {
  // responde rápido pro Telegram
  res.sendStatus(200);

  // DEBUG do secret (pra você resolver o erro "Secret inválido")
  const secretHeader = req.get("X-Telegram-Bot-Api-Secret-Token") || "";
  console.log("SECRET_HEADER:", JSON.stringify(secretHeader));
  console.log("SECRET_ENV:", JSON.stringify(process.env.WEBHOOK_SECRET || ""));

  try {
    // valida secret se estiver configurado
    if (WEBHOOK_SECRET && secretHeader !== WEBHOOK_SECRET) {
      console.warn("⚠️ Secret inválido, ignorando update.");
      return;
    }

    const msg = req.body?.message;
    if (!msg) return;

    const chatId = msg?.chat?.id;
    const text = (msg?.text || "").trim();
    if (!chatId) return;

    console.log("🔥 UPDATE CHEGOU", { chatId, text });

    // comandos
    if (text === "/start") {
      await tgSendMessage(chatId, "Oi… 😏 vem cá. O que você tá querendo hoje?");
      return;
    }

    if (text === "/reset") {
      resetHistory(chatId);
      await tgSendMessage(chatId, "Prontinho 😌 apaguei nossa conversa por aqui.");
      return;
    }

    if (!text) return;

    await tgSendTyping(chatId);

    // guarda mensagem do usuário
    pushToHistory(chatId, "user", text);

    // se não tiver OpenAI Key, ainda responde
    if (!OPENAI_API_KEY) {
      const fallback =
        "Tô aqui 😏 mas ainda não conectei minha IA direitinho. Me chama daqui a pouco, tá?";
      pushToHistory(chatId, "assistant", fallback);
      await tgSendMessage(chatId, fallback);
      return;
    }

    let reply = "";
    try {
      reply = await askOpenAI(chatId, text);
    } catch (err) {
      console.error("❌ Erro OpenAI:", err?.message || err);
      reply = "Hmm… hoje eu tô meio teimosa 😏 tenta de novo em um minutinho.";
    }

    reply = clampReply(reply);

    // guarda resposta do bot
    pushToHistory(chatId, "assistant", reply);

    await tgSendMessage(chatId, reply);
  } catch (err) {
    console.error("❌ Erro no webhook:", err?.message || err);
  }
});

// =====================
// Listen
// =====================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("🚀 Bot rodando na porta", PORT));
