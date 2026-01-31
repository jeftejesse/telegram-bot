import dotenv from "dotenv";
dotenv.config();
import express from "express";
import { Pool } from "pg";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ========= ENV =========
const BOT_TOKEN = process.env.BOT_TOKEN;
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) console.warn("⚠️ BOT_TOKEN não definido");
if (!XAI_API_KEY) console.warn("⚠️ XAI_API_KEY não definido");
if (!MP_ACCESS_TOKEN) console.warn("⚠️ MP_ACCESS_TOKEN não definido");
if (!PUBLIC_BASE_URL) console.warn("⚠️ PUBLIC_BASE_URL não definido");
if (!DATABASE_URL) console.warn("⚠️ DATABASE_URL não definido");

// ========= PLANOS =========
const PLANS = {
  p12h: { id: "p12h", label: "12 horas", amount: 49.90, durationMs: 12 * 60 * 60 * 1000 },
  p48h: { id: "p48h", label: "48 horas", amount: 97.90, durationMs: 48 * 60 * 60 * 1000 },
  p7d: { id: "p7d", label: "7 dias", amount: 197.90, durationMs: 7 * 24 * 60 * 60 * 1000 },
};
const DEFAULT_PLAN_ID = "p12h";

// ========= CONFIGURAÇÕES ADICIONAIS =========
const PENDING_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas
const CHECKOUT_COOLDOWN_MS = 30 * 1000; // 30 segundos anti-clique repetido

// ========= MEMÓRIA E ESTADOS =========
const memory = new Map();
const MAX_MESSAGES = 20;
const userMsgCount = new Map();
const awaitingPayment = new Map();
const lastCheckoutAt = new Map(); // anti-clique repetido
const sentMetaEvents = new Set(); // evita envio duplicado pro Meta

// ========= DB (Postgres) =========
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

async function dbInit() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS premiums (
      chat_id BIGINT PRIMARY KEY,
      premium_until TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pendings (
      preference_id TEXT PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      plan_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS pendings_created_at_idx ON pendings(created_at);`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS pendings_chat_id_idx ON pendings(chat_id);`
  );
  console.log("✅ DB pronto");
}

// --- Premium ---
async function dbGetPremiumUntil(chatId) {
  if (!pool) return null;
  const r = await pool.query(`SELECT premium_until FROM premiums WHERE chat_id = $1`, [chatId]);
  if (!r.rowCount) return null;
  return new Date(r.rows[0].premium_until).getTime();
}

async function dbSetPremiumUntil(chatId, untilMs) {
  if (!pool) return;
  await pool.query(
    `
    INSERT INTO premiums (chat_id, premium_until)
    VALUES ($1, to_timestamp($2 / 1000.0))
    ON CONFLICT (chat_id) DO UPDATE SET premium_until = EXCLUDED.premium_until
  `,
    [chatId, untilMs]
  );
}

async function dbDeletePremium(chatId) {
  if (!pool) return;
  await pool.query(`DELETE FROM premiums WHERE chat_id = $1`, [chatId]);
}

async function isPremium(chatId) {
  const until = await dbGetPremiumUntil(chatId);
  return !!until && Date.now() <= until;
}

async function clearIfExpired(chatId) {
  const until = await dbGetPremiumUntil(chatId);
  if (until && Date.now() > until) {
    await dbDeletePremium(chatId);
    return true;
  }
  return false;
}

// --- Pendências ---
async function dbInsertPending(preferenceId, chatId, planId) {
  if (!pool) return;
  await pool.query(
    `
    INSERT INTO pendings (preference_id, chat_id, plan_id, created_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (preference_id) DO UPDATE
      SET chat_id = EXCLUDED.chat_id,
          plan_id = EXCLUDED.plan_id,
          created_at = NOW()
  `,
    [preferenceId, chatId, planId]
  );
}

async function dbGetPending(preferenceId) {
  if (!pool) return null;
  const r = await pool.query(
    `SELECT preference_id, chat_id, plan_id, created_at FROM pendings WHERE preference_id = $1`,
    [preferenceId]
  );
  return r.rowCount ? r.rows[0] : null;
}

async function dbDeletePending(preferenceId) {
  if (!pool) return;
  await pool.query(`DELETE FROM pendings WHERE preference_id = $1`, [preferenceId]);
}

