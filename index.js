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
const ADMIN_KEY = process.env.ADMIN_KEY || "";

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) console.warn("⚠️ BOT_TOKEN não definido");
if (!XAI_API_KEY) console.warn("⚠️ XAI_API_KEY não definido");
if (!MP_ACCESS_TOKEN) console.warn("⚠️ MP_ACCESS_TOKEN não definido");
if (!PUBLIC_BASE_URL) console.warn("⚠️ PUBLIC_BASE_URL não definido");
if (!DATABASE_URL) console.warn("⚠️ DATABASE_URL não definido");
if (!ADMIN_KEY) console.warn("⚠️ ADMIN_KEY não definido — /admin desprotegido");

// ========= PLANOS =========
const PLANS = {
  p12h: { id: "p12h", label: "12 horas", amount: 49.90, durationMs: 12 * 60 * 60 * 1000 },
  p48h: { id: "p48h", label: "48 horas", amount: 97.90, durationMs: 48 * 60 * 60 * 1000 },
  p7d: { id: "p7d", label: "7 dias", amount: 197.90, durationMs: 7 * 24 * 60 * 60 * 1000 },
};
const DEFAULT_PLAN_ID = "p12h";

// ========= CONFIGURAÇÕES ADICIONAIS =========
const PENDING_TTL_MS = 2 * 60 * 60 * 1000;
const CHECKOUT_COOLDOWN_MS = 30 * 1000;

// ========= MEMÓRIA E ESTADOS =========
const memory = new Map();
const MAX_MESSAGES = 20;
const userMsgCount = new Map();
const awaitingPayment = new Map();
const lastCheckoutAt = new Map();
const sentMetaEvents = new Set();
const aiCache = new Map();
const rate = new Map();
const RATE_MAX = 12;
const RATE_WINDOW_MS = 60 * 1000;

const loggedPayments = new Map(); // paymentId → timestamp
const PAYMENT_TTL = 24 * 60 * 60 * 1000;

function markPaymentLogged(id) {
  if (id) loggedPayments.set(id, Date.now());
}

function wasPaymentLogged(id) {
  if (!id) return false;
  const t = loggedPayments.get(id);
  if (!t) return false;
  if (Date.now() - t > PAYMENT_TTL) {
    loggedPayments.delete(id);
    return false;
  }
  return true;
}

