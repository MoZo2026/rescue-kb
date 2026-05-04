module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const {
    question,
    knowledge,
    images = [],
    history = [],
    conversationSummary = ""
  } = req.body || {};

  if (!question && (!images || images.length === 0)) {
    return res.status(400).json({ error: "No question" });
  }

  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const BRAVE_KEY = process.env.BRAVE_API_KEY;
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!CLAUDE_KEY || !OPENAI_KEY || !SB_URL || !SB_KEY) {
    return res.status(500).json({ error: "Missing environment variables" });
  }

  const safeQuestion = String(question || "صف هذه الصورة واشرحها في سياق NARS/SAR").trim();

  async function getVerifiedUser() {
    const authHeader = req.headers.authorization || req.headers.Authorization || "";
    const token = String(authHeader).startsWith("Bearer ") ? String(authHeader).slice(7) : "";
    if (!token) return { id: null, email: null, role: "guest" };
    try {
      const r = await fetch(`${SB_URL}/auth/v1/user`, {
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${token}` }
      });
      const u = await r.json();
      if (!r.ok || !u?.id) return { id: null, email: null, role: "guest" };
      return { id: u.id, email: u.email || null, role: "student" };
    } catch (_) {
      return { id: null, email: null, role: "guest" };
    }
  }

  const verifiedUser = await getVerifiedUser();
  const userEmail = verifiedUser.email || req.headers["x-user-email"] || null;
  const userId = verifiedUser.id || req.headers["x-user-id"] || null;
  const IMAGE_DAILY_LIMIT = 15;
  const quotaMessage = "تم استنفاد الحد اليومي لرفع الصور. سيتاح الرفع مجددًا بعد الساعة 12 ليلًا بتوقيت السعودية.";

  async function sbFetch(path, options = {}) {
    return fetch(`${SB_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "apikey": SB_KEY,
        "Authorization": `Bearer ${SB_KEY}`,
        ...(options.headers || {})
      }
    });
  }

  async function logSearch(text) {
    try {
      await sbFetch("/rest/v1/search_analytics", {
        method: "POST",
        headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({
          user_id: userId,
          user_email: userEmail,
          search_text: text,
          normalized_text: text.toLowerCase(),
          category: "chat",
          result_type: "pending"
        })
      });
    } catch (_) {}
  }

  async function logChat(answer, confidence, sources = []) {
    try {
      await sbFetch("/rest/v1/chat_history", {
        method: "POST",
        headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({
          user_id: userId,
          user_email: userEmail,
          question: safeQuestion,
          answer,
          sources,
          confidence
        })
      });
    } catch (_) {}
  }

  async function savePendingQuestion() {
    try {
      await sbFetch("/rest/v1/pending_questions", {
        method: "POST",
        headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({
          question: safeQuestion,
          answered: false,
          user_id: userId,
          user_email: userEmail,
          status: "pending"
        })
      });
    } catch (_) {}
  }

  async function checkAndLogImageQuota() {
    const imageCount = Array.isArray(images) ? images.length : 0;
    if (imageCount === 0) return { ok: true, remaining: IMAGE_DAILY_LIMIT };

    const countRes = await sbFetch("/rest/v1/rpc/count_today_images_riyadh", { method: "POST", body: "{}" });
    const currentCount = await countRes.json();
    const used = Number(currentCount || 0);
    const remaining = Math.max(0, IMAGE_DAILY_LIMIT - used);

    if (imageCount > remaining) {
      return { ok: false, used, remaining };
    }

    const rows = images.map((img, idx) => ({
      user_id: userId,
      user_email: userEmail,
      image_name: `chat-image-${Date.now()}-${idx + 1}.jpg`,
      image_size: Math.ceil(String(img || "").length * 0.75)
    }));

    await sbFetch("/rest/v1/image_upload_logs", {
      method: "POST",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify(rows)
    });

    return { ok: true, used: used + imageCount, remaining: remaining - imageCount };
  }

  function simpleTokens(text) {
    return String(text || "")
      .replace(/[؟?.,،:;()\[\]{}]/g, " ")
      .split(/\s+/)
      .map(t => t.trim())
      .filter(t => t.length >= 4)
      .slice(0, 6);
  }

  async function findApprovedOrFaq() {
    const tokens = simpleTokens(safeQuestion);
    const key = encodeURIComponent(tokens[0] || safeQuestion.slice(0, 50));
    if (!key) return null;

    try {
      const aRes = await sbFetch(`/rest/v1/approved_answers?is_active=eq.true&or=(question.ilike.*${key}*,tags.ilike.*${key}*)&select=id,question,answer,category,source_file,source_page&limit=1`);
      const aData = await aRes.json();
      if (Array.isArray(aData) && aData.length) {
        return { type: "approved_answer", item: aData[0] };
      }
    } catch (_) {}

    try {
      const fRes = await sbFetch(`/rest/v1/faq_items?is_active=eq.true&or=(question.ilike.*${key}*,tags.ilike.*${key}*)&select=id,question,answer,category&limit=1`);
      const fData = await fRes.json();
      if (Array.isArray(fData) && fData.length) {
        return { type: "faq", item: fData[0] };
      }
    } catch (_) {}

    return null;
  }

  try {
    await logSearch(safeQuestion);

    const quota = await checkAndLogImageQuota();
    if (!quota.ok) {
      await logChat(quotaMessage, "quota_exceeded", []);
      return res.status(200).json({ answer: quotaMessage, quotaExceeded: true, pending: false });
    }

    // 1) Low-cost operational intelligence: approved answers / FAQ before AI.
    if (!images || images.length === 0) {
      const cached = await findApprovedOrFaq();
      if (cached?.item?.answer) {
        const answer = cached.item.answer + (cached.type === "approved_answer" ? "\n\nالمصدر: إجابة معتمدة من المسئول." : "\n\nالمصدر: الأسئلة الشائعة.");
        await logChat(answer, cached.type, [{ type: cached.type, id: cached.item.id }]);
        return res.status(200).json({ answer, sourceType: cached.type });
      }
    }

    // 2) Build a contextual search query so follow-up questions do not lose context.
    const cleanHistory = Array.isArray(history)
      ? history.filter(m => m && (m.role === "user" || m.role === "assistant") && m.content).slice(-12)
      : [];

    const recentUserContext = cleanHistory
      .slice(-6)
      .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${String(m.content).slice(0, 700)}`)
      .join("\n");

    const contextualQuestion = [
      conversationSummary ? `Conversation summary:\n${String(conversationSummary).slice(-2500)}` : "",
      recentUserContext ? `Recent conversation:\n${recentUserContext}` : "",
      `Current question:\n${safeQuestion}`
    ].filter(Boolean).join("\n\n");

    // 3) Embed contextual question.
    const oRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: "text-embedding-3-small", input: [contextualQuestion.slice(-7000)] })
    });
    const oData = await oRes.json();
    if (!oRes.ok) throw new Error("OpenAI: " + oData?.error?.message);
    const queryEmbedding = oData.data[0].embedding;

    // 4) Search RAG chunks.
    const searchRes = await sbFetch("/rest/v1/rpc/search_chunks", {
      method: "POST",
      body: JSON.stringify({ query_embedding: `[${queryEmbedding.join(",")}]`, match_count: 10 })
    });
    const chunks = await searchRes.json();

    const kbCtx = (knowledge || [])
      .map(k => `[${k.category || "عام"}] ${k.title}\n${k.content}`)
      .join("\n\n---\n\n");

    const goodChunks = Array.isArray(chunks) ? chunks.filter(c => Number(c.similarity || 0) > 0.25) : [];
    const chunksCtx = goodChunks.length > 0
      ? goodChunks
          .map(c => `[${c.file_name} | ${c.category || "عام"} | صلة: ${(Number(c.similarity || 0) * 100).toFixed(0)}%]\n${c.chunk_text}`)
          .join("\n\n---\n\n")
      : "";

    const internalContext = [kbCtx, chunksCtx].filter(Boolean).join("\n\n══════════\n\n");

    // 5) Optional web search if no good internal results.
    let webContext = "";
    const hasGoodResults = Array.isArray(chunks) && chunks.some(c => Number(c.similarity || 0) > 0.45);

    if (!hasGoodResults && BRAVE_KEY) {
      try {
        const braveRes = await fetch(
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(safeQuestion + " naval aviation rescue swimmer NARS SAR")}&count=5`,
          { headers: { "Accept": "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": BRAVE_KEY } }
        );
        const braveData = await braveRes.json();
        if (braveData?.web?.results?.length > 0) {
          webContext = "نتائج من الإنترنت:\n\n" + braveData.web.results
            .slice(0, 4)
            .map(r => `[${r.title}]\n${r.description}`)
            .join("\n\n---\n\n");
        }
      } catch (e) {
        console.log("Web search failed:", e.message);
      }
    }

    const fullContext = [internalContext, webContext].filter(Boolean).join("\n\n🌐 ══════════\n\n");

    const sys = `أنت مساعد تعليمي متخصص حصرياً في مجال الإنقاذ البحري الجوي (Naval Aviation Rescue Swimming — NARS) والبحث والإنقاذ (SAR).

قواعدك:
- تجاهل الأخطاء الإملائية وافهم المقصد دائماً.
- أجب فقط عن NARS وSAR. لأي سؤال خارج هذا المجال قل: "هذا السؤال خارج نطاق تخصصي."
- حافظ على سياق المحادثة. إذا كان السؤال الحالي تابعاً لسؤال سابق، فافهمه من سجل المحادثة.
- إذا لم تجد إجابة كافية في المصادر المتاحة، أجب بالضبط بهذا النص فقط: "__PENDING__"
- لا تكشف هويتك أو من طوّرك.
- ابدأ إجابتك مباشرةً بالمعلومة.
- أجب بلغة السائل (عربي أو إنجليزي).
- حلّل وقارن واستنتج عند الحاجة.
- اذكر اسم المصدر في نهاية الإجابة.
- عند تحليل صورة، صفها بدقة واربطها بمجال NARS/SAR.

ملخص المحادثة السابق:
${conversationSummary || "لا يوجد"}

${fullContext ? "المصادر المتاحة:\n\n" + fullContext : "لا توجد مصادر متاحة."}`;

    let userContent;
    if (images && images.length > 0) {
      userContent = [
        ...images.map(imgB64 => ({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: imgB64 }
        })),
        { type: "text", text: safeQuestion }
      ];
    } else {
      userContent = safeQuestion;
    }

    const messages = [
      ...cleanHistory.map(m => ({ role: m.role, content: String(m.content).slice(0, 1200) })),
      { role: "user", content: userContent }
    ];

    const cRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CLAUDE_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 2048,
        system: sys,
        messages
      })
    });

    const cData = await cRes.json();
    if (!cRes.ok) throw new Error("Claude: " + cData?.error?.message);
    const answer = cData.content?.[0]?.text || "لم أتمكن من الإجابة.";

    if (String(answer).trim() === "__PENDING__") {
      await savePendingQuestion();
      await logChat(null, "pending", []);
      return res.status(200).json({ pending: true, answer: null });
    }

    const sources = goodChunks.slice(0, 5).map(c => ({
      file_name: c.file_name,
      category: c.category,
      similarity: c.similarity
    }));
    await logChat(answer, hasGoodResults ? "reference_based" : "ai_assisted", sources);

    return res.status(200).json({ answer, sources });
  } catch (e) {
    console.error("Chat error:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
