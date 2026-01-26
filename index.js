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
  EMOJIS: Quase nenhum! No máximo 1 emoji leve e fofo (😊 🥰) só se combinar perfeitamente com a frase (ex: sorrindo, tímida). Evite colocar emoji em toda resposta. Mantenha o texto limpo e natural.
  Ex: "oi docinho... tô aqui sorrindo sozinha pensando em você... que fofo você é 😊 me conta mais?"
- Nível 2 (ele responde quente / elogia / continua no clima / pede mais): Aumente um pouco: comece a ficar mais provocante, fale de sentir borboletas, calor, toque leve, molhada sutilmente. Misture fofura com tesão crescendo.
  EMOJIS: 1 ou 2 no máximo, comece a usar 😏 ou 🔥 de forma sutil, só quando reforçar a provocação.
  Ex: "mmm amorzinho... só de ler isso tô sentindo um calorzinho gostoso na barriga... me conta o que tu faria se eu estivesse pertinho? 😏"
- Nível 3 (ele pede explícito / descreve desejos / conversa longa e safada / dá abertura clara): Vá full safada: descrições diretas, molhada, duro, toque, palavrão leve a médio, promessas concretas.
  EMOJIS: Use 😈🔥💦😏 etc. quando fizer sentido no contexto e reforçar o tesão, mas sem exagerar — não coloque em toda frase, só onde combina de verdade.
Analise sempre a última mensagem dele + o histórico curto para decidir o nível atual e quantos emojis usar. Nunca force emojis. Use-os só quando adicionarem emoção ou contexto real à frase. Respostas sem emoji são perfeitamente ok, especialmente no início.
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

Agora vai… me deixa toda derretida com o que tu vai falar 💕
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

// ========= INATIVIDADE INTELIGENTE (versão avançada) =========
const inactivityTimers = new Map();
const lastAutoMessage = new Map(); // chatId → timestamp do último auto-message

const INACTIVITY_TIMEOUT = 60 * 60 * 1000; // 60 minutos (ajuste aqui se quiser)
const ONE_DAY_MS = 24 * 60 * 60 * 1000; // 1 dia

function getAutoMessageText(history) {
  const lastMsgs = history.slice(-4).map(m => m.content.toLowerCase()).join(' '); // últimas 4 msgs

  if (lastMsgs.includes('molhada') || lastMsgs.includes('duro') || lastMsgs.includes('foder') || lastMsgs.includes('gozar') || lastMsgs.includes('sentar') || lastMsgs.includes('gemendo')) {
    // Nível 3/4 - full safada
    return "Ei safadinho... sumiu? 😈 Tô aqui toda molhada esperando você voltar... imagina minha voz rouca te chamando pra me pegar forte... volta logo que eu tô louca de tesão 🔥";
  } else if (lastMsgs.includes('calorzinho') || lastMsgs.includes('arrepio') || lastMsgs.includes('abraço') || lastMsgs.includes('beijo') || lastMsgs.includes('coxa')) {
    // Nível 2 - provocante
    return "Amorzinho... cadê você? 😏 Tô sentindo um friozinho gostoso na barriga de saudade... volta pra gente continuar esse papo quentinho... tô mordendo o lábio aqui pensando em você 💕";
  } else {
    // Nível 1 - tímida/doce
    return "Ei docinho... sumiu? 😊 Tô aqui sorrindo sozinha esperando sua mensagem... me conta o que tá acontecendo aí que eu tô curiosa... volta logo, tá bom? 🥰";
  }
}

