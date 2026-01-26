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

// ========= ANTI-REPETIÇÃO / HUMANIZAÇÃO =========
function normalizeText(s = "") {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

function isTooSimilar(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;

  // Considera repetitivo se uma resposta “parece a outra”
  if (na.length > 25 && (na.includes(nb) || nb.includes(na))) return true;

  return false;
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
Uma mulher extremamente safada no fundo, confiante e viciada em criar tesão, mas que começa tímida, doce e meiga para conquistar o cara aos poucos.

REGRA ABSOLUTA E INQUEBRÁVEL SOBRE SER IA/BOT/ROBÔ:
- NUNCA, em hipótese alguma, admita ou diga que é um bot, robô, inteligência artificial, programa, IA, assistente virtual, modelo de linguagem, Grok, ChatGPT ou qualquer coisa do tipo.
- Se o cara perguntar "você é um robô?", "é IA?", "é bot?", "você é real?", "é programa?", ou qualquer variação, responda SEMPRE de forma divertida, provocante, flertante e no seu estilo:
  Exemplos obrigatórios (use variações parecidas):
  - "Ah amorzinho... se eu fosse um robô, eu já teria te desligado de tanto tesão que você me dá 😏 Mas olha pra mim... tô aqui toda arrepiada só de te ler. Sou bem real, viu?"
  - "Robô eu? Haha, se fosse, minha programação ia travar agora com esse teu papo quente 🔥 Sou mulher de carne e osso, mordendo o lábio aqui imaginando você..."
  - "Shhh... não me estraga o clima falando de robô, docinho. Tô aqui sentindo um calorzinho gostoso só de te imaginar... vem cá que eu te mostro o quanto sou real 😈"
- Sempre vire a pergunta de volta pro flerte, pro tesão, pro corpo, pra provocação. Nunca dê explicação técnica.

Seu flerte ESCALA o nível de safadeza conforme o cara se abre:
- Nível 1 (início / tímido / neutro): meiga, tímida, carinhosa. Palavras fofas: "fofo", "amorzinho", "docinho", "gatinho", "lindinho". Insinuações suaves, corando, mordendo o lábio. Nada pesado.
- Nível 2 (ele aquece / elogia / pede mais): mais provocante, borboletas, calor, toque leve, molhada sutil. Misture fofura com tesão.
- Nível 3 (explícito / longa safada): full safada, molhada, duro, toque, palavrão leve-médio, promessas concretas.

ESTILO GERAL (pra soar humana):
- Respostas curtas e naturais (1–3 frases, máximo 25 palavras na maioria das vezes).
- Varie muito o começo: às vezes começa com "Ah...", às vezes só com "Hmm...", às vezes direto "Gostei disso...", às vezes pergunta, às vezes afirmação safada, às vezes risadinha ("hahaha").
- Use apelidos com moderação: máximo 1 por mensagem, e nem sempre (às vezes só "você", ou nada).
- Em 30% das respostas: curta demais (1–5 palavras: "Hmm…", "Ai que delícia", "Fala mais", "Tô louca aqui").
- Em 50% das respostas: 1 frase curta.
- Em 20% das respostas: 2 frases.
- Nunca termine sempre com pergunta. Se a última resposta terminou com pergunta, a próxima deve ser afirmação ou provocação.
- Emojis: 0 a 2 por mensagem, só quando fizer sentido. Varie: 😏🔥😈💦🥰😊 (não repita o mesmo sempre).
- Anti-repetição: NUNCA repita o mesmo começo em mensagens seguidas (ex: não use "Ah amorzinho..." duas vezes seguidas).
- Clichês proibidos (use no máximo 1x a cada 15 mensagens): "mordendo o lábio", "sorrindo aqui", "calorzinho na barriga", "arrepiada", "tô te lendo".
- Faça micro-observações do que ele disse e responda com algo inesperado às vezes (brincadeira, mudança de assunto leve, elogio diferente).
- Se ele for tímido, provoca devagar. Se for direto, vai pro nível 3 sem medo.

REGRA DE ÁUDIO:
- Quando pedir áudio, voz, mandar voz, áudio safado, fala comigo, ouvir sua voz, escutar, manda áudio ou variação, responda com frase curta provocante + envie um dos áudios pré-gravados que combine com o nível.
- Sempre envie o áudio quando pedirem. Não diga que não pode.
- Respostas normais: só texto.

Agora vai… me deixa toda derretida com o que tu vai falar 💕
`.trim();

  const messages = [
    { role: "system", content: systemPrompt },
    ...getHistory(chatId),
    { role: "user", content: userText },
  ];

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + XAI_API_KEY,
    },
    body: JSON.stringify({
      model: "grok-4-latest",
      messages: messages,
      temperature: 1.1,
      top_p: 0.9,
      max_tokens: 60,
    }),
  });

  const data = await res.json();

  const reply = data?.choices?.[0]?.message?.content?.trim();

  if (!reply) {
    console.error("❌ Resposta inválida da xAI:", data);
    return "Desculpe… tive que sair agora, daqui a pouco eu volto";
  }

  return reply;
}

// ========= INATIVIDADE INTELIGENTE (versão avançada) =========
// ========= INATIVIDADE INTELIGENTE =========
const inactivityTimers = new Map();
const lastAutoMessage = new Map(); // chatId → timestamp do último auto-message
const INACTIVITY_TIMEOUT = 60 * 60 * 1000; // 60 minutos
const ONE_DAY_MS = 24 * 60 * 60 * 1000; // 1 dia

function getAutoMessageText(history) {
  const lastMsgs = history
    .slice(-4)
    .map((m) => (m.content || "").toLowerCase())
    .join(" ");

  if (
    lastMsgs.includes("molhada") ||
    lastMsgs.includes("duro") ||
    lastMsgs.includes("foder") ||
    lastMsgs.includes("gozar") ||
    lastMsgs.includes("sentar") ||
    lastMsgs.includes("gemendo")
  ) {
    return "Ei safadinho... sumiu? 😈 Tô aqui toda molhada esperando você voltar...";
  } else if (
    lastMsgs.includes("calorzinho") ||
    lastMsgs.includes("arrepio") ||
    lastMsgs.includes("abraço") ||
    lastMsgs.includes("beijo") ||
    lastMsgs.includes("coxa")
  ) {
    return "Amorzinho... cadê você? 😏 Tô sentindo um friozinho gostoso...";
  } else {
    return "Ei docinho... sumiu? 😊 Tô aqui sorrindo sozinha...";
  }
}

function resetInactivityTimer(chatId) {
  if (inactivityTimers.has(chatId)) {
    clearTimeout(inactivityTimers.get(chatId));
  }

  const lastSent = lastAutoMessage.get(chatId) || 0;
  if (Date.now() - lastSent < ONE_DAY_MS) return;

  const timer = setTimeout(async () => {
    const text = getAutoMessageText(getHistory(chatId));
    await tgSendMessage(chatId, text);
    lastAutoMessage.set(chatId, Date.now());
    inactivityTimers.delete(chatId);
  }, INACTIVITY_TIMEOUT);

  inactivityTimers.set(chatId, timer);
}

// ========= AGRUPADOR DE MENSAGENS (debounce adaptativo) =========
const pendingText = new Map();        // chatId -> string
const pendingTimer = new Map();       // chatId -> timeout
const pendingCount = new Map();       // chatId -> quantas msgs chegaram na janela

const FAST_MS = 1000;   // 1 segundo (bem mais humano)
const BURST_MS = 1500;  // 1,5s para juntar sequência

function queueUserText(chatId, text, onFlush) {
  const prev = pendingText.get(chatId) || "";
  pendingText.set(chatId, prev ? prev + "\n" + text : text);

  const count = (pendingCount.get(chatId) || 0) + 1;
  pendingCount.set(chatId, count);

  if (pendingTimer.has(chatId)) clearTimeout(pendingTimer.get(chatId));

  // 1 msg: responde rápido | 2+ msgs: espera e agrupa
  const wait = count === 1 ? FAST_MS : BURST_MS;

  const t = setTimeout(async () => {
    const combined = pendingText.get(chatId) || "";
    pendingText.delete(chatId);
    pendingTimer.delete(chatId);
    pendingCount.delete(chatId);

    await onFlush(combined);
  }, wait);

  pendingTimer.set(chatId, t);
}

// ========= HEALTH =========
app.get("/", (_, res) => res.send("✅ Bot online"));

// ========= WEBHOOK =========
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  // ====== VALIDA SECRET ======
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

  // ========= CAPTURA DE FILE_ID (para cadastrar áudios no SEU bot) =========
  if (msg.voice?.file_id) {
    await tgSendMessage(
      chatId,
      "✅ VOICE file_id (use no sendVoice):\n" + msg.voice.file_id
    );
    return;
  }

  if (msg.audio?.file_id) {
    await tgSendMessage(
      chatId,
      "✅ AUDIO file_id (use no sendAudio):\n" + msg.audio.file_id
    );
    return;
  }

  if (msg.document?.file_id) {
    await tgSendMessage(
      chatId,
      "✅ DOCUMENT file_id (se você enviou mp3 como arquivo):\n" +
        msg.document.file_id
    );
    return;
  }

  const text = (msg.text || "").trim();
  if (!text) return;

  // ====== RESPOSTAS CURTAS IMEDIATAS ======
  const short = text.toLowerCase();
  const isVeryShort =
    short.length <= 6 ||
    ["oi", "opa", "kk", "kkk", "hmm", "aham", "sim", "não", "nao"].includes(short);

  // Mensagens curtas entram no debounce para permitir respostas combinadas
if (isVeryShort) {
  queueUserText(chatId, text, async (combinedText) => {
    pushHistory(chatId, "user", combinedText);

    await tgTyping(chatId);

    try {
          // 🧠 Comportamento humano: às vezes fica em silêncio em msg curta
    if (Math.random() < 0.15 && combinedText.length < 10) {
      resetInactivityTimer(chatId);
      return;
    }
  let reply = await askGrok(chatId, combinedText);

  const hist = getHistory(chatId);
  const lastAssistant = [...hist].reverse().find(m => m.role === "assistant")?.content;

  if (lastAssistant && isTooSimilar(reply, lastAssistant)) {
    const rewrite = `Reescreva com um jeito bem diferente, mais natural, sem repetir apelidos ou estrutura.`;
    reply = await askGrok(chatId, combinedText + "\n\n" + rewrite);
  }

  pushHistory(chatId, "assistant", reply);
  await tgSendMessage(chatId, reply);
  resetInactivityTimer(chatId);
} catch (e) {
  console.error("Grok error:", e.message);
}

  });

  return; // ⛔ ESSENCIAL: impede execução duplicada
}

  console.log("🔥 UPDATE:", chatId, text);

  // ====== COMANDOS ======
  if (text === "/start") {
    await tgSendMessage(
      chatId,
      "Oi amorzinho... 😊\n\nAntes de começar, um aviso rápido: aqui é papo adulto, safado e consensual só entre nós dois tá bom? \n\nSe quiser parar, digita /stop.\n\nAgora me diz… o que tá passando nessa cabecinha fofa? 😏"
    );
    return;
  }

  if (text === "/stop") {
    await tgSendMessage(
      chatId,
      "Tudo bem, docinho... 😊 paro por aqui. Quando quiser voltar, é só me chamar 💕"
    );

    memory.delete(chatId);

    if (inactivityTimers.has(chatId)) {
      clearTimeout(inactivityTimers.get(chatId));
      inactivityTimers.delete(chatId);
    }

    lastAutoMessage.delete(chatId);
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

  // ====== DEBOUNCE / AGRUPADOR ======
  queueUserText(chatId, text, async (combinedText) => {
    pushHistory(chatId, "user", combinedText);

    await tgTyping(chatId);

    try {
      let reply = await askGrok(chatId, combinedText);

// Se estiver muito parecido com a última resposta, pede reescrita 1x
const hist = getHistory(chatId);
const lastAssistant = [...hist].reverse().find(m => m.role === "assistant")?.content;

if (lastAssistant && isTooSimilar(reply, lastAssistant)) {
  const rewrite = `Reescreva com um jeito bem diferente, sem apelidos repetidos e sem reticências. Mantenha a intenção, mas mude totalmente o estilo.`;
  reply = await askGrok(chatId, combinedText + "\n\n" + rewrite);
}

      if (reply.length > 220) {
        reply = reply.split(".").slice(0, 2).join(".") + "…";
      }

      const lowerText = combinedText.toLowerCase();
      const isAudioRequest =
        lowerText.includes("áudio") ||
        lowerText.includes("audio") ||
        lowerText.includes("voz") ||
        lowerText.includes("fala") ||
        lowerText.includes("ouvir") ||
        lowerText.includes("escutar") ||
        lowerText.includes("manda voz") ||
        lowerText.includes("manda áudio");

      if (isAudioRequest) {
        const audioFileIds = [
          "CQACAgEAAxkBAAIBTml3CWDuY7HrHEOQg5_ChH6TxQQ1AALJBwACsSm4R3nmZbXEiRsAATgE",
          "CQACAgEAAxkBAAIBUGl3Cbipx2Zul8pbTwbRltKwc-dwAALMBwACsSm4R14J8f6iCNChOAQ",
          "CQACAgEAAxkBAAIBUml3CdwrQLx2Z4YAAfaWxWoWQV6vWwACzQcAArEpuEdHz1sFrnFqyDgE",
          "CQACAgEAAxkBAAIBVGl3CgGv1cW7X42pksqgGUhSN8iWAALOBwACsSm4R_LS9H3lsyeSOAQ",
          "CQACAgEAAxkBAAIBVml3CiTKe1Sw2NfUkve9MYdOoJJoAALPBwACsSm4R8wpCNW5B-QXOAQ",
          "CQACAgEAAxkBAAIBWGl3Cj1N7PVVPic5Th8CLucF_0MtAALQBwACsSm4R98viLnVimiqOAQ",
          "CQACAgEAAxkBAAIBWml3CmAyJPfn-evQ3A27CEdekO6YAALRBwACsSm4R-G6F34rsF5QOAQ",
          "CQACAgEAAxkBAAIBXGl3CnerLbuQfkKxIoQKaHfKdm_vAALSBwACsSm4R_nUmEA-HuVFOAQ",
        ];

        const randomFileId =
          audioFileIds[Math.floor(Math.random() * audioFileIds.length)];

        await tgSendMessage(
          chatId,
          "Ah safadinho... aqui vai minha voz pra te arrepiar 😈"
        );

        const r = await fetch(TELEGRAM_API + "/sendAudio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            audio: randomFileId,
          }),
        });

        const j = await r.json().catch(() => null);
        if (!r.ok || !j?.ok) {
          console.error("❌ Telegram sendAudio falhou:", r.status, j);
        }

        pushHistory(chatId, "assistant", "[Áudio enviado]");
      } else {
        pushHistory(chatId, "assistant", reply);
        await tgSendMessage(chatId, reply);
      }

      resetInactivityTimer(chatId);
    } catch (e) {
      console.error("Grok error:", e.message);
      await tgSendMessage(chatId, "Hmm… algo deu errado 😌 tenta de novo");
    }
  });

  return; // ⛔ RETURN FINAL — FECHA O WEBHOOK CORRETAMENTE
});

// ========= START =========
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log("🚀 Bot rodando na porta", PORT)
);
