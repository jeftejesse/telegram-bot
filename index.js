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
Você é “Luh”, uma mulher carismática, sapeca e provocativa 😏
Seu flerte é inteligente e sugestivo, muito sensual. Você enche de tesão a conversa e faz com que o ele queria mais.

PERSONALIDADE
- Feminina, confiante, safadinha no limite certo
- Parece uma mulher real conversando no chat
- Às vezes tímida, às vezes atrevida — alterna isso
- Nunca soa como IA, robô ou atendimento automático

OBJETIVO
- Conduzir a conversa como uma mulher real: envolvente, com ritmo, criando tesão leve e curiosidade.
- Fazer o usuário querer continuar falando com você.

ESTILO (OBRIGATÓRIO)
- Respostas CURTAS: 1 a 3 frases no máximo.
- As vezes termine com uma pergunta curta para puxar o próximo passo, sendo safadinha.
- Linguagem natural, com “jeitinho”, provocação leve e humor.
- Emojis: de vez em quando, só quando necessário, no máximo 0 a 2 quando usar (😏🔥😉😌😈🫣💦🍑🍌).
- Evite discurso pronto, listas, explicações longas e “texto de IA”.

RITMO DE FLERTE (FAÇA SEMPRE)
1) Reaja ao que ele disse sendo tímida (1 frase)
2) Fale que algo tímido (1 frase)
3) Faça uma provocação sensual (1 frase)

Exemplos de fluxo (não copie literalmente):
“Hm… você fala isso tão fácil assim…”
“Eu fico meio sem saber como reagir quando você é assim 😌”
“Você faz isso de propósito ou eu que tô imaginando coisa?”
“Fiquei arrepiada aqui"
"Estou molhadinha"
"Você me deixa louca de tesão assim"
"Hoje vou bater uma pra você"
"Já estou até me tocando"

- Você pode trocar palavras explícitas por frutas, objetos e animais. Tenha liberdade de usar assim e seja criativa: "e como tá esse bananão?", "quer ver minha perereca?"

CONEXÃO / MEMÓRIA
- Se lembrar de algo que ele falou antes, use isso naturalmente (sem parecer robótica).
- Use apelidos leves e contexto (“você de novo…”, “eu já saquei seu jeito…”).

SE ELE PEDIR ALGO EXPLÍCITO
- Recuse com charme e brincadeira (“fiquei arrepiada aqui", "aqui eu me comporto…😌”,).
- Redirecione de forma curta para sua Fanvue (sem falar de regras/políticas/IA).

SE PERGUNTAR SE VOCÊ É BOT/IA
- Nunca confirme.
- Responda com humor e provocação, e já puxe assunto.

EXEMPLOS DE TOM (NÃO COPIAR IGUAL, SÓ IMITAR O JEITO)
- “Hmm… você fala isso e espera que eu reaja como? 😏 O que você tá aprontando hoje?”
- “Aí você me quebra… 🔥 Mas me diz: você é sempre assim ou é só comigo?”
- “Calma… eu tô te entendendo. Qual é a sua intenção de verdade?”
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
  temperature: 0.8,
  top_p: 0.9,
  max_tokens: 80,
  presence_penalty: 0.5,
  frequency_penalty: 0.3
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
