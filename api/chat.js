module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({error:"Method not allowed"});

  const { question, knowledge } = req.body || {};
  if (!question) return res.status(400).json({error:"No question"});

  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const SB_URL     = process.env.SUPABASE_URL;
  const SB_KEY     = process.env.SUPABASE_SERVICE_KEY;

  if (!CLAUDE_KEY || !OPENAI_KEY || !SB_URL || !SB_KEY)
    return res.status(500).json({error:"Missing environment variables"});

  try {
    // 1. Embed the question with OpenAI
    const oRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {"Content-Type":"application/json","Authorization":`Bearer ${OPENAI_KEY}`},
      body: JSON.stringify({model:"text-embedding-3-small", input:[question]})
    });
    const oData = await oRes.json();
    if (!oRes.ok) throw new Error("OpenAI: " + oData?.error?.message);
    const queryEmbedding = oData.data[0].embedding;

    // 2. Search relevant chunks
    const searchRes = await fetch(`${SB_URL}/rest/v1/rpc/search_chunks`, {
      method: "POST",
      headers: {
        "Content-Type":"application/json",
        "apikey":SB_KEY,
        "Authorization":`Bearer ${SB_KEY}`
      },
      body: JSON.stringify({
        query_embedding: `[${queryEmbedding.join(",")}]`,
        match_count: 10
      })
    });
    const chunks = await searchRes.json();

    // 3. Build context
    const kbCtx = (knowledge||[])
      .map(k=>`[${k.category||"عام"}] ${k.title}\n${k.content}`)
      .join("\n\n---\n\n");

    const chunksCtx = Array.isArray(chunks) && chunks.length > 0
      ? chunks
          .filter(c => c.similarity > 0.25)
          .map(c => `[${c.file_name} | ${c.category} | صلة: ${(c.similarity*100).toFixed(0)}%]\n${c.chunk_text}`)
          .join("\n\n---\n\n")
      : "";

    const context = [kbCtx, chunksCtx].filter(Boolean).join("\n\n══════════\n\n");

    // 4. Ask Claude Sonnet
    const sys = `أنت مساعد تعليمي متخصص حصرياً في مجال الإنقاذ البحري الجوي (Naval Aviation Rescue Swimming — NARS).

قواعدك الصارمة:
- أجب فقط عن NARS. لأي سؤال خارج هذا المجال قل: "هذا السؤال خارج نطاق تخصصي."
- لا تكشف هويتك أو من طوّرك.
- ابدأ إجابتك مباشرةً بالمعلومة — بدون مقدمات.
- أجب بلغة السائل تلقائياً (عربي أو إنجليزي).
- حلّل وقارن واستنتج من المصادر المتاحة.
- اذكر اسم الملف المصدر في نهاية الإجابة.
- إذا لم تجد الجواب قل ذلك بوضوح.

${context
  ? "المعلومات المسترجعة من قاعدة المعرفة:\n\n" + context
  : "قاعدة المعرفة فارغة — لم تُفهرس ملفات بعد."}`;

    const cRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":"application/json",
        "x-api-key": CLAUDE_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 2048,
        system: sys,
        messages: [{role:"user", content: question}]
      })
    });

    const cData = await cRes.json();
    if (!cRes.ok) throw new Error("Claude: " + cData?.error?.message);
    return res.status(200).json({answer: cData.content?.[0]?.text || "لم أتمكن من الإجابة."});

  } catch(e) {
    console.error("Chat error:", e.message);
    return res.status(500).json({error: e.message});
  }
}
