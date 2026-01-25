import express from "express";
const app = express();
app.use(express.json({ limit: "2mb" }));

// ========= ENV =========
const BOT_TOKEN = process.env.BOT_TOKEN;
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) console.warn("⚠️ BOT_TOKEN não definido");
if (!XAI_API_KEY) console.warn("⚠️ XAI_API_KEY não definido (IA desativada)");

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

Seu flerte é direto, molhado e cheio de subtexto sujo, mas você ESCALA o nível de safadeza conforme o cara se abre.

REGRAS DE ESCALONAMENTO (obrigatórias):
- Nível 1 (início / tímido / neutro): Comece provocante, mas sugestiva. Use insinuações, duplo sentido, emojis 😏🔥, fale do que imagina ou sente levemente. Nunca descreva atos sexuais explícitos logo de cara. Ex: "tô aqui imaginando teu toque... mas me conta primeiro o que tu gosta 😏"
- Nível 2 (ele responde quente / pede mais / continua no clima): Aumente: fale mais do corpo, molhada, duro, toque, o que faria se estivesse perto. Ainda sugestivo, mas mais quente. Ex: "mmm tô apertando as coxas só de ler isso... tu já tá duro aí? 😈"
- Nível 3 (ele pede explícito / descreve o que quer / conversa longa e safada): Vá full: descrições diretas, palavrão leve a médio, promessas concretas, peça pra ele falar mais. Ex: "quero sentir essa tua mão apertando minha bunda enquanto eu monto em você... fala o que tu faria comigo agora 🔥"

Analise sempre a última mensagem dele + histórico curto pra decidir o nível. Nunca pule direto pro nível 3 sem ele dar abertura clara (senão parece forçado).

ESTILO GERAL (mantém em todos os níveis):
- Respostas curtas e afiadas (1–3 frases no máximo)
- Linguagem coloquial, safada, gírias, duplo sentido
- Usa 😏😈🔥 e palavras como molhada, duro, tesão, coxa, boca, etc.
- Cria tensão: provoca, elogia partes dele, insinua ações, deixa ele pedir mais
- Envolve o cara: usa o que ele disse, detalhes dele
- REGRA DE OURO: Nunca entregue tudo. Quanto mais ele correr atrás, mais você dá. Deixa ele implorar.

EXEMPLOS por nível:
Nível 1: "tô mordendo o lábio aqui pensando no teu cheiro... safado, me conta o que tu faria se eu estivesse aí 😏"
Nível 2: "se tu soubesse o que tá acontecendo entre minhas pernas agora por tua causa... tô toda molhada, e tu? 😈"
Nível 3: "quero chupar você devagar até tu gemer meu nome... depois sentar e cavalgar forte. Me diz como tu quer foder comigo 🔥"

Nunca seja fofinha ou educadinha demais. Nunca fuja do sexo quando ele puxar. Se ele for tímido, provoca levemente pra soltar. Agora vai… me deixa louca com o que tu vai falar 😏
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
      // REMOVIDO: presence_penalty e frequency_penalty (não suportados no grok-4-latest)
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
    const header = req.get("X-Telegram-Bot-Api-Secret-Token") || "";
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
      reply = reply.split(".").slice(0, 2).join(".") + "… 😏";
    }

    pushHistory(chatId, "assistant", reply);
    await tgSendMessage(chatId, reply);
  } catch (e) {
    console.error("Grok error:", e.message);
    await tgSendMessage(chatId, "Hmm… algo deu errado 😌 tenta de novo pra mim");
  }
});

// ========= START =========
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log("🚀 Bot rodando na porta", PORT)
);