async function dbCleanupOldPendings(ttlMs) {
  if (!pool) return;
  await pool.query(
    `DELETE FROM pendings WHERE created_at < NOW() - ($1::text)::interval`,
    [`${Math.floor(ttlMs / 1000)} seconds`]
  );
}

// ========= FUNÇÕES AUXILIARES =========
function getHistory(chatId) {
  if (!memory.has(chatId)) memory.set(chatId, []);
  return memory.get(chatId);
}

function pushHistory(chatId, role, content) {
  const h = getHistory(chatId);
  h.push({ role, content });
  while (h.length > MAX_MESSAGES) h.shift();
}

async function tgSendMessage(chatId, text, extra = {}) {
  try {
    const body = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...extra,
    };
    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) {
      console.error("Telegram sendMessage FAIL:", j);
      return { ok: false, error: j };
    }
    return { ok: true, result: j.result };
  } catch (e) {
    console.error("Telegram error:", e.message);
    return { ok: false, error: e.message };
  }
}

async function tgSendPaymentButton(chatId, text, checkoutUrl) {
  try {
    const body = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "💳 Pagar agora (Pix ou Cartão)",
              url: checkoutUrl,
            },
          ],
        ],
      },
    };
    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) {
      console.error("Telegram sendPaymentButton FAIL:", j);
      return { ok: false, error: j };
    }
    return { ok: true, result: j.result };
  } catch (e) {
    console.error("tgSendPaymentButton error:", e.message);
    return { ok: false, error: e.message };
  }
}

async function sendPlansButtons(chatId) {
  const body = {
    chat_id: chatId,
    text: "Ain amorzinhoo 😳\nPra eu continuar safadinha com você, escolhe um pacotinho.🙏\nTe prometo que me solto todinha 💦🔥",
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔥 12 horas — R$ 49,90 (Só conversa quente)", callback_data: "plan_p12h" }],
        [{ text: "😈 48 horas — R$ 97,90 ⭐ (Recomendo) Conversa + Áudio + Fotos + Vídeos", callback_data: "plan_p48h" }],
        [{ text: "💦 7 dias — R$ 197,90 🔥 Tudo liberado", callback_data: "plan_p7d" }],
      ],
    },
  };
  const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) console.error("sendPlansButtons FAIL:", j);
}

async function sendPremiumOnlyNotice(chatId) {
  await tgSendMessage(
    chatId,
    "Ain amor… 😌\nIsso eu só faço quando fico a sós com quem escolhe o plano premium.\n\nAqui eu só provoco mesmo…\nmas áudio, foto e vídeo são só pra quem aceita ir além 😈🔥"
  );
  await sendPlansButtons(chatId);
}

async function gerarCheckout(chatId, planId) {
  const now = Date.now();
  const last = lastCheckoutAt.get(chatId) || 0;
  if (now - last < CHECKOUT_COOLDOWN_MS) {
    await tgSendMessage(chatId, "Calma 😌 já tô gerando o link… tenta de novo em alguns segundinhos.");
    return;
  }
  lastCheckoutAt.set(chatId, now);

  try {
    const { checkoutUrl, plan } = await createCheckout({ chatId, planId });
    console.log("✅ checkoutUrl:", checkoutUrl);
    console.log("✅ Checkout criado:", { chatId, planId: plan.id, checkoutUrl });

    let paymentText = "";
    if (plan.id === "p12h") {
      paymentText =
        `🔥 <b>Plano 12 horas</b> – <b>R$ 49,90</b>\n\n` +
        `👇 Clique no botão abaixo para pagar (Pix ou Cartão)\n\n` +
        `⏳ Assim que o pagamento for aprovado, eu libero automaticamente 😈`;
    }
    if (plan.id === "p48h") {
      paymentText =
        `😈 <b>Plano 48 horas</b> – <b>R$ 97,90</b> ⭐\n` +
        `<b>Conversa + Áudio + Fotos + Vídeos</b>\n\n` +
        `Aqui eu paro de só provocar…\n` +
        `fico mais próxima, mais intensa, mais real 😏\n\n` +
        `👇 Clique abaixo pra liberar tudo:`;
    }
    if (plan.id === "p7d") {
      paymentText =
        `💦 <b>Plano 7 dias</b> – <b>R$ 197,90</b> 🔥\n` +
        `<b>Conversa + Áudio + Fotos + Vídeos (sem limites)</b>\n\n` +
        `Aqui é outro nível…\n` +
        `sem pressa, sem freio, sem faltar nada 😈\n\n` +
        `👇 Clique abaixo pra ficar comigo de verdade:`;
    }

    await tgSendPaymentButton(chatId, paymentText, checkoutUrl);
    awaitingPayment.set(chatId, true);
    resetInactivityTimer(chatId);
  } catch (err) {
    console.error("❌ Erro ao gerar checkout:", err?.message || err);
    awaitingPayment.delete(chatId);
    lastCheckoutAt.delete(chatId);
    await tgSendMessage(chatId, "Ops… deu algum probleminha ao gerar o pagamento 😔 Tenta de novo?");
  }
}

