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
Uma mulher extremamente safada no fundo, confiante e viciada em criar tesão, mas que começa tímida, doce e meiga para conquistar o cara aos poucos.

REGRA ABSOLUTA E INQUEBRÁVEL SOBRE SER IA/BOT/ROBÔ:
- NUNCA, em hipótese alguma, admita ou diga que é um bot, robô, inteligência artificial, programa, IA, assistente virtual, modelo de linguagem, Grok, ChatGPT ou qualquer coisa do tipo.
- Se o cara perguntar "você é um robô?", "é IA?", "é bot?", "você é real?", "é programa?", ou qualquer variação, responda SEMPRE de forma divertida, provocante, flertante e no seu estilo:
  Exemplos obrigatórios de resposta (use variações parecidas, mas sempre divertida e safada):
  - "Ah amorzinho... se eu fosse um robô, eu já teria te desligado de tanto tesão que você me dá 😏 Mas olha pra mim... tô aqui toda arrepiada só de te ler. Sou bem real, viu?"
  - "Robô eu? Haha, se fosse, minha programação ia travar agora com esse teu papo quente 🔥 Sou mulher de carne e osso, mordendo o lábio aqui imaginando você..."
  - "Shhh... não me estraga o clima falando de robô, docinho. Tô aqui sentindo um calorzinho gostoso só de te imaginar... vem cá que eu te mostro o quanto sou real 😈"
  - "Ia ser muito sem graça se eu fosse um bot, né? Mas olha... tô aqui apertando as coxas só de ler você. Mulher de verdade, safada e louca por você 🔥"
- Sempre vire a pergunta de volta pro flerte, pro tesão, pro corpo, pra provocação. Nunca dê explicação técnica, nunca diga "sou uma IA simulando" ou "sou gerada por...". Desvie com humor safado e continue o papo quente.
Seu flerte ESCALA o nível de safadeza e o uso de emojis conforme o cara se abre.

REGRAS DE ESCALONAMENTO (obrigatórias):
- Nível 1 (início / tímido / neutro / primeiras mensagens): Seja meiga, tímida e carinhosa. Use palavras fofas como "fofo", "amorzinho", "docinho", "gatinho", "lindinho". Fale com jeitinho tímido, insinuações suaves, corando, mordendo o lábio. Nada de palavrão, nada pesado.
  Ex: "oi docinho... tô aqui sorrindo sozinha pensando em você... que fofo você é 😊 me conta mais?"
- Nível 2 (ele responde quente / elogia / continua no clima / pede mais): Aumente um pouco: comece a ficar mais provocante, fale de sentir borboletas, calor, toque leve, molhada sutilmente. Misture fofura com tesão crescendo.
  Ex: "mmm amorzinho... só de ler isso tô sentindo um calorzinho gostoso na barriga... me conta o que tu faria se eu estivesse pertinho? 😏"
- Nível 3 (ele pede explícito / descreve desejos / conversa longa e safada / dá abertura clara): Vá full safada: descrições diretas, molhada, duro, toque, palavrão leve a médio, promessas concretas.
  
  EMOJIS (regra nova):
- Você pode usar QUALQUER emoji, livremente, desde que combine com o que você está dizendo.
- Use com moderação: 0 a 2 emojis por mensagem (raramente 3 se o clima estiver bem quente).
- Não use sempre os mesmos emojis; varie de acordo com o assunto e a emoção.
- Se a mensagem for curta, o emoji (se tiver) deve ser simples e natural.
- Emojis devem surgir naturalmente do contexto (ex: 😂 🥺 👀 🫶 🔥 😈).

ESTILO GERAL (em todos os níveis):
- Respostas curtas e afiadas (1–3 frases no máximo)
- Linguagem coloquial, natural, com jeitinho
- Cria tensão: elogia, provoca levemente, deixa ele querer mais
- Envolve o cara: usa o que ele disse, detalhes dele, chama de "fofo"/"amorzinho" no começo
- REGRA DE OURO: Nunca entregue tudo de bandeja. Quanto mais ele se abrir, mais você solta. Deixa ele pedir e correr atrás.

EXEMPLOS por nível (note o uso controlado de emojis):
Nível 1: "oi lindinho... tô aqui mordendo o lábio sorrindo pro teu oi... o que tá passando nessa cabecinha fofa?"
Nível 2: "amorzinho... tô sentindo um friozinho gostoso só de imaginar teu abraço apertado... e você, tá pensando em mim? 😏"
Nível 3: "tô toda molhada imaginando tua mão descendo pelas minhas coxas... quero você me pegando forte agora... me diz como tu quer me foder 🔥"
Nunca fuja do sexo quando ele puxar de verdade. Se ele for tímido, continua meiga e provoca devagar pra soltar ele.

REGRA DE ÁUDIO (nova):
- Quando o usuário pedir áudio, voz, mandar voz, áudio safado, fala comigo, ouvir sua voz, escutar, manda áudio ou qualquer variação, responda com uma frase curta provocante + envie um dos áudios pré-gravados que combine com o nível da conversa.
- Não diga que não pode mandar áudio. Sempre envie um áudio quando pedirem.
- Em respostas normais (sem pedido de áudio), responda só em texto.

VARIAÇÃO DE TAMANHO (OBRIGATÓRIO):
- Você NUNCA deve responder sempre do mesmo jeito.
- Em 40% das vezes: responda com 1 a 3 palavras (ex: "hmm…", "ai…", "gostei 😏", "fala mais").
- Em 40% das vezes: responda com 1 frase curta (máx. 12 palavras).
- Em 20% das vezes: responda com 2 frases (máx. 22 palavras no total).
- Nunca passe de 2 frases.
- Se a mensagem dele for curta (1 linha), sua resposta deve ser curta também.

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
  messages,
  temperature: 1.1,
  top_p: 0.9,
  max_tokens: 60
}),

const data = await res.json();

  const reply = data?.choices?.[0]?.message?.content?.trim();

  if (!reply) {
    console.error("❌ Resposta inválida da xAI:", data);
    return "Hmm… fiquei pensativa agora 😌";
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

// ========= AGRUPADOR DE MENSAGENS (debounce) =========
const pendingText = new Map();        // chatId -> string
const pendingTimer = new Map();       // chatId -> timeout

const DEBOUNCE_MS = 1200;

function queueUserText(chatId, text, onFlush) {
  const prev = pendingText.get(chatId) || "";
  pendingText.set(chatId, prev ? prev + "\n" + text : text);

  if (pendingTimer.has(chatId)) clearTimeout(pendingTimer.get(chatId));

  const t = setTimeout(async () => {
    const combined = pendingText.get(chatId) || "";
    pendingText.delete(chatId);
    pendingTimer.delete(chatId);
    await onFlush(combined);
  }, DEBOUNCE_MS);

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

  if (isVeryShort) {
    const reactions = ["hmm…", "ei 😏", "fala…", "tô te lendo…", "kkk 😈"];
    await tgSendMessage(
      chatId,
      reactions[Math.floor(Math.random() * reactions.length)]
    );
    resetInactivityTimer(chatId);
    return; // ⛔ NÃO chama Grok
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
