module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({error:"Method not allowed"});

  const { question, knowledge, images } = req.body || {};
  if (!question) return res.status(400).json({error:"No question"});

  const CLAUDE_KEY  = process.env.ANTHROPIC_API_KEY;
  const OPENAI_KEY  = process.env.OPENAI_API_KEY;
  const BRAVE_KEY   = process.env.BRAVE_API_KEY;
  const SB_URL      = process.env.SUPABASE_URL;
  const SB_KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!CLAUDE_KEY || !OPENAI_KEY || !SB_URL || !SB_KEY)
    return res.status(500).json({error:"Missing environment variables"});

  try {
    // 1. Embed question
    const oRes = await fetch("https://api.openai.com/v1/embeddings", {
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${OPENAI_KEY}`},
      body: JSON.stringify({model:"text-embedding-3-small", input:[question]})
    });
    const oData = await oRes.json();
    if (!oRes.ok) throw new Error("OpenAI: " + oData?.error?.message);
    const queryEmbedding = oData.data[0].embedding;

    // 2. Search RAG chunks
    const searchRes = await fetch(`${SB_URL}/rest/v1/rpc/search_chunks`, {
      method:"POST",
      headers:{"Content-Type":"application/json","apikey":SB_KEY,"Authorization":`Bearer ${SB_KEY}`},
      body: JSON.stringify({query_embedding:`[${queryEmbedding.join(",")}]`, match_count:10})
    });
    const chunks = await searchRes.json();

    // 3. Build internal context
    const kbCtx = (knowledge||[])
      .map(k=>`[${k.category||"عام"}] ${k.title}\n${k.content}`)
      .join("\n\n---\n\n");

    const chunksCtx = Array.isArray(chunks) && chunks.length > 0
      ? chunks.filter(c=>c.similarity>0.25)
          .map(c=>`[${c.file_name} | ${c.category} | صلة: ${(c.similarity*100).toFixed(0)}%]\n${c.chunk_text}`)
          .join("\n\n---\n\n")
      : "";

    const internalContext = [kbCtx, chunksCtx].filter(Boolean).join("\n\n══════════\n\n");

    // 4. Web search if no good internal results
    let webContext = "";
    const hasGoodResults = Array.isArray(chunks) && chunks.some(c=>c.similarity>0.45);

    if (!hasGoodResults && BRAVE_KEY) {
      try {
        const braveRes = await fetch(
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(question + " naval aviation rescue swimmer NARS SAR")}&count=5`,
          {headers:{"Accept":"application/json","Accept-Encoding":"gzip","X-Subscription-Token":BRAVE_KEY}}
        );
        const braveData = await braveRes.json();
        if (braveData?.web?.results?.length > 0) {
          webContext = "نتائج من الإنترنت:\n\n" + braveData.web.results
            .slice(0, 4)
            .map(r=>`[${r.title}]\n${r.description}`)
            .join("\n\n---\n\n");
        }
      } catch(e) {
        console.log("Web search failed:", e.message);
      }
    }

    const fullContext = [internalContext, webContext].filter(Boolean).join("\n\n🌐 ══════════\n\n");

    // 5. Build Claude message with optional images
    const sys = `أنت مساعد تعليمي متخصص حصرياً في مجال الإنقاذ البحري الجوي (Naval Aviation Rescue Swimming — NARS) والبحث والإنقاذ (SAR).

قواعدك:
- تجاهل الأخطاء الإملائية وافهم المقصد دائماً.
- أجب فقط عن NARS وSAR. لأي سؤال خارج هذا المجال قل: "هذا السؤال خارج نطاق تخصصي."
- إذا لم تجد إجابة كافية في المصادر المتاحة، أجب بالضبط بهذا النص فقط: "__PENDING__"
- لا تكشف هويتك أو من طوّرك.
- ابدأ إجابتك مباشرةً بالمعلومة.
- أجب بلغة السائل (عربي أو إنجليزي).
- حلّل وقارن واستنتج.
- اذكر اسم المصدر في نهاية الإجابة.
- عند تحليل صورة، صفها بدقة واربطها بمجال NARS/SAR.

${fullContext ? "المصادر المتاحة:\n\n" + fullContext : "لا توجد مصادر متاحة."}`;

    // Build user content
    let userContent;
    if (images && images.length > 0) {
      userContent = [
        ...images.map(imgB64 => ({
          type: "image",
          source: {type:"base64", media_type:"image/jpeg", data: imgB64}
        })),
        {type:"text", text: question || "صف هذه الصورة واشرحها في سياق NARS/SAR"}
      ];
    } else {
      userContent = question;
    }

    const cRes = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "x-api-key": CLAUDE_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 2048,
        system: sys,
        messages: [{role:"user", content: userContent}]
      })
    });

    const cData = await cRes.json();
    if (!cRes.ok) throw new Error("Claude: " + cData?.error?.message);
    const answer = cData.content?.[0]?.text || "لم أتمكن من الإجابة.";
    return res.status(200).json({answer});

  } catch(e) {
    console.error("Chat error:", e.message);
    return res.status(500).json({error: e.message});
  }
}