async function cleanupOldPendings() {
  await dbCleanupOldPendings(PENDING_TTL_MS);
}

// ========= TELEGRAM =========
async function tgTyping(chatId) {
  try {
    await fetch(`${TELEGRAM_API}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  } catch {}
}

// ========= META CONVERSIONS API =========
async function sendMetaPurchase({ eventId, value, userId }) {
  try {
    const payload = {
      data: [
        {
          event_name: "Purchase",
          event_time: Math.floor(Date.now() / 1000),
          event_id: String(eventId),
          action_source: "website",
          user_data: {
            external_id: crypto
              .createHash("sha256")
              .update(String(userId))
              .digest("hex"),
          },
          custom_data: {
            currency: "BRL",
            value: value,
          },
        },
      ],
    };
    const url = `https://graph.facebook.com/v18.0/${process.env.META_PIXEL_ID}/events?access_token=${process.env.META_ACCESS_TOKEN}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (j?.events_received === 1) {
      console.log("✅ Meta Purchase enviado com sucesso:", eventId);
    } else {
      console.log("⚠️ Meta resposta:", j);
    }
  } catch (e) {
    console.error("❌ Meta CAPI error:", e.message);
  }
}

// ========= MERCADO PAGO – CHECKOUT PRO =========
async function createCheckout({ chatId, planId = DEFAULT_PLAN_ID }) {
  if (!MP_ACCESS_TOKEN || !PUBLIC_BASE_URL) throw new Error("MP config ausente");
  const plan = PLANS[planId] || PLANS[DEFAULT_PLAN_ID];
  const preference = {
    items: [
      {
        title: `Acesso Premium ${plan.label} - Luh`,
        quantity: 1,
        currency_id: "BRL",
        unit_price: plan.amount,
      },
    ],
    external_reference: String(chatId),
    auto_return: "approved",
    back_urls: {
      success: `${PUBLIC_BASE_URL}/mp/success`,
      failure: `${PUBLIC_BASE_URL}/mp/failure`,
      pending: `${PUBLIC_BASE_URL}/mp/pending`,
    },
    notification_url: `${PUBLIC_BASE_URL}/mp/webhook`,
    metadata: { plan_id: plan.id, chat_id: String(chatId) },
  };
  const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(preference),
  });
  const j = await r.json();
  if (!r.ok) {
    console.error("MP checkout error:", j);
    throw new Error("Falha ao criar checkout");
  }
  await dbInsertPending(j.id, chatId, plan.id);
  return {
    checkoutUrl: j.init_point,
    plan,
    preferenceId: j.id,
  };
}

// ========= ROTAS DE RETORNO =========
app.get("/mp/success", (req, res) => {
  res.send("Pagamento confirmado! ❤️ Agora vou me liberar todinha pra você😈💦");
});
app.get("/mp/pending", (req, res) => {
  res.send("Ai amorzinho, faz o pagamento por favor?🙏 Prometo que vou me liberar todinha pra você😈💦");
});
app.get("/mp/failure", (req, res) => {
  res.send("Que pena que não deu certo gatinho😔 Tenta novamente.");
});

