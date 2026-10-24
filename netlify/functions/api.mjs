import {getStore} from '@netlify/blobs';
import {createHmac,createHash,randomUUID,randomInt,randomBytes,createCipheriv,createDecipheriv,hkdfSync,timingSafeEqual} from 'node:crypto';
import nodemailer from 'nodemailer';
const E=process.env,SECRET=E.SESSION_SECRET||'',DOM=(E.ALLOWED_DOMAIN||'iitr.ac.in').toLowerCase(),ADM=(E.ADMIN_EMAILS||'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
const st=()=>getStore({name:'budfin',consistency:'strong'});
const json=(o,s=200,h={})=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json','cache-control':'no-store',...h}});
const err=(m,s=400)=>json({error:m},s);
const sha=s=>createHash('sha256').update(s).digest('hex'),sign=p=>createHmac('sha256',SECRET).update(p).digest('base64url'),uidOf=e=>sha('u:'+e).slice(0,16);
const mint=email=>{const p=Buffer.from(JSON.stringify({e:email,x:Date.now()+30*864e5})).toString('base64url');return p+'.'+sign(p)};
function who(req){const m=/(?:^|;\s*)bf=([^;]+)/.exec(req.headers.get('cookie')||'');if(!m||!SECRET)return null;const [p,s]=m[1].split('.');if(!p||!s)return null;const a=Buffer.from(sign(p)),b=Buffer.from(s);if(a.length!=b.length||!timingSafeEqual(a,b))return null;let o;try{o=JSON.parse(Buffer.from(p,'base64url'))}catch{return null}if(o.x<Date.now())return null;return{email:o.e,id:uidOf(o.e),admin:ADM.includes(o.e)}}
const COLS=['profiles','groups','members','ideas','ideaIn','ideaReq','replies','lf','meetups','reports','config','friends'],BYF=['groups','ideas','replies','lf','meetups','reports'],UF=['members','ideaIn'];
const ASK=['resume','skills','avail','exp','why'],FRESH=15*6e4,PRES=15e4;
const key=(c,id,g)=>c=='msgs'?`msgs/${g}/${id}`:`${c}/${id}`;
async function rows(pre){const s=st(),{blobs}=await s.list({prefix:pre});const r=await Promise.all(blobs.slice(0,600).map(async b=>{const d=await s.get(b.key,{type:'json'});return d&&{id:b.key.split('/').pop(),...d}}));return r.filter(Boolean)}
// ---- location privacy: coordinates are stored only as AES-256-GCM ciphertext and never sent to any client ----
const H3=108e5,clampR=v=>{v=+v;return Number.isFinite(v)&&v>0?Math.min(2000,Math.max(100,Math.round(v/50)*50)):500},clampG=v=>{v=+v;return Number.isFinite(v)&&v>0?Math.min(5000,Math.max(100,Math.round(v/50)*50)):500};
const LKEY=()=>Buffer.from(hkdfSync('sha256',Buffer.from(E.LOCATION_KEY||SECRET),Buffer.alloc(0),'budfin-loc-v1',32));
const enc=o=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',LKEY(),iv),ct=Buffer.concat([c.update(JSON.stringify(o),'utf8'),c.final()]);return 'v1.'+Buffer.concat([iv,c.getAuthTag(),ct]).toString('base64url')};
const dec=t=>{try{const b=Buffer.from(String(t).slice(3),'base64url'),d=createDecipheriv('aes-256-gcm',LKEY(),b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8'))}catch{return null}};
const meters=(a,b)=>{const r=Math.PI/180,h=Math.sin((b.a-a.a)*r/2)**2+Math.cos(a.a*r)*Math.cos(b.a*r)*Math.sin((b.o-a.o)*r/2)**2;return 12742e3*Math.asin(Math.sqrt(h))};
async function profilesFor(me){const s=st(),raw=await rows('profiles/'),now=Date.now();
 for(const p of raw){let ch=0;
  if(p.lat!=null||p.lng!=null){if(typeof p.lat=='number'&&typeof p.lng=='number'&&!p.loc)p.loc=enc({a:Math.round(p.lat*1e5)/1e5,o:Math.round(p.lng*1e5)/1e5});delete p.lat;delete p.lng;ch=1}
  if(p.loc&&now-(p.seen||0)>H3){delete p.loc;p.ready=0;ch=1}
  if(ch){const{id,...doc}=p;await s.setJSON('profiles/'+id,doc)}}
 const mp=raw.find(p=>p.id==me.id),mine=mp&&mp.loc?dec(mp.loc):null,myR=clampR(mp&&mp.rad),hideFrom=new Set((await rows('friends/')).filter(r=>r.st=='rejected'&&r.hd&&r.f==me.id).map(r=>r.t));
 return raw.map(p=>{const{loc,pg,...o}=p;
  o.online=p.on!==0&&now-(pg||0)<PRES?1:0;
  if(p.id==me.id){o.hasLoc=loc?1:0;return o}
  delete o.blk;delete o.hid;delete o.acc;delete o.seen;delete o.on;delete o.grad;delete o.nm;delete o.ob;
  if(mine&&p.ready&&p.on!==0&&loc&&now-(p.seen||0)<FRESH){const q=dec(loc);if(q){const d=meters(mine,q);if(d<=Math.min(myR,clampR(p.rad)))o.d=Math.round(d)}}
  if(hideFrom.has(p.id))delete o.d;
  return o})}
async function groupsFor(me,col='groups'){const raw=await rows(col+'/'),mp=await st().get('profiles/'+me.id,{type:'json'}),mine=mp&&mp.loc&&Date.now()-(mp.seen||0)<=H3?dec(mp.loc):null;
 return raw.map(g=>{const{loc,kk,...o}=g;if(kk&&kk.includes(me.id))o.kd=1;if(mine&&loc){const q=dec(loc);if(q)o.d=Math.round(meters(mine,q))}return o})}
async function frFor(me){const all=await rows('friends/');return me.admin?all:all.filter(r=>r.f==me.id||r.t==me.id)}
const nname=n=>{const t=String(n||'').toLowerCase().normalize('NFKC'),k=t.replace(/[^\p{L}\p{N}]+/gu,'');return k||t.trim()};
async function uniqTeam(t,gid){const base=String(t||'Team').trim().slice(0,70)||'Team',taken=new Set((await rows('groups/')).filter(g=>g.id!=gid).map(g=>nname(g.n)));if(!taken.has(nname(base)))return base;let i=1,n;do{n=base+' · Team'+(i>1?' '+i:'');i++}while(taken.has(nname(n)));return n}
async function reqFor(me){const all=await rows('ideaReq/');if(me.admin)return all;const mine=new Set((await rows('ideas/')).filter(i=>i.by==me.id).map(i=>i.id));return all.filter(r=>r.u==me.id||mine.has(r.i))}
async function inboxFor(me){const s=st(),{blobs}=await s.list({prefix:'chatmeta/'}),mem=new Set((await s.list({prefix:'members/'})).blobs.filter(b=>b.key.endsWith('_'+me.id)).map(b=>b.key.slice(8,-me.id.length-1)));
 const keys=blobs.map(b=>b.key).filter(k=>{const g=k.slice(9);return g.startsWith('dm_')?g.slice(3).split('_').includes(me.id):g.startsWith('g_')&&mem.has(g.slice(2))});
 return(await Promise.all(keys.slice(0,200).map(async k=>{const d=await s.get(k,{type:'json'});return d&&{id:k.slice(9),...d}}))).filter(Boolean)}
async function cascade(col,id){const s=st(),wipe=async pre=>{const{blobs}=await s.list({prefix:pre});await Promise.all(blobs.slice(0,500).map(b=>s.delete(b.key)))};
 if(col=='groups'){await wipe('members/'+id+'_');await wipe('msgs/g_'+id+'/');await s.delete('chatmeta/g_'+id);for(const m of await rows('meetups/'))if(m.g==id)await s.delete('meetups/'+m.id)}
 if(col=='ideas'){await s.delete('groups/pg_'+id);await cascade('groups','pg_'+id);await wipe('ideaIn/'+id+'_');await wipe('ideaReq/'+id+'_');for(const r of await rows('replies/'))if(r.i==id)await s.delete('replies/'+r.id)}}
async function purgeSeed(){const s=st();if(await s.get('meta/purged1'))return;
 for(const c of ['groups','ideas','lf'])for(const r of await rows(c+'/'))if(r._o=='seed'||r.by=='seed'){await s.delete(c+'/'+r.id);await cascade(c,r.id)}
 await s.set('meta/purged1','1')}
// ---- login code email: Gmail SMTP (GMAIL_USER + GMAIL_APP_PASSWORD) or Resend ----
async function sendMail(to,code){const subject='Your BudFin code: '+code,text='Your BudFin sign-in code is '+code+'. It expires in 10 minutes. If you did not request it, ignore this email.';
 if(E.GMAIL_USER&&E.GMAIL_APP_PASSWORD){const t=nodemailer.createTransport({host:'smtp.gmail.com',port:465,secure:true,auth:{user:E.GMAIL_USER,pass:E.GMAIL_APP_PASSWORD.replace(/\s+/g,'')}});await t.sendMail({from:'BudFin <'+E.GMAIL_USER+'>',to,subject,text});return 1}
 if(E.RESEND_API_KEY){const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:'Bearer '+E.RESEND_API_KEY,'content-type':'application/json'},body:JSON.stringify({from:E.MAIL_FROM,to:[to],subject,text})});if(!r.ok)throw new Error('Resend '+r.status+' '+(await r.text()).slice(0,200));return 1}
 return 0}
async function canMsg(me,g){if(!/^[\w-]{1,200}$/.test(g))return false;if(g.startsWith('dm_'))return g.slice(3).split('_').includes(me.id);if(g.startsWith('g_'))return !!(await st().get('members/'+g.slice(2)+'_'+me.id));return false}
async function write(me,b){const{op,col}=b;if(![...COLS,'msgs'].includes(col))return err('bad collection');const s=st();let data=b.data&&typeof b.data=='object'?{...b.data}:{};for(const k of Object.keys(data))if(k[0]=='_')delete data[k];if(JSON.stringify(data).length>4000)return err('Too large');
 if(col=='profiles'){for(const k of ['lat','lng','loc','seen','hasLoc','d'])delete data[k];if('rad' in data)data.rad=clampR(data.rad);if('grad' in data)data.grad=clampG(data.grad);if('ready' in data)data.ready=data.ready?1:0;if('on' in data){data.on=data.on?1:0;if(!data.on)data.ready=0}for(const k of ['blk','hid'])if(k in data)data[k]=(Array.isArray(data[k])?data[k]:[]).filter(x=>typeof x=='string'&&/^[\w-]{1,40}$/.test(x)).slice(0,60);delete data.pg;delete data.acc;if('nm' in data)data.nm=String(data.nm||'').slice(0,60);if('al' in data)data.al=String(data.al||'').slice(0,24);if('em' in data)data.em=String(data.em||'🙂').replace(/[<>&"'`\\]/g,'').slice(0,8)||'🙂';if('p' in data)data.p=String(data.p||'').slice(0,30);if('ob' in data)data.ob=data.ob?1:0;if('int' in data)data.int=(Array.isArray(data.int)?data.int:[]).map(x=>String(x).slice(0,30)).slice(0,40)}
 let gloc=null;if(col=='groups'){data.cap=Math.min(200,Math.max(2,Math.round(+data.cap)||8));if('em' in data)data.em=String(data.em||'🎯').replace(/[<>&"'`\\]/g,'').slice(0,8)||'🎯'}
 if(col=='groups'||col=='lf'){const la=+data.lat,ln=+data.lng;if(data.lat!=null&&data.lng!=null&&Math.abs(la)<=90&&Math.abs(ln)<=180)gloc=enc({a:Math.round(la*1e5)/1e5,o:Math.round(ln*1e5)/1e5});for(const k of ['lat','lng','loc','d','kk','kd'])delete data[k];if('ll' in data)data.ll=data.ll?1:0;if('ac' in data)data.ac=Math.min(9999,Math.max(0,Math.round(+data.ac)||0))}
 if(col=='ideas'){if(data.kind!=='plan'){delete data.kind;delete data.ask;delete data.cq}else{data.need=Math.min(200,Math.max(2,Math.round(+data.need)||2));data.ask=(Array.isArray(data.ask)?data.ask:[]).filter(x=>ASK.includes(x)).slice(0,5);data.cq=String(data.cq||'').slice(0,120);if(!data.cq)delete data.cq}}
 if(col=='msgs'){const g=String(data.g||'');if(op!='add'||!await canMsg(me,g))return err('Forbidden',403);const i=randomUUID().slice(0,12);const t=String(data.t||'').slice(0,500),ts=Date.now();await s.setJSON(key('msgs',i,g),{g,u:me.id,t,ts});await s.setJSON('chatmeta/'+g,{u:me.id,t:t.slice(0,120),ts});return json({id:i})}
 const nid=op=='add'?randomUUID().slice(0,12):b.id;if(!/^[\w-]{1,100}$/.test(nid||''))return err('Bad id');const k=key(col,nid),old=await s.get(k,{type:'json'});
 if(col=='friends'){const f=nid.slice(0,16),t=nid.slice(-16);if(nid.length!=33||nid[16]!='_'||f==t)return err('Bad id');
  if(op=='delete'){if(!old)return json({ok:1});if(!(me.admin||old.f==me.id||old.t==me.id))return err('Forbidden',403);if(old.st=='rejected'&&old.f==me.id&&!me.admin)return err('Your request was declined',403);await s.delete(k);return json({ok:1})}
  if(op=='update'){if(!old)return err('Not found',404);if(!(me.admin||old.t==me.id))return err('Only the person who received the request can decide',403);const o={...old};if(data.st=='accepted'||data.st=='rejected'){o.st=data.st;o.dt=Date.now()}if('hd' in data)o.hd=data.hd?1:0;if(o.st!='rejected')o.hd=0;await s.setJSON(k,o);return json({id:nid})}
  if(f!=me.id)return err('Forbidden',403);if(!await s.get('profiles/'+t,{type:'json'}))return err('No such person',404);
  if(old){if(old.st=='rejected')return err('Your request was declined',403);return json({id:nid})}
  const back=await s.get('friends/'+t+'_'+f,{type:'json'});if(back){if(back.st=='accepted')return err('You are already friends');if(back.st=='pending')return err('They already sent you a request. Check Friends.')}
  await s.setJSON(k,{f,t,st:'pending',ts:Date.now(),hd:0,_o:me.id});return json({id:nid})}
 if(op=='delete'){if(!old)return json({ok:1});if(!(me.admin||old._o==me.id))return err('Forbidden',403);if(col=='ideaReq'&&old.st=='rejected'&&!me.admin)return err('Your request was declined',403);await s.delete(k);if(col=='groups'||col=='ideas')await cascade(col,nid);return json({ok:1})}
 if(col=='ideaReq'){const uid=nid.slice(-16),parent=nid.slice(0,-17),ip=nid.length>17&&nid[nid.length-17]=='_'?await s.get('ideas/'+parent,{type:'json'}):null;if(!ip||ip.kind!='plan')return err('No such plan',404);
  if(op=='update'){if(!old)return err('Not found',404);if(!(me.admin||ip._o==me.id||ip.by==me.id))return err('Only the organiser can decide',403);const st2=data.st=='accepted'?'accepted':data.st=='rejected'?'rejected':null;if(!st2)return err('Bad decision');
   if(st2=='accepted'){const cur=(await s.list({prefix:'ideaIn/'+parent+'_'})).blobs;if(ip.need&&cur.length>=ip.need&&!cur.some(b=>b.key.endsWith('_'+uid)))return err('Team is full');await s.setJSON('ideaIn/'+parent+'_'+uid,{i:parent,u:uid,_o:uid});
    {const gid='pg_'+parent,gk='groups/'+gid;let gr=await s.get(gk,{type:'json'});if(!gr){const opf=await s.get('profiles/'+ip.by,{type:'json'});gr={n:await uniqTeam(ip.t,gid),em:'🛠️',p:'Build',act:String(ip.roles||'Team project').slice(0,60),when:String(ip.wh||'Ongoing').slice(0,60),pl:'Team group',cap:Math.min(200,Math.max(2,Math.round(+ip.need)||2)),live:0,int:[],by:ip.by,ts:Date.now(),plan:parent,_o:ip.by};if(opf&&opf.loc)gr.loc=opf.loc;await s.setJSON(gk,gr);await s.setJSON('members/'+gid+'_'+ip.by,{g:gid,u:ip.by,_o:ip.by})}await s.setJSON('members/'+gid+'_'+uid,{g:gid,u:uid,_o:uid})}}
   await s.setJSON(k,{...old,st:st2,dt:Date.now()});return json({id:nid})}
  if(nid.slice(-16)!=me.id||!nid.endsWith('_'+me.id))return err('Forbidden',403);if(ip.by==me.id)return err('You organise this plan');
  if(old&&old.st!='pending')return err(old.st=='accepted'?'Already accepted':'Your request was declined',403);
  const a=data.ans&&typeof data.ans=='object'?data.ans:{},ans={};for(const f of [...(ip.ask||[]),...(ip.cq?['ca']:[])]){const v=String(a[f]||'').trim().slice(0,300);if(!v)return err('Please fill in every requested field');ans[f]=v}
  if(!old&&(await s.list({prefix:'ideaIn/'+parent+'_'+me.id})).blobs.length)return err('You are already in this team');
  await s.setJSON(k,{i:parent,u:me.id,ans,st:'pending',ts:Date.now(),_o:me.id});return json({id:nid})}
 if(col=='config'&&!me.admin)return err('Forbidden',403);if(col=='profiles'&&nid!=me.id)return err('Forbidden',403);
 if(old&&!(me.admin||old._o==me.id))return err('Forbidden',403);if(!old&&op=='update')return err('Not found',404);
 if(old){delete data.by;delete data.u;delete data.g;if(col=='ideas'){delete data.kind;delete data.need;delete data.ask;delete data.cq}}else{
  if(BYF.includes(col))data.by=me.id;
  if(UF.includes(col)){if(!nid.endsWith('_'+me.id))return err('Forbidden',403);data.u=me.id;const parent=nid.slice(0,-me.id.length-1);
   if(col=='members'){const gr=await s.get('groups/'+parent,{type:'json'});if(!gr)return err('No such group');if((gr.kk||[]).includes(me.id))return err('You were removed from this group by its admin',403);if(gr.plan)return err('This team group fills through its recruiting post',403);if((await s.list({prefix:'members/'+parent+'_'})).blobs.length>=gr.cap)return err('Group is full');data.g=parent}else{const ip=await s.get('ideas/'+parent,{type:'json'});if(!ip)return err('No such idea');if(ip.kind=='plan'&&ip.by!=me.id)return err('Send a join request first',403);if(ip.kind=='plan'&&ip.need&&(await s.list({prefix:'ideaIn/'+parent+'_'})).blobs.length>=ip.need)return err('Team is full');data.i=parent}}
  if(col=='meetups'&&!await s.get('members/'+data.g+'_'+me.id))return err('Join the group first',403)}
 if(col=='groups'&&!old)data.ts=Date.now();
 if(col=='groups'&&(!old||'n' in data)){const nn=nname(data.n!=null?data.n:old&&old.n);if(!nn)return err('Give your group a name');const clash=(await rows('groups/')).find(g=>g.id!=nid&&nname(g.n)==nn);if(clash)return err('A group named “'+String(clash.n).slice(0,40)+'” already exists. Pick a different name.',409)}
 if((col=='groups'||col=='lf')&&gloc&&!old)data.loc=gloc;await s.setJSON(k,op=='update'&&old?{...old,...data}:{...data,_o:old?old._o:me.id});
 if(col=='groups'&&!old){const nn=nname(data.n),dup=(await rows('groups/')).filter(g=>g.id!=nid&&nname(g.n)==nn&&((g.ts||0)<data.ts||((g.ts||0)==data.ts&&g.id<nid)));if(dup.length){await s.delete(k);return err('A group with that name was just created. Pick a different name.',409)}}
 return json({id:nid})}
export default async req=>{try{const p=new URL(req.url).pathname.replace(/^\/api\/?/,''),b=req.method=='POST'?await req.json().catch(()=>({})):{};
 if(!SECRET)return err('Server not configured: set SESSION_SECRET',500);const s=st();
 if(p=='auth/request'){const e=String(b.email||'').trim().toLowerCase();if(!/^[^@\s]+@[a-z0-9.-]+$/.test(e)||!(e.endsWith('@'+DOM)||e.endsWith('.'+DOM)))return err('Use your @'+DOM+' email');
  const k='otp/'+uidOf(e),o=await s.get(k,{type:'json'});if(o&&Date.now()-o.t<45e3)return err('Wait a moment before requesting another code',429);
  const code=String(randomInt(1e5,1e6));await s.setJSON(k,{h:sha(code+SECRET+e),x:Date.now()+6e5,n:0,t:Date.now()});
  let sent=0;try{sent=await sendMail(e,code)}catch(x){console.error('mail failed:',x&&x.message);await s.delete(k);return err('Could not send the email. The mail settings on the server need fixing.',502)}
  if(sent)return json({ok:1});
  if(E.DEV_OTP=='1')return json({ok:1,dev:code});await s.delete(k);return err('Email sending is not configured',500)}
 if(p=='auth/verify'){const e=String(b.email||'').trim().toLowerCase(),k='otp/'+uidOf(e),o=await s.get(k,{type:'json'});if(!o||o.x<Date.now()||o.n>=5)return err('Code expired. Request a new one.');
  if(sha(String(b.code||'')+SECRET+e)!=o.h){await s.setJSON(k,{...o,n:o.n+1});return err('Wrong code')}await s.delete(k);
  return json({ok:1},200,{'set-cookie':`bf=${mint(e)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`})}
 if(p=='auth/logout'){const m=who(req);if(m){try{const pk='profiles/'+m.id,o=await s.get(pk,{type:'json'});if(o){const{loc,...r}=o;await s.setJSON(pk,{...r,ready:0,pg:0})}}catch{}}return json({ok:1},200,{'set-cookie':'bf=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'})}
 const me=who(req);if(!me)return err('Sign in required',401);
 if(p=='me')return json({id:me.id,email:me.email,admin:me.admin});
 if(p=='loc'){const pk='profiles/'+me.id,old=await s.get(pk,{type:'json'});if(!old)return err('Profile not ready yet',404);
  if(b.clear){const{loc,...r}=old;await s.setJSON(pk,{...r,ready:0});return json({ok:1})}
  const la=+b.lat,ln=+b.lng;if(!(Math.abs(la)<=90&&Math.abs(ln)<=180)||b.lat==null||b.lng==null)return err('Bad location');
  await s.setJSON(pk,{...old,loc:enc({a:Math.round(la*1e5)/1e5,o:Math.round(ln*1e5)/1e5}),acc:Math.min(9999,Math.max(0,Math.round(+b.acc)||0)),seen:Date.now(),pg:Date.now()});return json({ok:1})}
 if(p=='offline'){const pk='profiles/'+me.id,old=await s.get(pk,{type:'json'});if(old)await s.setJSON(pk,{...old,pg:0});return json({ok:1})}
 if(p=='gloc'){const id=String(b.id||'');if(!/^[\w-]{1,100}$/.test(id))return err('Bad id');const k='groups/'+id,o=await s.get(k,{type:'json'});if(!o)return err('No such group',404);if(!(o._o==me.id||o.by==me.id))return err('Forbidden',403);const la=+b.lat,ln=+b.lng;if(b.lat==null||b.lng==null||!(Math.abs(la)<=90&&Math.abs(ln)<=180))return err('Bad location');await s.setJSON(k,{...o,loc:enc({a:Math.round(la*1e5)/1e5,o:Math.round(ln*1e5)/1e5}),ac:Math.min(9999,Math.max(0,Math.round(+b.acc)||0))});return json({ok:1})}
 if(p=='kick'){const g=String(b.g||''),u=String(b.u||'');if(!/^[\w-]{1,100}$/.test(g)||!/^[\w-]{1,40}$/.test(u))return err('Bad request');const gk='groups/'+g,gr=await s.get(gk,{type:'json'});if(!gr)return err('No such group',404);if(!(me.admin||gr.by==me.id||gr._o==me.id))return err('Only the group admin can remove people',403);if(u==gr.by)return err('The group admin cannot be removed');await s.delete('members/'+g+'_'+u);gr.kk=[...new Set([...(gr.kk||[]),u])].slice(-50);await s.setJSON(gk,gr);if(gr.plan){await s.delete('ideaIn/'+gr.plan+'_'+u);const rk='ideaReq/'+gr.plan+'_'+u,ro=await s.get(rk,{type:'json'});if(ro)await s.setJSON(rk,{...ro,st:'rejected',dt:Date.now()})}return json({ok:1})}
 if(p=='ping'){const pk='profiles/'+me.id,old=await s.get(pk,{type:'json'});if(!old)return json({ok:1});await s.setJSON(pk,{...old,pg:Date.now()});return json({ok:1})}
 if(p=='sync'){await purgeSeed();const out={};for(const c of (b.cols||[]).filter(c=>COLS.includes(c)||c=='inbox'))out[c]=c=='reports'&&!me.admin?[]:c=='profiles'?await profilesFor(me):c=='groups'?await groupsFor(me):c=='lf'?await groupsFor(me,'lf'):c=='ideaReq'?await reqFor(me):c=='friends'?await frFor(me):c=='inbox'?await inboxFor(me):await rows(c+'/');return json(out)}
 if(p=='db'){if(b.op=='list'){const g=String(b.where?.g||'');if(b.col!='msgs'||!await canMsg(me,g))return err('Forbidden',403);return json({rows:(await rows('msgs/'+g+'/')).sort((a,c)=>a.ts-c.ts).slice(-100)})}return write(me,b)}
 return err('Not found',404)}catch(x){return err('Server error',500)}};
export const config={path:'/api/*'};
