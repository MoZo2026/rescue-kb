module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
    if (!r.ok) throw new Error(Array.isArray(data) ? JSON.stringify(data) : (data.message || data.error || JSON.stringify(data)));
    return data;
  }

  function normalizeQuestion(text) {
    return String(text || "")
      .replace(/[؟?!.،,;:]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  try {
    const rows = await sb("/rest/v1/search_analytics?select=search_text,created_at&order=created_at.desc&limit=1000");
    const map = new Map();
    for (const row of rows || []) {
      const q = normalizeQuestion(row.search_text);
      if (!q || q.length < 6) continue;
      const key = q.toLowerCase();
      const item = map.get(key) || { question: q, count: 0, last_asked: row.created_at };
      item.count += 1;
      if (!item.last_asked || new Date(row.created_at) > new Date(item.last_asked)) item.last_asked = row.created_at;
      map.set(key, item);
    }
    const questions = [...map.values()]
      .sort((a, b) => (b.count - a.count) || (new Date(b.last_asked) - new Date(a.last_asked)))
      .slice(0, 20);
    return res.status(200).json({ questions });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