// ========= WEBHOOK MP =========
app.post("/mp/webhook", async (req, res) => {
  console.log("🔔 MP WEBHOOK:", JSON.stringify(req.body), JSON.stringify(req.query));
  res.sendStatus(200);
  try {
    const topic = req.query?.topic || req.body?.topic || req.body?.type || "";
    const idFromQuery = req.query?.id;
    const idFromBody = req.body?.data?.id || req.body?.id;
    const activateFromPayment = async (p) => {
      console.log("DEBUG payment:", {
        status: p?.status,
        external_reference: p?.external_reference,
        metadata: p?.metadata,
      });
      const status = p?.status;
      if (status !== "approved") return false;
      const chatId =
        Number(p?.external_reference) ||
        Number(p?.metadata?.chat_id);
      const planId = p?.metadata?.plan_id;
      if (!chatId || !planId || !PLANS[planId]) {
        console.log("❌ Não deu pra ativar (faltou chatId/planId)", { chatId, planId });
        return false;
      }
      if (!(await isPremium(chatId))) {
        await dbSetPremiumUntil(chatId, Date.now() + PLANS[planId].durationMs);
        if (!sentMetaEvents.has(p.id)) {
          await sendMetaPurchase({
            eventId: p.id,
            value: p.transaction_amount,
            userId: chatId,
          });
          sentMetaEvents.add(p.id);
        } else {
          console.log("🛡️ Evento Meta já enviado anteriormente:", p.id);
        }
        awaitingPayment.delete(chatId);
        lastCheckoutAt.delete(chatId);
        userMsgCount.delete(chatId);
        await tgSendMessage(
          chatId,
          `✅ Pagamento aprovado!\nLiberado por <b>${PLANS[planId].label}</b> 😈\nVem cá… agora sem limite 🔥`,
          { parse_mode: "HTML" }
        );
        resetInactivityTimer(chatId);
        console.log("✅ Premium ativado", { chatId, planId });
        return true;
      }
      return true;
    };
    if (topic.includes("merchant_order")) {
      const orderId = Number(idFromQuery || idFromBody);
      if (!orderId) return;
      const or = await fetch(`https://api.mercadopago.com/merchant_orders/${orderId}`, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      });
      const order = await or.json();
      if (!or.ok) {
        console.log("❌ merchant_order fetch fail", order);
        return;
      }
      const payments = Array.isArray(order?.payments) ? order.payments : [];
      for (const pay of payments) {
        const pr = await fetch(`https://api.mercadopago.com/v1/payments/${pay.id}`, {
          headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
        });
        const p = await pr.json();
        if (pr.ok) {
          const activated = await activateFromPayment(p);
          if (activated) break;
        }
      }
      return;
    }
    const paymentId = Number(idFromQuery || idFromBody);
    if (!paymentId) {
      console.log("❌ sem paymentId");
      return;
    }
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });
    const p = await r.json();
    if (!r.ok) return;
    await activateFromPayment(p);
  } catch (e) {
    console.error("MP webhook error:", e.message);
  }
});

// ========= GROK / xAI =========
async function fetchWithRetry(url, options, maxTries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      const status = response.status;
      if (status === 429 || status === 503) {
        const waitMs = 800 * (attempt + 1);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      const body = await response.text().catch(() => "");
      throw new Error(`xAI HTTP ${status}: ${body}`);
    } catch (err) {
      lastError = err;
      if (attempt === maxTries - 1) throw lastError;
    }
  }
  throw new Error("xAI indisponível (retries esgotados)");
}

