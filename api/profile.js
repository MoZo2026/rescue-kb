module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: "Missing Supabase environment variables" });

  const authHeader = req.headers.authorization || req.headers.Authorization || "";
  const token = String(authHeader).startsWith("Bearer ") ? String(authHeader).slice(7) : "";
  if (!token) return res.status(401).json({ error: "Missing Authorization token" });

  async function sbFetch(path, options = {}) {
    return fetch(`${SB_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "apikey": SB_KEY,
        "Authorization": `Bearer ${SB_KEY}`,
        ...(options.headers || {})
      }
    });
  }

  async function getAuthUser() {
    const r = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { "apikey": SB_KEY, "Authorization": `Bearer ${token}` }
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d?.id) throw new Error(d?.msg || d?.error_description || "Invalid user token");
    return d;
  }

  try {
    const user = await getAuthUser();
    const email = user.email || null;
    const displayNameFromAuth = user.user_metadata?.display_name || (email ? email.split("@")[0] : "User");

    const existingRes = await sbFetch(`/rest/v1/user_profiles?auth_user_id=eq.${encodeURIComponent(user.id)}&select=*&limit=1`);
    let existing = await existingRes.json().catch(() => []);
    let profile = Array.isArray(existing) ? existing[0] : null;

    if (!profile) {
      const insertRes = await sbFetch("/rest/v1/user_profiles?select=*", {
        method: "POST",
        headers: { "Prefer": "return=representation" },
        body: JSON.stringify({
          auth_user_id: user.id,
          email,
          display_name: displayNameFromAuth,
          role: "student",
          status: "active"
        })
      });
      const rows = await insertRes.json().catch(() => []);
      if (!insertRes.ok) return res.status(insertRes.status).json({ error: rows?.message || "Could not create profile" });
      profile = rows[0];
    }

    if (req.method === "POST") {
      const { display_name } = req.body || {};
      const cleanName = String(display_name || "").trim().slice(0, 120) || displayNameFromAuth;
      const updRes = await sbFetch(`/rest/v1/user_profiles?auth_user_id=eq.${encodeURIComponent(user.id)}&select=*`, {
        method: "PATCH",
        headers: { "Prefer": "return=representation" },
        body: JSON.stringify({ display_name: cleanName, email, updated_at: new Date().toISOString() })
      });
      const rows = await updRes.json().catch(() => []);
      if (!updRes.ok) return res.status(updRes.status).json({ error: rows?.message || "Could not update profile" });
      profile = rows[0];
    }

    return res.status(200).json({ user: { id: user.id, email }, profile });
  } catch (e) {
    return res.status(401).json({ error: e.message || "Unauthorized" });
  }
};
