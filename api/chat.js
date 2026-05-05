module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { question, knowledge, images = [], history = [], conversationSummary = "" } = req.body || {};
  if (!question && (!images || images.length === 0)) return res.status(400).json({ error: "No question" });

  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!CLAUDE_KEY || !OPENAI_KEY || !SB_URL || !SB_KEY) {
    return res.status(500).json({ error: "Missing environment variables" });
  }

  const safeQuestion = String(question || "صف هذه الصورة واشرحها في سياق NARS/SAR").trim();
  const IMAGE_DAILY_LIMIT = 15;
  const quotaMessage = "تم استنفاد الحد اليومي لرفع الصور. سيتاح الرفع مجددًا بعد الساعة 12 ليلًا بتوقيت السعودية.";

  async function getVerifiedUser() {
    const authHeader = req.headers.authorization || req.headers.Authorization || "";
    const token = String(authHeader).startsWith("Bearer ") ? String(authHeader).slice(7) : "";
    if (!token) return { id: null, email: null, role: "guest" };
    try {
      const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${token}` } });
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

  function normalizeText(input) {
    return String(input || "")
      .toLowerCase()
      .replace(/[\u064B-\u065F\u0670]/g, "")
      .replace(/[أإآ]/g, "ا")
      .replace(/ة/g, "ه")
      .replace(/ى/g, "ي")
      .replace(/[_\-\/\\.,:;()\[\]{}]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function simpleTokens(text, max = 12) {
    const stop = new Set([
      "what","are","the","for","from","with","that","this","about","according","إلى","الى","على","عن","من","في","ما","هي","هو","حسب","ماذا","هل","الذي","التي","ذلك","هذه","هذا","and","or","is","a","an","of","in","to"
    ]);
    return normalizeText(text)
      .split(/\s+/)
      .map(t => t.trim())
      .filter(t => t.length >= 3 && !stop.has(t))
      .slice(0, max);
  }

  function sourcePriorityOf(row = {}) {
    const s = normalizeText([row.file_name, row.category, row.document_title, row.original_name, row.name, row.description, row.tags].join(" "));
    if (/\b(crsnf|rsnf|royal saudi naval|saudi naval|naval aviation)\b/.test(s) || s.includes("القوات البحريه")) return 100;
    if (/\b(instructor|trainee guide|course|refresher|pqs|checklist|evaluation)\b/.test(s) || s.includes("معلم") || s.includes("دوره")) return 85;
    if (/\b(opnavinst|natops|u s navy|us navy|naval search and rescue)\b/.test(s)) return 65;
    return 50;
  }

  function buildDocAliases(doc = {}) {
    const raw = [doc.id, doc.name, doc.original_name, doc.file_name, doc.storage_path, doc.category, doc.description, doc.tags].filter(Boolean).map(String);
    const joined = raw.join(" ");
    const aliases = new Set(raw);

    // Filename variants without extension / separators.
    raw.forEach(v => {
      const base = v.split("/").pop().replace(/\.[a-z0-9]+$/i, "");
      aliases.add(base);
      aliases.add(base.replace(/[_\-]+/g, " "));
      aliases.add(base.replace(/[_\-]+/g, ""));
    });

    // Known instruction-style aliases discovered from filenames or titles.
    const n = normalizeText(joined);
    if (n.includes("crsnf") && n.includes("3710") && n.includes("7b")) {
      ["CRSNF 3710.7B", "CRSNF INST 3710.7B", "CRSNF_INST_3710_7B", "CRSNF Instruction 3710.7B", "General Flight Operating Instruction", "General Flight and Operating Instruction", "3710.7B"].forEach(a => aliases.add(a));
    }
    if (n.includes("opnavinst") && n.includes("3130") && n.includes("6f")) {
      ["OPNAVINST 3130.6F", "OPNAV 3130.6F", "NAVAL SEARCH AND RESCUE STANDARDIZATION PROGRAM", "3130.6F"].forEach(a => aliases.add(a));
    }
    return [...aliases].map(a => normalizeText(a)).filter(a => a.length >= 3);
  }

  function sourceCuePresent(q) {
    const n = normalizeText(q);
    return /\b(according to|from|in|under|per|pursuant to)\b/.test(n) || n.includes("حسب") || n.includes("وفقا") || n.includes("وفق") || n.includes("من مرجع") || n.includes("في مرجع");
  }

  function detectSourceConstraint(query, docs) {
    const nq = normalizeText(query);
    let best = null;
    for (const doc of docs) {
      const aliases = buildDocAliases(doc);
      let score = 0;
      for (const a of aliases) {
        if (!a || a.length < 3) continue;
        if (nq.includes(a)) score = Math.max(score, Math.min(100, a.length));
        // Instruction number fuzzy support: CRSNF ... 3710 ... 7B / OPNAV ... 3130 ... 6F
        if (a.includes("crsnf") && a.includes("3710") && a.includes("7b") && /crsnf.*3710.*7b|3710.*7b.*crsnf/.test(nq)) score = Math.max(score, 95);
        if (a.includes("opnavinst") && a.includes("3130") && a.includes("6f") && /opnav.*3130.*6f|3130.*6f.*opnav/.test(nq)) score = Math.max(score, 95);
      }
      if (score > (best?.score || 0)) best = { doc, score };
    }
    if (best && best.score >= 6) return best;
    if (sourceCuePresent(query)) return { doc: null, score: 0, unresolved: true };
    return null;
  }

  async function getDocuments() {
    try {
      const r = await sbFetch("/rest/v1/file_metadata?select=id,name,original_name,category,description,tags,storage_path,created_at&limit=1000&order=created_at.desc");
      const d = await r.json();
      return Array.isArray(d) ? d.map(x => ({ ...x, file_name: x.original_name || x.name })) : [];
    } catch (_) {
      return [];
    }
  }

  function quotePostgrestValue(v) {
    return String(v || "").replace(/"/g, "");
  }

  async function fetchChunksForDoc(doc, limit = 1000) {
    const vals = [doc.id, doc.name, doc.original_name, doc.file_name].filter(Boolean).map(quotePostgrestValue);
    const exact = vals.flatMap(v => [`file_id.eq.${v}`, `file_name.eq.${v}`]);
    const baseName = String(doc.original_name || doc.name || doc.file_name || "").split("/").pop().replace(/\.[a-z0-9]+$/i, "");
    const strongTokens = simpleTokens(baseName, 6).filter(t => t.length >= 4);
    let chunks = [];

    if (exact.length) {
      try {
        const r = await sbFetch(`/rest/v1/file_chunks?or=(${exact.map(encodeURIComponent).join(",")})&select=file_id,file_name,category,chunk_text,chunk_index&limit=${limit}&order=chunk_index.asc`);
        const d = await r.json();
        if (Array.isArray(d)) chunks = d;
      } catch (_) {}
    }

    // Fallback: filename token search if exact ID/name does not match older index records.
    if (chunks.length === 0 && strongTokens.length) {
      for (const tok of strongTokens.slice(0, 3)) {
        try {
          const r = await sbFetch(`/rest/v1/file_chunks?file_name=ilike.*${encodeURIComponent(tok)}*&select=file_id,file_name,category,chunk_text,chunk_index&limit=${limit}&order=chunk_index.asc`);
          const d = await r.json();
          if (Array.isArray(d) && d.length) { chunks = d; break; }
        } catch (_) {}
      }
    }
    return chunks;
  }

  function scoreChunkByTerms(chunk, query, extra = {}) {
    const text = normalizeText([chunk.file_name, chunk.category, chunk.chunk_text].join(" "));
    const qTokens = simpleTokens(query, 20);
    let score = 0;
    for (const t of qTokens) if (text.includes(t)) score += 1;
    const nq = normalizeText(query);
    const phrases = makePhraseCandidates(query).map(normalizeText);
    for (const p of phrases) if (p.length >= 10 && text.includes(p)) score += 4;
    if (nq.includes("rescue helicopters operating over water") && text.includes("rescue helicopters operating over water")) score += 10;
    if (text.includes("water entry") && (nq.includes("over water") || nq.includes("rescue helicopter"))) score += 4;
    if (text.includes("rescue vehicle over water")) score += 6;
    score += (sourcePriorityOf(chunk) / 100) * (extra.sourceBoost ? 3 : 1.5);
    return score;
  }

  function makePhraseCandidates(query) {
    const n = normalizeText(query);
    const out = new Set();
    const quoted = String(query).match(/["“”](.*?)["“”]/g) || [];
    quoted.forEach(x => out.add(x.replace(/["“”]/g, "")));
    if (n.includes("rescue helicopters operating over water")) out.add("rescue helicopters operating over water");
    if (n.includes("operating over water")) out.add("operating over water");
    if (n.includes("water entry")) out.add("water entry");
    const toks = simpleTokens(query, 12);
    for (let size = Math.min(6, toks.length); size >= 3; size--) {
      for (let i = 0; i <= toks.length - size; i++) out.add(toks.slice(i, i + size).join(" "));
    }
    return [...out].filter(Boolean).slice(0, 10);
  }

  async function keywordSearchAll(query, limit = 40) {
    const phrases = makePhraseCandidates(query);
    const results = [];
    const seen = new Set();
    for (const phrase of phrases) {
      if (!phrase || normalizeText(phrase).length < 8) continue;
      try {
        const r = await sbFetch(`/rest/v1/file_chunks?chunk_text=ilike.*${encodeURIComponent(phrase)}*&select=file_id,file_name,category,chunk_text,chunk_index&limit=20`);
        const d = await r.json();
        if (Array.isArray(d)) {
          for (const c of d) {
            const key = `${c.file_id}|${c.chunk_index}|${c.file_name}`;
            if (!seen.has(key)) { seen.add(key); results.push({ ...c, keyword_score: scoreChunkByTerms(c, query, { sourceBoost: true }) }); }
          }
        }
      } catch (_) {}
    }
    return results.sort((a,b) => (b.keyword_score || 0) - (a.keyword_score || 0)).slice(0, limit);
  }

  function dedupeChunks(chunks) {
    const seen = new Set();
    const out = [];
    for (const c of chunks || []) {
      const key = `${c.file_id || ""}|${c.file_name || ""}|${c.chunk_index ?? ""}|${String(c.chunk_text || "").slice(0,60)}`;
      if (!seen.has(key)) { seen.add(key); out.push(c); }
    }
    return out;
  }

  function rerankChunks(chunks, query, strictDoc = null) {
    return dedupeChunks(chunks).map(c => {
      const semantic = Number(c.similarity || 0);
      const keyword = Number(c.keyword_score || scoreChunkByTerms(c, query));
      const priority = sourcePriorityOf(c) / 100;
      const strictBonus = strictDoc ? 3 : 0;
      const final_score = semantic * 75 + keyword * 5 + priority * 20 + strictBonus;
      return { ...c, final_score, source_priority: sourcePriorityOf(c) };
    }).sort((a,b) => (b.final_score || 0) - (a.final_score || 0));
  }

  async function logSearch(text) {
    try {
      await sbFetch("/rest/v1/search_analytics", {
        method: "POST",
        headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({ user_id: userId, user_email: userEmail, search_text: text, normalized_text: text.toLowerCase(), category: "chat", result_type: "pending" })
      });
    } catch (_) {}
  }

  async function logChat(answer, confidence, sources = []) {
    try {
      await sbFetch("/rest/v1/chat_history", {
        method: "POST",
        headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({ user_id: userId, user_email: userEmail, question: safeQuestion, answer, sources, confidence })
      });
    } catch (_) {}
  }

  async function savePendingQuestion(reason = "pending") {
    try {
      await sbFetch("/rest/v1/pending_questions", {
        method: "POST",
        headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({ question: safeQuestion, answered: false, user_id: userId, user_email: userEmail, status: "pending", category: reason })
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
    if (imageCount > remaining) return { ok: false, used, remaining };
    const rows = images.map((img, idx) => ({ user_id: userId, user_email: userEmail, image_name: `chat-image-${Date.now()}-${idx + 1}.jpg`, image_size: Math.ceil(String(img || "").length * 0.75) }));
    await sbFetch("/rest/v1/image_upload_logs", { method: "POST", headers: { "Prefer": "return=minimal" }, body: JSON.stringify(rows) });
    return { ok: true, used: used + imageCount, remaining: remaining - imageCount };
  }

  async function findApprovedOrFaq() {
    const tokens = simpleTokens(safeQuestion);
    const key = encodeURIComponent(tokens[0] || safeQuestion.slice(0, 50));
    if (!key) return null;
    try {
      const aRes = await sbFetch(`/rest/v1/approved_answers?is_active=eq.true&or=(question.ilike.*${key}*,tags.ilike.*${key}*)&select=id,question,answer,category,source_file,source_page&limit=1`);
      const aData = await aRes.json();
      if (Array.isArray(aData) && aData.length) return { type: "approved_answer", item: aData[0] };
    } catch (_) {}
    try {
      const fRes = await sbFetch(`/rest/v1/faq_items?is_active=eq.true&or=(question.ilike.*${key}*,tags.ilike.*${key}*)&select=id,question,answer,category&limit=1`);
      const fData = await fRes.json();
      if (Array.isArray(fData) && fData.length) return { type: "faq", item: fData[0] };
    } catch (_) {}
    return null;
  }

  function requestedComparison(q) {
    const n = normalizeText(q);
    return n.includes("compare") || n.includes("comparison") || n.includes("قارن") || n.includes("مقارنه") || n.includes("مقارنة");
  }

  function unsupportedSpecifiedSourceAnswer(langArabic = true) {
    return langArabic
      ? "لا توجد معلومة كافية في المرجع المحدد."
      : "I could not find enough information in the specified source.";
  }

  function sourceNotFoundAnswer(langArabic = true) {
    return langArabic
      ? "لم أجد المرجع المحدد داخل قاعدة المعرفة الحالية."
      : "I could not find the specified source in the knowledge base.";
  }

  function likelyArabic(text) { return /[\u0600-\u06FF]/.test(String(text || "")); }

  try {
    await logSearch(safeQuestion);

    const quota = await checkAndLogImageQuota();
    if (!quota.ok) {
      await logChat(quotaMessage, "quota_exceeded", []);
      return res.status(200).json({ answer: quotaMessage, quotaExceeded: true, pending: false });
    }

    // Approved answers and FAQ remain first only when the user did not explicitly constrain the source.
    const documents = await getDocuments();
    const constraint = detectSourceConstraint(safeQuestion, documents);
    const hasExplicitSource = !!(constraint && (constraint.doc || constraint.unresolved));

    if ((!images || images.length === 0) && !hasExplicitSource) {
      const cached = await findApprovedOrFaq();
      if (cached?.item?.answer) {
        const srcFile = cached.item.source_file || (cached.type === "approved_answer" ? "إجابة معتمدة من المسؤول" : "الأسئلة الشائعة");
        const srcPage = cached.item.source_page || "غير محدد";
        const answer = `الإجابة:\n${cached.item.answer}\n\nالمصدر:\n- اسم الملف: ${srcFile}\n- الصفحة: ${srcPage}\n- القسم: ${cached.item.category || "غير محدد"}\n\nدرجة الثقة:\nعالية\n\nملاحظة:\nإذا لم تظهر المعلومة في المراجع، لن يتم افتراضها.`;
        await logChat(answer, cached.type, [{ type: cached.type, id: cached.item.id, file_name: srcFile, page: srcPage, category: cached.item.category || null }]);
        return res.status(200).json({ answer, sourceType: cached.type });
      }
    }

    // If a source is explicitly requested but not found, do not answer from a different source.
    if (constraint?.unresolved && !constraint.doc) {
      const msg = sourceNotFoundAnswer(likelyArabic(safeQuestion));
      await logChat(msg, "specified_source_not_found", []);
      return res.status(200).json({ answer: msg, sources: [], specifiedSourceNotFound: true });
    }

    const cleanHistory = Array.isArray(history) ? history.filter(m => m && (m.role === "user" || m.role === "assistant") && m.content).slice(-12) : [];
    const recentUserContext = cleanHistory.slice(-6).map(m => `${m.role === "user" ? "User" : "Assistant"}: ${String(m.content).slice(0, 700)}`).join("\n");
    const contextualQuestion = [
      conversationSummary ? `Conversation summary:\n${String(conversationSummary).slice(-2500)}` : "",
      recentUserContext ? `Recent conversation:\n${recentUserContext}` : "",
      `Current question:\n${safeQuestion}`
    ].filter(Boolean).join("\n\n");

    let selectedChunks = [];
    let retrievalMode = "general";
    let specifiedDoc = constraint?.doc || null;

    // Source-constrained retrieval: search ONLY inside the matched document unless comparison is requested.
    if (specifiedDoc && !requestedComparison(safeQuestion)) {
      retrievalMode = "source_constrained";
      const docChunks = await fetchChunksForDoc(specifiedDoc, 1000);
      selectedChunks = rerankChunks(docChunks, safeQuestion, specifiedDoc).filter(c => Number(c.final_score || 0) >= 6).slice(0, 8);
      if (selectedChunks.length === 0) {
        const msg = unsupportedSpecifiedSourceAnswer(likelyArabic(safeQuestion));
        await logChat(msg, "specified_source_no_answer", [{ file_name: specifiedDoc.original_name || specifiedDoc.name || specifiedDoc.file_name || null }]);
        return res.status(200).json({ answer: msg, sources: [], specifiedSource: specifiedDoc.original_name || specifiedDoc.name || null });
      }
    } else {
      // General retrieval: combine vector search with keyword phrase search, then rerank by official/local source priority.
      const oRes = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({ model: "text-embedding-3-small", input: [contextualQuestion.slice(-7000)] })
      });
      const oData = await oRes.json();
      if (!oRes.ok) throw new Error("OpenAI: " + oData?.error?.message);
      const queryEmbedding = oData.data[0].embedding;

      const searchRes = await sbFetch("/rest/v1/rpc/search_chunks", { method: "POST", body: JSON.stringify({ query_embedding: `[${queryEmbedding.join(",")}]`, match_count: 30 }) });
      const vectorChunks = await searchRes.json();
      const goodVectorChunks = Array.isArray(vectorChunks) ? vectorChunks.filter(c => Number(c.similarity || 0) >= 0.25) : [];
      const keywordChunks = await keywordSearchAll(safeQuestion, 40);
      selectedChunks = rerankChunks([...goodVectorChunks, ...keywordChunks], safeQuestion, null).slice(0, 10);
    }

    const kbCtx = (knowledge || []).map(k => `[${k.category || "عام"}] ${k.title}\n${k.content}`).join("\n\n---\n\n");
    const chunksCtx = selectedChunks.length > 0
      ? selectedChunks.map((c, i) => `[SOURCE ${i + 1}]\nFile: ${c.file_name || "غير محدد"}\nPage: ${c.page || c.page_number || "غير محدد"}\nSection/Category: ${c.section || c.category || "عام"}\nChunk: ${c.chunk_index ?? "غير محدد"}\nSource priority: ${c.source_priority || sourcePriorityOf(c)}\nRetrieval mode: ${retrievalMode}\nText:\n${c.chunk_text}`).join("\n\n---\n\n")
      : "";
    const fullContext = [kbCtx, chunksCtx].filter(Boolean).join("\n\n══════════\n\n");

    if (!fullContext || selectedChunks.length === 0) {
      const noSourceAnswer = "لا توجد معلومة كافية في قاعدة المعرفة الحالية للإجابة بدقة.";
      await logChat(noSourceAnswer, "unsupported_no_source", []);
      return res.status(200).json({ pending: false, answer: noSourceAnswer, sources: [] });
    }

    const specifiedSourceInstruction = specifiedDoc && !requestedComparison(safeQuestion)
      ? `\nتنبيه إلزامي: المستخدم طلب مرجعًا محددًا. أجب فقط من هذا المرجع: ${specifiedDoc.original_name || specifiedDoc.name || specifiedDoc.file_name}. تجاهل أي مصدر آخر.`
      : "";

    const sys = `أنت مساعد قاعدة معرفة متخصص في Aviation Rescue Swimmer / NARS / SAR.

قواعدك الإلزامية:
- أجب فقط من نصوص المصادر المرفوعة أو الإجابات المعتمدة المعروضة لك في هذا الطلب.
- لا تستخدم معرفة عامة خارج المصادر.
- إذا سمّى المستخدم مصدرًا محددًا، أجب فقط من ذلك المصدر ولا تستبدله بمصدر آخر إلا إذا طلب المقارنة صراحة.
- إذا كان المصدر المحدد لا يدعم الإجابة بوضوح، أجب بأن المرجع المحدد لا يحتوي معلومة كافية.
- لا تخترع إجراءات أو حدودًا أو قوائم فحص أو إجراءات طوارئ أو معايير تشغيلية.
- أجب فقط عن NARS / Aviation Rescue Swimmer / SAR. لأي سؤال خارج المجال قل: "هذا السؤال خارج نطاق قاعدة المعرفة الحالية."
- إذا تعارضت المصادر، اذكر التعارض وفضّل الأحدث أو المحلي/الرسمي إذا ظهر ذلك من المصدر.
- أجب بلغة السائل.
- اجعل الإجابة مختصرة وتعليمية.
- لا تذكر مصطلحات تقنية مثل RAG أو embeddings أو chunks للمستخدم.
- عند تحليل صورة، لا تفترض حقائق تشغيلية غير ظاهرة أو غير مدعومة بالنصوص.
${specifiedSourceInstruction}

صيغة الإجابة الإلزامية بالعربية:
الإجابة:
...

المصدر:
- اسم الملف:
- الصفحة:
- القسم:

درجة الثقة:
عالية / متوسطة / منخفضة

ملاحظة:
إذا لم تظهر المعلومة في المراجع، لن يتم افتراضها.

Mandatory English format if the user asks in English:
Answer:
...

Source:
- File name:
- Page:
- Section:

Confidence:
High / Medium / Low

Note:
If the information is not available in the uploaded references, it will not be assumed.

ملخص المحادثة السابق:
${conversationSummary || "لا يوجد"}

المصادر المتاحة:

${fullContext}`;

    const userContent = images && images.length > 0
      ? [...images.map(imgB64 => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgB64 } })), { type: "text", text: safeQuestion }]
      : safeQuestion;

    const messages = [...cleanHistory.map(m => ({ role: m.role, content: String(m.content).slice(0, 1200) })), { role: "user", content: userContent }];

    const cRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 2048, system: sys, messages })
    });
    const cData = await cRes.json();
    if (!cRes.ok) throw new Error("Claude: " + cData?.error?.message);
    const answer = cData.content?.[0]?.text || "لم أتمكن من الإجابة.";

    const sources = selectedChunks.slice(0, 5).map(c => ({
      file_name: c.file_name,
      page: c.page || c.page_number || null,
      section: c.section || c.category || null,
      chunk_index: c.chunk_index ?? null,
      similarity: c.similarity || null,
      source_priority: c.source_priority || sourcePriorityOf(c),
      retrieval_mode: retrievalMode
    }));
    await logChat(answer, retrievalMode === "source_constrained" ? "source_constrained" : "reference_based", sources);
    return res.status(200).json({ answer, sources, retrievalMode, specifiedSource: specifiedDoc ? (specifiedDoc.original_name || specifiedDoc.name || null) : null });
  } catch (e) {
    console.error("Chat error:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
