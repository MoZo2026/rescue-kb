module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: "Missing Supabase environment variables" });

  async function sb(path, options = {}) {
    const r = await fetch(`${SB_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "apikey": SB_KEY,
        "Authorization": `Bearer ${SB_KEY}`,
        ...(options.headers || {})
      }
    });
    const data = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(data));
    return data;
  }

  function topWords(rows) {
    const stop = new Set(["ما","هو","هي","في","من","على","عن","الى","إلى","هل","the","is","are","what","how","and","or","of","to","a","an","for"]);
    const map = new Map();
    for (const row of rows || []) {
      const text = String(row.search_text || "").toLowerCase().replace(/[؟?.,،:;()\[\]{}]/g," ");
      for (const w of text.split(/\s+/)) {
        const word = w.trim();
        if (word.length < 3 || stop.has(word)) continue;
        map.set(word, (map.get(word) || 0) + 1);
      }
    }
    return [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([word,count])=>({word,count}));
  }

  function groupCount(rows, key) {
    const map = new Map();
    for (const row of rows || []) {
      const value = row[key] || "غير مصنف";
      map.set(value, (map.get(value) || 0) + 1);
    }
    return [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([name,count])=>({name,count}));
  }

  try {
    const base = await sb("/rest/v1/rpc/get_platform_stats", { method: "POST", body: "{}" });
    const searches = await sb("/rest/v1/search_analytics?select=search_text,category,created_at&order=created_at.desc&limit=500");
    const topics = await sb("/rest/v1/topic_views?select=topic,file_name,created_at&order=created_at.desc&limit=500");
    const chats = await sb("/rest/v1/chat_history?select=confidence,created_at&order=created_at.desc&limit=500");

    return res.status(200).json({
      base,
      topWords: topWords(searches),
      topTopics: groupCount(topics, "topic"),
      topFiles: groupCount(topics, "file_name"),
      answerTypes: groupCount(chats, "confidence")
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
