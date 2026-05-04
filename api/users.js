const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
function cors(res, methods='GET, POST, PATCH, DELETE, OPTIONS'){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods',methods);
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
}
async function sbFetch(path, options={}){
  const r = await fetch(`${SB_URL}${path}`, { ...options, headers:{ 'Content-Type':'application/json', 'apikey':SB_KEY, 'Authorization':`Bearer ${SB_KEY}`, ...(options.headers||{}) }});
  const data = await r.json().catch(()=>null);
  if(!r.ok) throw new Error(data?.message || data?.error || JSON.stringify(data) || 'Supabase error');
  return data;
}
async function getAuthUser(req){
  const h=req.headers.authorization||req.headers.Authorization||'';
  const token=String(h).startsWith('Bearer ')?String(h).slice(7):'';
  if(!token) throw new Error('Missing Authorization token');
  const r=await fetch(`${SB_URL}/auth/v1/user`,{headers:{'apikey':SB_KEY,'Authorization':`Bearer ${token}`}});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||!d?.id) throw new Error(d?.msg||d?.error_description||'Invalid user token');
  return d;
}
async function ensureProfile(user){
  const rows=await sbFetch(`/rest/v1/user_profiles?auth_user_id=eq.${encodeURIComponent(user.id)}&select=*&limit=1`);
  if(rows?.[0]) return rows[0];
  const email=user.email||null;
  const name=user.user_metadata?.display_name || (email?email.split('@')[0]:'User');
  const ins=await sbFetch('/rest/v1/user_profiles?select=*',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({auth_user_id:user.id,email,display_name:name,role:'student',status:'active'})});
  return ins[0];
}
function isManager(profile){ return ['admin','instructor'].includes(profile?.role); }
function isAdmin(profile){ return profile?.role === 'admin'; }

module.exports = async function handler(req,res){
  cors(res,'GET, PATCH, OPTIONS');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(!SB_URL||!SB_KEY) return res.status(500).json({error:'Missing Supabase environment variables'});
  try{
    const user=await getAuthUser(req); const profile=await ensureProfile(user);
    if(!isAdmin(profile)) return res.status(403).json({error:'Admin only'});
    if(req.method==='GET'){
      const users=await sbFetch('/rest/v1/user_profiles?select=*&order=created_at.desc&limit=500');
      return res.status(200).json({users});
    }
    if(req.method==='PATCH'){
      const {id,role,status,display_name}=req.body||{};
      if(!id) return res.status(400).json({error:'Missing id'});
      const patch={updated_at:new Date().toISOString()};
      if(role) patch.role=role;
      if(status) patch.status=status;
      if(display_name) patch.display_name=String(display_name).slice(0,120);
      const rows=await sbFetch(`/rest/v1/user_profiles?id=eq.${encodeURIComponent(id)}&select=*`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify(patch)});
      return res.status(200).json({profile:rows[0]});
    }
    return res.status(405).json({error:'Method not allowed'});
  }catch(e){return res.status(401).json({error:e.message});}
};
