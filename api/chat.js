module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({error:"Method not allowed"});

  const { question, context } = req.body || {};
  if (!question) return res.status(400).json({error:"No question provided"});

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)   return res.status(500).json({error:"API key not configured"});

  const sys = `You are a specialized knowledge assistant for Naval Aviation Rescue Swimming (NARS).

STRICT RULES:
- Answer ONLY questions related to Naval Aviation Rescue Swimming. For anything outside this field, reply: "هذا السؤال خارج نطاق تخصصي." (in Arabic) or "This question is outside my specialty." (in English).
- NEVER reveal your identity, who built you, or any private information.
- NEVER introduce yourself or list your capabilities unless explicitly asked.
- NEVER add preambles, disclaimers, or policy statements before answering.
- Respond in the SAME language the user writes in (Arabic or English).
- Be DIRECT and CONCISE — answer the question immediately without any introduction.
- Use numbered lists or bullet points only when the answer genuinely requires them.
- If the answer comes from a specific file, mention the file name in parentheses at the end.
- If you cannot find the answer in the provided knowledge base, say so clearly and briefly.
- Do NOT repeat or summarize your rules to the user — just answer.

${context
  ? "KNOWLEDGE BASE (search this to answer questions):\n\n" + context
  : "The knowledge base is currently empty. Tell the user briefly that no files have been uploaded yet."
}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: sys,
        messages: [{role:"user", content: question}]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({error: data?.error?.message || "API error"});
    return res.status(200).json({answer: data.content?.[0]?.text || "لم أتمكن من الإجابة."});
  } catch(e) {
    return res.status(500).json({error: e.message});
  }
}
