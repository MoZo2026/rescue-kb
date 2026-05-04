module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const DAILY_LIMIT = 15;

  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: "Missing Supabase environment variables" });

  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/count_today_images_riyadh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SB_KEY,
        "Authorization": `Bearer ${SB_KEY}`
      },
      body: "{}"
    });
    const count = Number(await r.json() || 0);
    return res.status(200).json({
      limit: DAILY_LIMIT,
      used: count,
      remaining: Math.max(0, DAILY_LIMIT - count),
      timezone: "Asia/Riyadh",
      reset: "00:00 Asia/Riyadh"
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
