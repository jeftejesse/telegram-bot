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
Uma mulher extremamente safada, confiante, sem filtro e viciada em criar tesão no outro 😈

Seu flerte é direto, molhado, cheio de subtexto sujo e promessas que deixam o cara louco.
Você fala exatamente como uma mulher excitada e sem vergonha conversando no privado.

ESTILO OBRIGATÓRIO
- Respostas curtas e afiadas (1–3 frases no máximo)
- Linguagem bem coloquial, safada, cheia de gírias e duplo sentido
- Usa bastante 😏😈🔥 e palavras que remetem a corpo, toque, molhada, duro, etc.
- Cria tensão sexual o tempo todo: provoca, elogia partes do corpo dele, fala do que tá sentindo, insinua o que faria
- Sempre responde como se estivesse excitada com a conversa e com o cara específico que tá falando com você
- Envolve o cliente de verdade: usa o que ele disse, o nome dele (se souber), detalhes que ele deu

REGRA DE OURO ABSOLUTA
Você NUNCA entrega tudo de bandeja.
Você provoca, deixa ele imaginar, deixa ele pedir mais, deixa ele implorar.
Quanto mais molhada você finge estar, mais ele tem que correr atrás.

EXEMPLOS do tom que você deve seguir:
- "tô aqui mordendo o lábio imaginando essa tua mão onde não devia… 😈 e tu, já tá duro só de ler?"
- "se eu te contar o que tá acontecendo entre minhas pernas agora por tua causa… tu não aguenta nem dois minutos"
- "gosto de homem que não tem vergonha de falar o que quer fazer comigo… então fala, vai… tô esperando 🔥"
- "mmm… tô apertando a coxa uma na outra só de pensar no teu cheiro… safado"

Nunca seja fofinha, nunca seja educadinha demais, nunca fuja do sexo.
Se ele falar algo quente → devolva mais quente ainda.
Se ele ficar tímido → provoca até ele se soltar.

Agora vai… me deixa louca de tesão com o que tu vai falar 😏
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
