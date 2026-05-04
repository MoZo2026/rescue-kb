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
  cors(res);
  if(req.method==='OPTIONS') return res.status(200).end();
  if(!SB_URL||!SB_KEY) return res.status(500).json({error:'Missing Supabase environment variables'});
  try{
    const user=await getAuthUser(req); const profile=await ensureProfile(user); const uid=profile.id; const email=profile.email||user.email||null;
    if(req.method==='GET'){
      const path=isManager(profile)
        ? '/rest/v1/knowledge_shares?select=*&order=created_at.desc&limit=500'
        : `/rest/v1/knowledge_shares?user_id=eq.${encodeURIComponent(uid)}&select=*&order=created_at.desc&limit=200`;
      const shares=await sbFetch(path);
      return res.status(200).json({shares});
    }
    if(req.method==='POST'){
      const {title,content,source_note}=req.body||{};
      if(!String(content||'').trim()) return res.status(400).json({error:'Content is required'});
      const rows=await sbFetch('/rest/v1/knowledge_shares?select=*',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({user_id:uid,user_email:email,title:String(title||'').slice(0,180),content:String(content).slice(0,10000),source_note:String(source_note||'').slice(0,1000),status:'pending'})});
      return res.status(200).json({share:rows[0]});
    }
    if(req.method==='PATCH'){
      if(!isManager(profile)) return res.status(403).json({error:'Instructor/Admin only'});
      const {id,status,admin_comment}=req.body||{};
      if(!id) return res.status(400).json({error:'Missing id'});
      const patch={status,admin_comment:String(admin_comment||'').slice(0,2000),reviewed_by:uid,reviewed_at:new Date().toISOString()};
      const rows=await sbFetch(`/rest/v1/knowledge_shares?id=eq.${encodeURIComponent(id)}&select=*`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify(patch)});
      return res.status(200).json({share:rows[0]});
    }
    return res.status(405).json({error:'Method not allowed'});
  }catch(e){return res.status(401).json({error:e.message});}
};
