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

  function inferHeading(line) {
    const clean = String(line || "").trim();
    if (!clean) return null;
    const upperRatio = clean.replace(/[^A-Z]/g, "").length / Math.max(1, clean.replace(/[^A-Za-z]/g, "").length);
    if (/^(chapter|section|part|article|appendix|figure|table)\b/i.test(clean)) return clean.slice(0, 180);
    if (/^\d+(\.\d+)*\s+/.test(clean) && clean.length <= 160) return clean;
    if (clean.length <= 90 && upperRatio > 0.65 && /[A-Z]/.test(clean)) return clean;
    if (/^(الفصل|القسم|الباب|المادة|الملحق)\b/.test(clean) && clean.length <= 180) return clean;
    return null;
  }

  function splitChunks(text, size=750, overlap=120) {
    const chunks = [];
    const lines = String(text || "").split(/\n+/);
    let currentHeading = "";
    let buffer = "";

    function pushBuffer() {
      const body = buffer.trim();
      if (body.length > 30) {
        const prefix = [
          file_name ? `File: ${file_name}` : "",
          category ? `Category: ${category}` : "",
          currentHeading ? `Section context: ${currentHeading}` : ""
        ].filter(Boolean).join("\n");
        chunks.push(prefix ? `${prefix}\n\n${body}` : body);
      }
      buffer = "";
    }

    for (const rawLine of lines) {
      const line = String(rawLine || "").trim();
      if (!line) continue;
      const heading = inferHeading(line);
      if (heading) {
        currentHeading = heading;
        if (buffer.length > size * 0.5) pushBuffer();
        buffer += `\n${line}\n`;
        continue;
      }
      if (buffer.length + line.length > size && buffer.length > 80) {
        const tail = buffer.slice(-overlap);
        pushBuffer();
        buffer = currentHeading ? `${currentHeading}\n${tail}\n${line}` : `${tail}\n${line}`;
      } else {
        buffer += ` ${line}`;
      }
    }
    pushBuffer();
    return chunks.slice(0, 400);
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
