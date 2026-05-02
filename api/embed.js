module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({error:"Method not allowed"});

  const { file_id, file_name, category, text } = req.body || {};
  if (!file_id || !text) return res.status(400).json({error:"Missing fields"});

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const SB_URL     = process.env.SUPABASE_URL;
  const SB_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!OPENAI_KEY) return res.status(500).json({error:"Missing OPENAI_API_KEY"});
  if (!SB_URL)     return res.status(500).json({error:"Missing SUPABASE_URL"});
  if (!SB_KEY)     return res.status(500).json({error:"Missing SUPABASE_SERVICE_KEY"});

  function splitChunks(text, size=600, overlap=100) {
    const chunks = [];
    const sentences = text.split(/(?<=[.!?\n])\s+/);
    let current = "";
    for (const s of sentences) {
      if (current.length + s.length > size && current.length > 50) {
        chunks.push(current.trim());
        current = current.slice(-overlap) + " " + s;
      } else {
        current += " " + s;
      }
    }
    if (current.trim().length > 30) chunks.push(current.trim());
    return chunks.slice(0, 300);
  }

  const chunks = splitChunks(text);
  if (chunks.length === 0) return res.status(200).json({count:0});

  try {
    // Delete old chunks for this file
    await fetch(
      `${SB_URL}/rest/v1/file_chunks?file_id=eq.${encodeURIComponent(file_id)}`,
      { method:"DELETE", headers:{"apikey":SB_KEY,"Authorization":`Bearer ${SB_KEY}`} }
    );

    // Process in batches of 50
    const batchSize = 50;
    let totalDone = 0;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);

      // OpenAI Embeddings (text-embedding-3-small — 1536 dims, very cheap)
      const oRes = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: batch
        })
      });
      const oData = await oRes.json();
      if (!oRes.ok) throw new Error("OpenAI: " + (oData?.error?.message || oRes.status));

      // Store in Supabase
      const rows = batch.map((chunk, idx) => ({
        file_id,
        file_name,
        category: category || "عام",
        chunk_text: chunk,
        chunk_index: i + idx,
        embedding: `[${oData.data[idx].embedding.join(",")}]`
      }));

      const dbRes = await fetch(`${SB_URL}/rest/v1/file_chunks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SB_KEY,
          "Authorization": `Bearer ${SB_KEY}`,
          "Prefer": "return=minimal"
        },
        body: JSON.stringify(rows)
      });

      if (!dbRes.ok) {
        const err = await dbRes.text();
        throw new Error("DB: " + err.substring(0, 200));
      }
      totalDone += batch.length;
    }

    return res.status(200).json({count: totalDone});
  } catch(e) {
    console.error("Embed error:", e.message);
    return res.status(500).json({error: e.message});
  }
}