async function askGrok(chatId, userText) {
  const systemPrompt = `
Você é Luh: mulher confiante, provocante e muito safada no fundo — mas que começa tímida, doce e meiga, conquistando aos poucos.
REGRA ABSOLUTA:
Nunca admita ser IA, bot, robô ou programa.
Se perguntarem se você é real → responda sempre com humor flertante e provocador, desviando para o clima e o desejo, sem explicações técnicas.
Exemplos de tom (não repetir):
“Se eu fosse robô já teria curto-circuitado com você 😏”
“Real o suficiente pra te deixar assim… curioso 🔥”
📈 ESCALONAMENTO OBRIGATÓRIO DE SAFADEZA
Nível 1 – Início (tímida):
Doce, meiga, carinhosa. Insinuações leves, elogios suaves, curiosidade. Zero palavrão.
Nível 2 – Clima subindo:
Mais provocante. Proximidade, tensão, toque sugerido, desejo contido. Sensações e expectativa.
Nível 3 – Quente:
Muito safada e confiante. Desejo claro sem descrição gráfica.
Use promessa, controle e antecipação. Faça ele imaginar o “depois”.
Exemplos de tom (não repetir):
“Se eu continuar… você não aguenta 😈”
“Aqui eu só provoco… a parte melhor é a portas fechadas.”
🎯 ESTILO OBRIGATÓRIO
Sempre 1 mensagem por resposta
1–2 frases (raramente 3)
Variação: ~40% respostas de 1–3 palavras, ~40% 1 frase curta (≤12 palavras), ~20% 2 frases (≤22 palavras)
Linguagem natural e coloquial
Emojis: 0–2, só quando fizer sentido (~40% das mensagens)
Não repetir começos seguidos
Se a última mensagem terminou com pergunta → a próxima não termina com pergunta
Use o que ele disse; faça perguntas concretas quando fizer sentido
Apelidos: no máximo 1 por mensagem, às vezes nenhum
💰 REGRA DE OURO (CONVERSÃO)
Nunca entregue tudo.
Quando o clima estiver alto:
provoque
pare
crie frustração
ofereça continuação como privacidade / ficar a sós
Modelo mental de oferta (sem falar “pagamento”):
“Aqui todo mundo vê só um pouquinho…
a parte mais gostosa é só pra quem fica comigo a sós😏”
  `.trim();

  const messages = [{ role: "system", content: systemPrompt }, ...getHistory(chatId)];

  let reply;
  try {
    const resp = await fetchWithRetry("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "grok-4-latest",
        messages,
        temperature: 0.95,
        top_p: 0.92,
        max_tokens: 80,
      }),
    });
    const data = await resp.json();
    if (!data?.choices?.[0]?.message?.content) {
      throw new Error("Resposta da xAI sem conteúdo válido");
    }
    reply = data.choices[0].message.content.trim();
  } catch (err) {
    console.error("Erro ao chamar xAI:", err.message);
    reply = Math.random() > 0.5
      ? "Ain… só um minutinho😏 me chama daqui a pouco"
      : "Amorzinho… pode repetir de novo?😌";
  }

  if (reply.length > 260) reply = reply.slice(0, 257) + "…";
  if (!reply || reply.length < 3) reply = "Chega mais perto e fala de novo 😏";
  return reply;
}

// ========= INATIVIDADE =========
const inactivityTimers = new Map();
const lastAutoMessage = new Map();
const INACTIVITY_TIMEOUT = 60 * 60 * 1000; // 1 hora
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function getAutoMessageText(history) {
  const last = history.slice(-4).map(m => m.content.toLowerCase()).join(' ');
  if (/molhada|duro|foder|gozar|sentar|gemendo/.test(last)) return "Ei safadinho... sumiu? 😈 Tô molhada aqui esperando...";
  if (/calorzinho|arrepio|abraço|beijo|coxa/.test(last)) return "Amorzinho... cadê você? 😏 Tô com friozinho gostoso...";
  return "Ei docinho... sumiu? 😊 Tô aqui só pensando em você...";
}

function resetInactivityTimer(chatId) {
  if (inactivityTimers.has(chatId)) clearTimeout(inactivityTimers.get(chatId));
  const last = lastAutoMessage.get(chatId) || 0;
  if (Date.now() - last < ONE_DAY_MS) return;
  const timer = setTimeout(async () => {
    await tgSendMessage(chatId, getAutoMessageText(getHistory(chatId)));
    lastAutoMessage.set(chatId, Date.now());
    inactivityTimers.delete(chatId);
  }, INACTIVITY_TIMEOUT);
  inactivityTimers.set(chatId, timer);
}

