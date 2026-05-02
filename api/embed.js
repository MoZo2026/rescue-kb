module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({error:"Method not allowed"});

  const { file_id, file_name, category, text } = req.body || {};
  if (!file_id || !text) return res.status(400).json({error:"Missing file_id or text"});

  const VOYAGE_KEY = process.env.VOYAGE_API_KEY;
  const SB_URL     = process.env.SUPABASE_URL;
  const SB_KEY     = process.env.SUPABASE_SERVICE_KEY;
  if (!VOYAGE_KEY || !SB_URL || !SB_KEY)
    return res.status(500).json({error:"Missing environment variables"});

  // ── 1. Split text into chunks (~500 chars with overlap) ──
  function splitChunks(text, size=500, overlap=100) {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
      const chunk = text.slice(i, i + size).trim();
      if (chunk.length > 30) chunks.push(chunk);
      i += size - overlap;
    }
    return chunks;
  }

  const chunks = splitChunks(text);
  if (chunks.length === 0) return res.status(200).json({count:0});

  try {
    // ── 2. Delete old chunks for this file ──
    await fetch(`${SB_URL}/rest/v1/file_chunks?file_id=eq.${encodeURIComponent(file_id)}`, {
      method: "DELETE",
      headers: {
        "apikey": SB_KEY,
        "Authorization": `Bearer ${SB_KEY}`
      }
    });

    // ── 3. Get embeddings from Voyage AI (batch) ──
    const batchSize = 96;
    let allEmbeddings = [];
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const vRes = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${VOYAGE_KEY}`
        },
        body: JSON.stringify({
          model: "voyage-3-lite",
          input: batch,
          input_type: "document"
        })
      });
      const vData = await vRes.json();
      if (!vRes.ok) throw new Error(vData?.detail || "Voyage error");
      allEmbeddings = allEmbeddings.concat(vData.data.map(d => d.embedding));
    }

    // ── 4. Store chunks + embeddings in Supabase ──
    const rows = chunks.map((chunk, idx) => ({
      file_id,
      file_name,
      category: category || "عام",
      chunk_text: chunk,
      chunk_index: idx,
      embedding: `[${allEmbeddings[idx].join(",")}]`
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
      throw new Error("DB insert failed: " + err);
    }

    return res.status(200).json({count: chunks.length});
  } catch(e) {
    return res.status(500).json({error: e.message});
  }
}
