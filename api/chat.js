module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({error:"Method not allowed"});

  const { question, knowledge } = req.body || {};
  if (!question) return res.status(400).json({error:"No question"});

  const CLAUDE_KEY  = process.env.ANTHROPIC_API_KEY;
  const VOYAGE_KEY  = process.env.VOYAGE_API_KEY;
  const SB_URL      = process.env.SUPABASE_URL;
  const SB_KEY      = process.env.SUPABASE_SERVICE_KEY;

  if (!CLAUDE_KEY || !VOYAGE_KEY || !SB_URL || !SB_KEY)
    return res.status(500).json({error:"Missing environment variables"});

  try {
    // ── 1. Embed the question ──
    const vRes = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${VOYAGE_KEY}`
      },
      body: JSON.stringify({
        model: "voyage-3-lite",
        input: [question],
        input_type: "query"
      })
    });
    const vData = await vRes.json();
    if (!vRes.ok) throw new Error(vData?.detail || "Voyage embedding error");
    const queryEmbedding = vData.data[0].embedding;

    // ── 2. Search relevant chunks from Supabase ──
    const searchRes = await fetch(`${SB_URL}/rest/v1/rpc/search_chunks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SB_KEY,
        "Authorization": `Bearer ${SB_KEY}`
      },
      body: JSON.stringify({
        query_embedding: `[${queryEmbedding.join(",")}]`,
        match_count: 8
      })
    });
    const chunks = await searchRes.json();

    // ── 3. Build context from top chunks ──
    const kbContext = (knowledge || [])
      .map(k => `[${k.category||"عام"}] ${k.title}\n${k.content}`)
      .join("\n\n---\n\n");

    const chunksContext = Array.isArray(chunks) && chunks.length > 0
      ? chunks
          .filter(c => c.similarity > 0.3)
          .map(c => `[${c.file_name} | ${c.category} | صلة: ${(c.similarity*100).toFixed(0)}%]\n${c.chunk_text}`)
          .join("\n\n---\n\n")
      : "";

    const context = [kbContext, chunksContext].filter(Boolean).join("\n\n══════════\n\n");

    // ── 4. Ask Claude Sonnet ──
    const sys = `أنت مساعد تعليمي متخصص حصرياً في مجال الإنقاذ البحري الجوي (Naval Aviation Rescue Swimming — NARS).

قواعدك:
- أجب فقط عن NARS. لأي سؤال خارج هذا المجال قل: "هذا السؤال خارج نطاق تخصصي."
- لا تكشف هويتك أو من طوّرك أو أي معلومات خاصة.
- لا تقدّم نفسك أو تعدّد قدراتك إلا إذا طُلب منك صراحةً.
- ابدأ إجابتك مباشرةً بالمعلومة — بدون أي مقدمة.
- أجب بلغة السائل تلقائياً (عربي أو إنجليزي).
- استخدم قدرات التحليل والمقارنة والاستنتاج عند الحاجة.
- اذكر اسم الملف المصدر بين قوسين في نهاية الإجابة إذا استفدت منه.
- إذا لم تجد الجواب قل ذلك بوضوح ولا تخترع معلومات.

${context
  ? "المعلومات المسترجعة من قاعدة المعرفة (مرتبة حسب الصلة بسؤالك):\n\n" + context
  : "قاعدة المعرفة فارغة حالياً — لم تُرفع ملفات بعد."}`;

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
        messages: [{role:"user", content: question}]
      })
    });

    const cData = await cRes.json();
    if (!cRes.ok) throw new Error(cData?.error?.message || "Claude error");
    return res.status(200).json({answer: cData.content?.[0]?.text || "لم أتمكن من الإجابة."});

  } catch(e) {
    return res.status(500).json({error: e.message});
  }
}