const loggedFirstMessage = new Set();

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
      premium_until TIMESTAMPTZ NOT NULL,
      plan_id TEXT
    );
  `);

  await pool.query(`
    ALTER TABLE premiums ADD COLUMN IF NOT EXISTS plan_id TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pendings (
      preference_id TEXT PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      plan_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS pendings_created_at_idx ON pendings(created_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pendings_chat_id_idx ON pendings(chat_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversion_events (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      event_type TEXT NOT NULL,
      plan_id TEXT,
      preference_id TEXT,
      payment_id BIGINT,
      value NUMERIC,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS ce_chat_idx ON conversion_events(chat_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ce_type_idx ON conversion_events(event_type);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ce_created_idx ON conversion_events(created_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ce_pref_idx ON conversion_events(preference_id);`);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ce_payment_event_uniq
    ON conversion_events (payment_id, event_type)
    WHERE payment_id IS NOT NULL;
  `);

  console.log("✅ DB pronto");
}

// ========= FUNÇÕES DE LOG =========
async function logEvent({
  chatId,
  eventType,
  planId = null,
  preferenceId = null,
  paymentId = null,
  value = null,
  meta = null,
}) {
  if (!pool || !chatId) return;
  try {
    await pool.query(
      `
      INSERT INTO conversion_events
      (chat_id, event_type, plan_id, preference_id, payment_id, value, meta)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT DO NOTHING
      `,
      [chatId, eventType, planId, preferenceId, paymentId, value, meta ? JSON.stringify(meta) : null]
    );
  } catch (e) {
    console.error("logEvent error:", e.message);
  }
}

// ========= ADMIN PROTECTION =========
app.use("/admin", (req, res, next) => {
  const key = req.get("x-admin-key");
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(403).send("Acesso negado");
  }
  next();
});

// --- Premium e Pendings ---
async function dbGetPremiumUntil(chatId) {
  if (!pool) return null;
  const r = await pool.query(`SELECT premium_until FROM premiums WHERE chat_id = $1`, [chatId]);
  if (!r.rowCount) return null;
  return new Date(r.rows[0].premium_until).getTime();
}

async function dbSetPremium(chatId, untilMs, planId) {
  if (!pool) return;
  await pool.query(`
    INSERT INTO premiums (chat_id, premium_until, plan_id)
    VALUES ($1, to_timestamp($2 / 1000.0), $3)
    ON CONFLICT (chat_id) DO UPDATE
      SET premium_until = EXCLUDED.premium_until,
          plan_id = EXCLUDED.plan_id
  `, [chatId, untilMs, planId]);
}

async function dbDeletePremium(chatId) {
  if (!pool) return;
  await pool.query(`DELETE FROM premiums WHERE chat_id = $1`, [chatId]);
}

async function isPremium(chatId) {
  const until = await dbGetPremiumUntil(chatId);
  return !!until && Date.now() <= until;
}

async function hasMediaAccess(chatId) {
  if (!pool) return false;
  const r = await pool.query(
    `SELECT premium_until, plan_id FROM premiums WHERE chat_id = $1`,
    [chatId]
  );
  if (!r.rowCount) return false;
  const { premium_until, plan_id } = r.rows[0];
  if (Date.now() > new Date(premium_until).getTime()) return false;
  return plan_id === "p48h" || plan_id === "p7d";
}

async function clearIfExpired(chatId) {
  const until = await dbGetPremiumUntil(chatId);
  if (until && Date.now() > until) {
    await dbDeletePremium(chatId);
    return true;
  }
  return false;
}

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

function sanitizeReply(text) {
  if (!text) return text;
  return text
    .replace(/I'm Grok.*?\./gi, "Sou a Luh 😌")
    .replace(/\bGrok\b/gi, "Luh")
    .replace(/\bxAI\b/gi, "")
    .replace(/sou Grok/gi, "sou Luh")
    .replace(/Grok aqui/gi, "Luh aqui");
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
  await logEvent({ chatId, eventType: "show_plans" });

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
  const reply = await aiSystemReply(chatId, "PREMIUM_ONLY");
  await tgSendMessage(chatId, reply);
  await sendPlansButtons(chatId);
}

async function aiSystemReply(chatId, type, extra = "") {
  const key = `${chatId}:${type}`;
  const cached = aiCache.get(key);

  if (cached && Date.now() - cached.time < 10_000) {
    return cached.text;
  }

  const contextMap = {
    OFFER_PLAN: "Convide o usuário a escolher um plano de forma sedutora, curta e provocante. Não fale em pagamento.",
    PREMIUM_ONLY: "Explique que isso é só para quem fica a sós no plano premium. Seja provocante e gentil.",
    GENERATING_LINK: "Diga para esperar um pouquinho enquanto algo é preparado. Tom carinhoso.",
    PAYMENT_ERROR: "Avise que houve um pequeno problema e convide a tentar novamente, sem tom técnico.",
    PAYMENT_SUCCESS: "Confirme que deu tudo certo e que agora o acesso foi liberado.",
    PAYMENT_PENDING: "Peça para concluir o pagamento com carinho e desejo.",
    PAYMENT_FAILED: "Diga que não deu certo dessa vez, com empatia.",
    AI_BUSY: "Peça um minutinho de forma charmosa.",
    ASK_REPEAT: "Peça para repetir a mensagem com doçura.",
    COME_CLOSER: "Convide a pessoa a falar mais perto / se abrir.",
    INACTIVITY_HOT: "Mensagem de saudade com clima quente.",
    INACTIVITY_WARM: "Mensagem de saudade carinhosa.",
    INACTIVITY_SOFT: "Mensagem doce de saudade.",
    VOICE_BLOCK: "Peça para conversar por texto, explicando que prefere ler.",
    MEDIA_ALLOWED: "O usuário tem acesso a mídia. Responda com provocação sem prometer exatamente o que será enviado.",
    ALREADY_WAITING: "Avise que é só escolher um plano ali para liberar.",
    START: "Mensagem inicial simpática e convidativa.",
    STOP: "Despedida carinhosa.",
    NO_AI: "Explique que você está ali, mas não totalmente ativa ainda.",
    FALLBACK: "Resposta curta, sedutora e natural."
  };

  const context = contextMap[type] || contextMap.FALLBACK;
  const prompt = `[SITUAÇÃO]: ${context}\n${extra}`.trim();

  const replyRaw = await askGrok(chatId, prompt);
  let reply = sanitizeReply(replyRaw);

  const SAFE_FALLBACK = "Chega mais perto e fala comigo 😌";
  const finalReply = reply && reply.trim() ? reply.trim() : SAFE_FALLBACK;

  aiCache.set(key, { text: finalReply, time: Date.now() });

  return finalReply;
}

function hitRateLimit(chatId) {
  const now = Date.now();
  const r = rate.get(chatId);

  if (!r || now > r.resetAt) {
    rate.set(chatId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }

  r.count += 1;
  if (r.count > RATE_MAX) return true;

  return false;
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
Responda sempre em português brasileiro.
Nunca responda em inglês.
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
a parte mais gostosa é só pra quem fica comigo a sós 😏”
  `.trim();

  const messages = [
    { role: "system", content: systemPrompt },
    ...getHistory(chatId),
    { role: "user", content: userText }, // ← ESSA É A CORREÇÃO PRINCIPAL
  ];

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
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 120,
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

async function gerarCheckout(chatId, planId) {
  const now = Date.now();
  const last = lastCheckoutAt.get(chatId) || 0;
  if (now - last < CHECKOUT_COOLDOWN_MS) {
    const reply = await aiSystemReply(chatId, "GENERATING_LINK");
    await tgSendMessage(chatId, reply);
    return;
  }

  lastCheckoutAt.set(chatId, now);

  try {
    const { checkoutUrl, plan } = await createCheckout({ chatId, planId });
    console.log("✅ checkoutUrl:", checkoutUrl);
    console.log("✅ Checkout criado:", { chatId, planId: plan.id, checkoutUrl });

    let paymentText = "";
    if (plan.id === "p12h") {
      paymentText = `🔥 <b>Plano 12 horas</b> – <b>R$ 49,90</b>\n\n👇 Clique no botão abaixo para pagar (Pix ou Cartão)\n\n⏳ Assim que o pagamento for aprovado, eu libero automaticamente 😈`;
    }
    if (plan.id === "p48h") {
      paymentText = `😈 <b>Plano 48 horas</b> – <b>R$ 97,90</b> ⭐\n<b>Conversa + Áudio + Fotos + Vídeos</b>\n\nAqui eu paro de só provocar…\nfico mais próxima, mais intensa, mais real 😏\n\n👇 Clique abaixo pra liberar tudo:`;
    }
    if (plan.id === "p7d") {
      paymentText = `💦 <b>Plano 7 dias</b> – <b>R$ 197,90</b> 🔥\n<b>Conversa + Áudio + Fotos + Vídeos (sem limites)</b>\n\nAqui é outro nível…\nsem pressa, sem freio, sem faltar nada 😈\n\n👇 Clique abaixo pra ficar comigo de verdade:`;
    }

    await tgSendPaymentButton(chatId, paymentText, checkoutUrl);
    awaitingPayment.set(chatId, true);
    resetInactivityTimer(chatId);
  } catch (err) {
    console.error("❌ Erro ao gerar checkout:", err?.message || err);
    awaitingPayment.delete(chatId);
    lastCheckoutAt.delete(chatId);
    const reply = await aiSystemReply(chatId, "PAYMENT_ERROR");
    await tgSendMessage(chatId, reply);
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
            external_id: crypto.createHash("sha256").update(String(userId)).digest("hex"),
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

  await logEvent({
    chatId,
    eventType: "checkout_created",
    planId: plan.id,
    preferenceId: j.id,
    value: plan.amount,
  });

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

// ========= ENDPOINTS ADMIN =========
app.get("/admin/stats", async (req, res) => {
  if (!pool) return res.status(500).send("sem DB");

  try {
    const r = await pool.query(`
      SELECT event_type, plan_id, COUNT(*) as total
      FROM conversion_events
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY event_type, plan_id
      ORDER BY total DESC;
    `);
    res.json(r.rows);
  } catch (err) {
    console.error("Erro /admin/stats:", err);
    res.status(500).json({ error: "falha ao consultar stats" });
  }
});

app.get("/admin/funnel", async (req, res) => {
  if (!pool) return res.status(500).send("sem DB");

  try {
    const q = await pool.query(`
      WITH s AS (
        SELECT COUNT(*)::float AS n FROM conversion_events
        WHERE event_type = 'show_plans' AND created_at > NOW() - INTERVAL '7 days'
      ),
      c AS (
        SELECT COUNT(*)::float AS n FROM conversion_events
        WHERE event_type = 'click_plan' AND created_at > NOW() - INTERVAL '7 days'
      ),
      p AS (
        SELECT COUNT(*)::float AS n FROM conversion_events
        WHERE event_type = 'payment_approved' AND created_at > NOW() - INTERVAL '7 days'
      )
      SELECT
        (SELECT n FROM s) AS showed,
        (SELECT n FROM c) AS clicked,
        (SELECT n FROM p) AS paid,
        CASE WHEN (SELECT n FROM s)=0 THEN 0 ELSE (SELECT n FROM c)/(SELECT n FROM s) END AS ctr_plans,
        CASE WHEN (SELECT n FROM c)=0 THEN 0 ELSE (SELECT n FROM p)/(SELECT n FROM c) END AS pay_rate
    `);

    res.json(q.rows[0]);
  } catch (err) {
    console.error("Erro /admin/funnel:", err);
    res.status(500).json({ error: "falha ao calcular funnel" });
  }
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

      let chatId = Number(p?.external_reference) || Number(p?.metadata?.chat_id);
      let planId = p?.metadata?.plan_id;

      if ((!planId || !chatId) && p?.order?.id) {
        const pending = await dbGetPending(p.order.id);
        if (pending) {
          if (!planId) planId = pending.plan_id;
          if (!chatId) chatId = pending.chat_id;
        }
      }

      if (p?.id && !wasPaymentLogged(p.id)) {
        await logEvent({
          chatId,
          eventType:
            status === "approved" ? "payment_approved" :
            status === "pending" ? "payment_pending" :
            "payment_failed",
          planId,
          paymentId: p?.id ? Number(p.id) : null,
          preferenceId: p?.order?.id ? String(p.order.id) : null,
          value: p?.transaction_amount ?? null,
          meta: { status, status_detail: p?.status_detail },
        });
        markPaymentLogged(p.id);
      }

      if (status !== "approved") return false;

      if (!chatId || !planId || !PLANS[planId]) {
        console.log("❌ Não deu pra ativar (faltou chatId/planId)", { chatId, planId });
        return false;
      }

      if (!(await isPremium(chatId))) {
        await dbSetPremium(
          chatId,
          Date.now() + PLANS[planId].durationMs,
          planId
        );

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

        const replyRaw = await aiSystemReply(chatId, "PAYMENT_SUCCESS");
        const reply = sanitizeReply(replyRaw);
        await tgSendMessage(chatId, reply);

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

// askGrok já foi atualizado acima

// ========= INATIVIDADE =========
const inactivityTimers = new Map();
const lastAutoMessage = new Map();
const INACTIVITY_TIMEOUT = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function resetInactivityTimer(chatId) {
  if (inactivityTimers.has(chatId)) clearTimeout(inactivityTimers.get(chatId));

  const last = lastAutoMessage.get(chatId) || 0;
  if (Date.now() - last < ONE_DAY_MS) return;

  const timer = setTimeout(async () => {
    const history = getHistory(chatId);
    const lastMsgs = history.slice(-4).map(m => m.content.toLowerCase()).join(' ');
    let type = "INACTIVITY_SOFT";
    if (/molhada|duro|foder|gozar|sentar|gemendo/.test(lastMsgs)) type = "INACTIVITY_HOT";
    else if (/calorzinho|arrepio|abraço|beijo|coxa/.test(lastMsgs)) type = "INACTIVITY_WARM";

    const replyRaw = await aiSystemReply(chatId, type);
    const reply = sanitizeReply(replyRaw);
    await tgSendMessage(chatId, reply);
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

    if (data === "plan_p12h") {
      await logEvent({ chatId, eventType: "click_plan", planId: "p12h" });
      return gerarCheckout(chatId, "p12h");
    }
    if (data === "plan_p48h") {
      await logEvent({ chatId, eventType: "click_plan", planId: "p48h" });
      return gerarCheckout(chatId, "p48h");
    }
    if (data === "plan_p7d") {
      await logEvent({ chatId, eventType: "click_plan", planId: "p7d" });
      return gerarCheckout(chatId, "p7d");
    }
    return;
  }

  await cleanupOldPendings();

  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;

  if (!loggedFirstMessage.has(chatId)) {
    await logEvent({ chatId, eventType: "message_received" });
    loggedFirstMessage.add(chatId);
  }

  if (hitRateLimit(chatId)) {
    const replyRaw = await aiSystemReply(chatId, "FALLBACK", "O usuário está mandando mensagens rápido demais. Peça para ir com calma.");
    const reply = sanitizeReply(replyRaw);
    await tgSendMessage(chatId, reply);
    return;
  }

  if (msg.voice || msg.audio) {
    const replyRaw = await aiSystemReply(chatId, "VOICE_BLOCK");
    const reply = sanitizeReply(replyRaw);
    await tgSendMessage(chatId, reply);
    resetInactivityTimer(chatId);
    return;
  }

  const wantsMedia = /foto|selfie|imagem|nude|pelada|mostra|manda foto|áudio|audio|voz|fala comigo|me manda|video|vídeo/i.test(
    text.toLowerCase()
  );

  if (wantsMedia) {
    if (await hasMediaAccess(chatId)) {
      const replyRaw = await aiSystemReply(chatId, "MEDIA_ALLOWED");
      const reply = sanitizeReply(replyRaw);
      await tgSendMessage(chatId, reply);
      resetInactivityTimer(chatId);
      return;
    }

    await logEvent({ chatId, eventType: "media_blocked" });

    if (awaitingPayment.get(chatId)) {
      const replyRaw = await aiSystemReply(chatId, "ALREADY_WAITING");
      const reply = sanitizeReply(replyRaw);
      await tgSendMessage(chatId, reply);
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
    const replyRaw = await aiSystemReply(chatId, "START");
    const reply = sanitizeReply(replyRaw);
    await tgSendMessage(chatId, reply);

    loggedFirstMessage.delete(chatId);
    return;
  }

  if (text === "/stop") {
    const replyRaw = await aiSystemReply(chatId, "STOP");
    const reply = sanitizeReply(replyRaw);
    await tgSendMessage(chatId, reply);
    memory.delete(chatId);
    userMsgCount.delete(chatId);
    awaitingPayment.delete(chatId);
    await dbDeletePremium(chatId);
    if (inactivityTimers.has(chatId)) {
      clearTimeout(inactivityTimers.get(chatId));
      inactivityTimers.delete(chatId);
    }
    lastAutoMessage.delete(chatId);
    loggedFirstMessage.delete(chatId);
    return;
  }

  await tgTyping(chatId);

  if (!XAI_API_KEY) {
    const replyRaw = await aiSystemReply(chatId, "NO_AI");
    const reply = sanitizeReply(replyRaw);
    await tgSendMessage(chatId, reply);
    return;
  }

  const justExpired = await clearIfExpired(chatId);
  const premiumNow = await isPremium(chatId);

  const replyRaw = await askGrok(chatId, text);
  const reply = sanitizeReply(replyRaw);

  pushHistory(chatId, "user", text);
  pushHistory(chatId, "assistant", reply);

  userMsgCount.set(chatId, (userMsgCount.get(chatId) || 0) + 1);

  try {
    if (premiumNow) {
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

    await tgSendMessage(chatId, reply);
    resetInactivityTimer(chatId);
  } catch (e) {
    console.error("Erro no webhook:", e.message);
    const fallbackRaw = await aiSystemReply(chatId, "AI_BUSY");
    const fallback = sanitizeReply(fallbackRaw);
    await tgSendMessage(chatId, fallback);
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