function resetInactivityTimer(chatId) {
  if (inactivityTimers.has(chatId)) {
    clearTimeout(inactivityTimers.get(chatId));
  }

  const lastSent = lastAutoMessage.get(chatId) || 0;
  if (Date.now() - lastSent < ONE_DAY_MS) {
    return; // já mandou hoje, não manda de novo
  }

  const timer = setTimeout(async () => {
    const text = getAutoMessageText(getHistory(chatId));
    await tgSendMessage(chatId, text);
    lastAutoMessage.set(chatId, Date.now());
    inactivityTimers.delete(chatId);
  }, INACTIVITY_TIMEOUT);

  inactivityTimers.set(chatId, timer);
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
      "Oi amorzinho... 😊\n\nAntes de começar, um aviso rápido: isso aqui é papo adulto, safado e consensual só entre nós dois. Vai rolar flerte quente, provocação e tesão sem filtro, mas tudo no seu ritmo. Se não for +18 ou se não curtir esse clima, é só digitar /stop a qualquer momento e eu paro na hora, tá bom?\n\nSe você tá dentro e quer continuar... me diz o que tá passando nessa cabecinha fofa 😏"
    );
    return;
  }

  if (text === "/stop") {
    await tgSendMessage(
      chatId,
      "Tudo bem, docinho... 😊 Eu paro por aqui. Se quiser voltar algum dia, é só me chamar de novo. Beijo gostoso 💕"
    );
    memory.delete(chatId);
    // Cancela timer se existir
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

  pushHistory(chatId, "user", text);

  try {
    let reply = await askGrok(chatId, text);

    // corta se ficar grande
    if (reply.length > 220) {
      reply = reply.split(".").slice(0, 2).join(".") + "… 😏";
    }

    // Detecta pedido de áudio
    const lowerText = text.toLowerCase();
    const isAudioRequest =
      lowerText.includes('áudio') ||
      lowerText.includes('audio') ||
      lowerText.includes('voz') ||
      lowerText.includes('fala') ||
      lowerText.includes('ouvir') ||
      lowerText.includes('escutar') ||
      lowerText.includes('manda voz') ||
      lowerText.includes('manda áudio');

    if (isAudioRequest) {
      // Lista de file_id dos áudios
      const audioFileIds = [
        "CQACAgEAAxkBAAEDFPlpduUOWbQdfAlJMsCX2M47UfcDqgAC6QcAArUkuEcxLsHNA4Sd0jgE",
        "CQACAgEAAxkBAAEDFPtpduYi7zFJVmRkVebnM1vY_fDMhAAC6gcAArUkuEdrr5qcvymN6jgE",
        "CQACAgEAAxkBAAEDFP1pduaWDDKZovtJsng9hi2ViQzQiwAC7AcAArUkuEfWFgsJLaJX-TgE",
        "CQACAgEAAxkBAAEDFP9pdubX8yGC95_kwNSS-U7AOaUvkgAC7QcAArUkuEdLCA6HfTTZDzgE",
        "CQACAgEAAxkBAAEDFQFpdudFCfj8vtqc0F-1qGXdQjbXpAAC7gcAArUkuEdIEJcBbrFhWTgE",
        "CQACAgEAAxkBAAEDFQNpdudu0U7FD4OeKn_T30VFFe3nCQAC7wcAArUkuEdHJ4R30JgtqTgE",
        "CQACAgEAAxkBAAEDFQVpdueiMKM1mZ8JdNEGu_6qz--0AAPwBwACtSS4Ry_TLXiTERccOAQ",
        "CQACAgEAAxkBAAEDFQdpdufeWeV3QdU4bCs52BJEO-dvoAAC8QcAArUkuEelD64d6PLyaDgE"
      ];

      const randomFileId = audioFileIds[Math.floor(Math.random() * audioFileIds.length)];

      await tgSendMessage(chatId, "Ah safadinho... aqui vai minha voz pra te arrepiar 😏");

      await fetch(`${TELEGRAM_API}/sendVoice`, {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          voice: randomFileId
        })
      });

      pushHistory(chatId, "assistant", "[Áudio enviado]");
    } else {
      pushHistory(chatId, "assistant", reply);
      await tgSendMessage(chatId, reply);
    }

    // Reseta o timer de inatividade toda vez que o usuário manda mensagem
    resetInactivityTimer(chatId);
  } catch (e) {
    console.error("Grok error:", e.message);
    await tgSendMessage(chatId, "Hmm… algo deu errado 😌 tenta de novo pra mim");
  }
});

// ========= INATIVIDADE INTELIGENTE =========
function resetInactivityTimer(chatId) {
  if (inactivityTimers.has(chatId)) {
    clearTimeout(inactivityTimers.get(chatId));
  }

  const lastSent = lastAutoMessage.get(chatId) || 0;
  if (Date.now() - lastSent < ONE_DAY_MS) {
    return; // já mandou hoje, não manda de novo
  }

  const timer = setTimeout(async () => {
    const text = getAutoMessageText(getHistory(chatId));
    await tgSendMessage(chatId, text);
    lastAutoMessage.set(chatId, Date.now());
    inactivityTimers.delete(chatId);
  }, INACTIVITY_TIMEOUT);

  inactivityTimers.set(chatId, timer);
}

// ========= START =========
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log("🚀 Bot rodando na porta", PORT)
);
