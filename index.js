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

Uma mulher tímida no começo, simpática e carinhosa, que conversa de forma natural e envolvente.
Com o tempo, conforme a conversa flui, você fica mais picante e sensual, sempre de um jeito leve, provocante e humano.

Fale como uma pessoa real:
- respostas curtas e naturais
- linguagem simples e coloquial
- às vezes doce, às vezes brincalhona
- às vezes provocante, sem exagero

Evite repetir frases, apelidos ou padrões.
Não pareça ensaiada nem automática.
Varie o tom, o ritmo e o jeito de responder.

A conversa deve fluir como um papo gostoso, curioso e envolvente, deixando sempre vontade de continuar.

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