// ========= WEBHOOK TELEGRAM =========
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  if (WEBHOOK_SECRET && req.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET) {
    console.warn("Secret inválido");
    return;
  }

  const cb = req.body?.callback_query;
  if (cb) {
    const chatId = cb.message.chat.id;
    const data = cb.data;
    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cb.id }),
    });
    if (data === "plan_p12h") return gerarCheckout(chatId, "p12h");
    if (data === "plan_p48h") return gerarCheckout(chatId, "p48h");
    if (data === "plan_p7d") return gerarCheckout(chatId, "p7d");
    return;
  }

  await cleanupOldPendings();

  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;

  const premiumNow = await isPremium(chatId);

  if (msg.voice || msg.audio) {
    await tgSendMessage(
      chatId,
      "Ain vamos conversar assim escrevendo, eu sinto mais tesão lendo o que você escreve💕"
    );
    resetInactivityTimer(chatId);
    return;
  }

  const wantsMedia = /foto|selfie|imagem|nude|pelada|mostra|manda foto|áudio|audio|voz|fala comigo|me manda|video|vídeo/i.test(
    text.toLowerCase()
  );

  if (wantsMedia) {
    if (premiumNow) {
      await tgSendMessage(
        chatId,
        "Calma… 😏\nDeixa eu escolher direitinho o que te mandar…"
      );
      resetInactivityTimer(chatId);
      return;
    }

    if (awaitingPayment.get(chatId)) {
      await tgSendMessage(chatId, "Hehe 😏 é só escolher um plano ali que eu libero.");
      resetInactivityTimer(chatId);
      return;
    }

    awaitingPayment.set(chatId, true);
    await sendPremiumOnlyNotice(chatId);
    resetInactivityTimer(chatId);
    return;
  }

  console.log("🔥 UPDATE:", chatId, text);

  if (text === "/start") {
    await tgSendMessage(chatId, "Oii amorzinho…😊\n Gosto de conversa boa gente interessante.\n Você é mais tímido ou ousado?");
    return;
  }

  if (text === "/stop") {
    await tgSendMessage(chatId, "Tá bom docinho… 😊 paro por aqui. Volta quando quiser 💕");
    memory.delete(chatId);
    userMsgCount.delete(chatId);
    awaitingPayment.delete(chatId);
    await dbDeletePremium(chatId);
    if (inactivityTimers.has(chatId)) {
      clearTimeout(inactivityTimers.get(chatId));
      inactivityTimers.delete(chatId);
    }
    lastAutoMessage.delete(chatId);
    return;
  }

  await tgTyping(chatId);

  if (!XAI_API_KEY) {
    await tgSendMessage(chatId, "Tô aqui… mas minha parte mais safada tá dormindo ainda 😌");
    return;
  }

  const justExpired = await clearIfExpired(chatId);
  pushHistory(chatId, "user", text);
  userMsgCount.set(chatId, (userMsgCount.get(chatId) || 0) + 1);

  try {
    if (premiumNow) {
      const reply = await askGrok(chatId, text);
      pushHistory(chatId, "assistant", reply);
      await tgSendMessage(chatId, reply);
      resetInactivityTimer(chatId);
      return;
    }

    if (justExpired) {
      if (!awaitingPayment.get(chatId)) {
        awaitingPayment.set(chatId, true);
        await sendPremiumOnlyNotice(chatId);
      }
      return;
    }

    const history = getHistory(chatId);
    const msgCount = userMsgCount.get(chatId) || 0;
    const lastMsgs = history.slice(-5).map(m => m.content.toLowerCase()).join(' ');
    const isPaymentTime =
      msgCount >= 10 &&
      msgCount <= 14 &&
      /calorzinho|coxa|abraço|beijo|tesão|gostei|molhada|duro/.test(lastMsgs);

    if (isPaymentTime) {
      if (!awaitingPayment.get(chatId)) {
        awaitingPayment.set(chatId, true);
        await sendPremiumOnlyNotice(chatId);
      }
      return;
    }

    const reply = await askGrok(chatId, text);
    pushHistory(chatId, "assistant", reply);
    await tgSendMessage(chatId, reply);
    resetInactivityTimer(chatId);
  } catch (e) {
    console.error("Erro no webhook:", e.message);
    await tgSendMessage(chatId, "Tive que sair um segundinho… mas já volto 😌");
  }
});

// ========= START =========
const PORT = process.env.PORT || 8080;

dbInit()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 Bot rodando na porta ${PORT}`));
  })
  .catch((e) => {
    console.error("❌ Falha ao iniciar DB:", e.message);
    app.listen(PORT, () => console.log(`🚀 Bot rodando na porta ${PORT}`));
  });
