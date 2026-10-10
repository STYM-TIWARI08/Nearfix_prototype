const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const DATA_DIR = process.env.VERCEL ? path.join('/tmp', 'nearfix-data') : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PORT = Number(process.env.PORT || 5050);
const TINYFISH_API_KEY = process.env.TINYFISH_API_KEY || '';
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = String(process.env.SUPABASE_ANON_KEY || '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const SQL_PERSISTENCE_ENABLED = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const SUPABASE_AUTH_ENABLED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY);
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
// Keep the public AI guide useful without an account while limiting anonymous API usage.
const guestAiBuckets = new Map();

function allowGuestAiChat(req){
  const ip=String(req.socket?.remoteAddress||'unknown');
  const nowMs=Date.now();
  let bucket=guestAiBuckets.get(ip);
  if(!bucket||nowMs-bucket.windowStart>=60_000) bucket={windowStart:nowMs,count:0};
  bucket.count+=1;
  guestAiBuckets.set(ip,bucket);
  if(guestAiBuckets.size>1000){
    for(const [key,item] of guestAiBuckets){
      if(nowMs-item.windowStart>=60_000) guestAiBuckets.delete(key);
    }
  }
  return bucket.count<=6;
}

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp'
};

const SERVICES = [
  ['🔌','Electrical','Electrician'],['🚰','Plumbing','Plumber'],['❄️','AC Repair','AC Technician'],['🔧','Appliance Repair','Appliance Technician'],
  ['🪚','Carpentry','Carpenter'],['🎨','Painting','Painter'],['🧹','Cleaning','Cleaning Expert'],['💻','Computer Repair','Computer Technician'],
  ['📱','Mobile Repair','Mobile Technician'],['🔑','Locksmith','Locksmith'],['🚗','Mechanic','Vehicle Mechanic'],['🛠️','General Repair','Handyman']
];


const seed = {
  // Accounts are provisioned through Supabase Auth. The database starts empty.
  users: [],
  technicians: [],
  services: SERVICES.map((s,i)=>({id:`s${i+1}`,icon:s[0],name:s[1],technicianType:s[2],active:true,baseMin:[300,250,500,350,400,500,250,400,300,350,500,250][i],baseMax:[1200,1200,2500,2500,1800,3000,1500,2500,2000,1500,5000,1500][i]})),
  bookings: [], quotes: [], payments: [], invoices: [], reviews: [], messages: [], notifications: [], disputes: [], verifications: [], aiAnalyses: [], auditLogs: [], pricingRules: [], otpChallenges: [], pendingRegistrations: [], parts: []
};

function clone(v){ return JSON.parse(JSON.stringify(v)); }

function removeDemoState(data){
  const users=Array.isArray(data.users)?data.users:[];
  const demoUsers=new Set(users.filter(u=>u.demoProfile||/^demo[-_]/i.test(String(u.id||''))||/@(?:nearfix\.(?:test|demo)|yourdomain\.com)$/i.test(String(u.email||''))).map(u=>String(u.id)));
  const techs=Array.isArray(data.technicians)?data.technicians:[];
  const demoTechs=new Set(techs.filter(t=>t.demoProfile||demoUsers.has(String(t.userId))||/^demo[-_]/i.test(String(t.id||''))).map(t=>String(t.id)));
  const demoBookings=new Set((data.bookings||[]).filter(b=>demoUsers.has(String(b.customerId))||demoTechs.has(String(b.technicianId))).map(b=>String(b.id)));
  let changed=demoUsers.size>0||demoTechs.size>0||demoBookings.size>0;
  if(demoUsers.size)data.users=users.filter(u=>!demoUsers.has(String(u.id)));
  if(demoTechs.size)data.technicians=techs.filter(t=>!demoTechs.has(String(t.id)));
  if(Array.isArray(data.parts)){
    const fixtureBarcodes=new Set(Array.from({length:12},(_,index)=>`89010010000${String(index+11).padStart(2,'0')}`));
    const before=data.parts.length;
    data.parts=data.parts.filter(part=>!(fixtureBarcodes.has(String(part.barcode))&&/^p(?:[1-9]|1[0-2])$/.test(String(part.id))));
    if(data.parts.length!==before)changed=true;
  }
  const relatedKeys=['userId','customerId','technicianId','actorId','senderId','recipientId','createdBy'];
  for(const key of ['bookings','quotes','payments','invoices','reviews','messages','notifications','disputes','verifications','aiAnalyses','auditLogs','otpChallenges','pendingRegistrations']){
    if(!Array.isArray(data[key]))continue;
    const before=data[key].length;
    data[key]=data[key].filter(row=>!demoBookings.has(String(row.bookingId||row.requestId||''))&&!relatedKeys.some(field=>demoUsers.has(String(row[field]||''))||demoTechs.has(String(row[field]||''))));
    if(data[key].length!==before)changed=true;
  }
  return changed;
}
function removeApplicationCredentials(data){
  let changed=false;
  for(const user of data.users||[]){
    if(Object.prototype.hasOwnProperty.call(user,'password')){delete user.password;changed=true;}
    if(Object.prototype.hasOwnProperty.call(user,'passwordHash')){delete user.passwordHash;changed=true;}
  }
  for(const booking of data.bookings||[]){
    const verification=booking.arrivalVerification;
    if(verification?.otp){delete verification.otp;verification.status='EXPIRED';changed=true;}
  }
  return changed;
}

function ensureDb(){
  fs.mkdirSync(DATA_DIR,{recursive:true});
  if(!fs.existsSync(DATA_FILE)){
    let fresh=clone(seed);
    fs.writeFileSync(DATA_FILE, JSON.stringify(fresh,null,2));
  }

  try {
    const data=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
    if(!Array.isArray(data.users)) data.users=[];
    if(!Array.isArray(data.technicians)) data.technicians=[];
    if(!Array.isArray(data.services)) data.services=clone(seed.services);
    if(!Array.isArray(data.parts)) data.parts=[];
    const removedDemoData=removeDemoState(data);
    const removedCredentials=removeApplicationCredentials(data);
    if(removedDemoData||removedCredentials)save(data);
    if(!Array.isArray(data.otpChallenges)) data.otpChallenges=[];
    if(!Array.isArray(data.pendingRegistrations)) data.pendingRegistrations=[];
    data.technicians.forEach(t=>{
      if(!t.upiId)t.upiId=`${String(t.name||'technician').toLowerCase().replace(/[^a-z0-9]+/g,'.').replace(/^\.|\.$/g,'')}.${t.id}@nearfix`;
    });
    save(data);
    return data;
  } catch {
    const fresh=clone(seed);
    fs.writeFileSync(DATA_FILE, JSON.stringify(fresh,null,2));
    return fresh;
  }
}
function db(){ return ensureDb(); }
function save(data){ fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2)); }

async function sqlRequest(pathname, options={}){
  if(!SQL_PERSISTENCE_ENABLED) return null;
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`,{
    ...options,
    headers:{
      apikey:SUPABASE_SERVICE_ROLE_KEY,
      Authorization:`Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type':'application/json',
      ...(options.headers||{})
    }
  });
  if(!r.ok){ const text=await r.text(); throw new Error(`SQL persistence request failed (${r.status}): ${text.slice(0,220)}`); }
  const text=await r.text(); return text?JSON.parse(text):null;
}

async function loadPersistentState(){
  if(!SQL_PERSISTENCE_ENABLED) return db();
  try{
    const rows=await sqlRequest('nearfix_state?id=eq.1&select=state');
    if(Array.isArray(rows)&&rows[0]?.state){
      const remote=rows[0].state;
      if(remote && typeof remote==='object'){
        const removedDemoData=removeDemoState(remote);
        const removedCredentials=removeApplicationCredentials(remote);
        const cleaned=removedDemoData||removedCredentials;
        if(cleaned)await sqlRequest('nearfix_state',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({id:1,state:remote,updated_at:now()})});
        fs.mkdirSync(DATA_DIR,{recursive:true});
        fs.writeFileSync(DATA_FILE,JSON.stringify(remote,null,2));
        return remote;
      }
    }
    const local=db();
    await sqlRequest('nearfix_state',{
      method:'POST',
      headers:{Prefer:'resolution=merge-duplicates,return=minimal'},
      body:JSON.stringify({id:1,state:local,updated_at:now()})
    });
    return local;
  }catch(e){
    console.error('NearFix Supabase read failed:',e.message);
    throw e;
  }
}

async function savePersistent(data){
  save(data);
  if(!SQL_PERSISTENCE_ENABLED) return;
  try{
    await sqlRequest('nearfix_state',{
      method:'POST',
      headers:{Prefer:'resolution=merge-duplicates,return=minimal'},
      body:JSON.stringify({id:1,state:data,updated_at:now()})
    });
  }catch(e){
    console.error('NearFix SQL save failed:',e.message);
    throw e;
  }
}
function id(prefix='id'){ return `${prefix}_${crypto.randomUUID()}`; }
function now(){ return new Date().toISOString(); }
function safeUser(u){ if(!u) return null; const {password,passwordHash,...rest}=u; return rest; }
function json(res,status,body,headers={}){ res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,PATCH,PUT,DELETE,OPTIONS',...headers}); res.end(JSON.stringify(body)); }
function readBody(req){ return new Promise((resolve,reject)=>{ let raw=''; req.on('data',c=>{raw+=c;if(raw.length>4e6) reject(new Error('Payload too large'));}); req.on('end',()=>{if(!raw)return resolve({});try{resolve(JSON.parse(raw));}catch(e){reject(new Error('Invalid JSON'));}}); req.on('error',reject); }); }
async function supabaseAuthRequest(pathname, options={}){
  if(!SUPABASE_AUTH_ENABLED) throw new Error('Supabase Auth is not configured. Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.');
  const response=await fetch(`${SUPABASE_URL}/auth/v1/${pathname}`,{...options,headers:{apikey:SUPABASE_ANON_KEY,'Content-Type':'application/json',...(options.headers||{})}});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(payload.msg||payload.message||payload.error_description||payload.error||'Supabase authentication failed.');error.status=response.status;throw error;}
  return payload;
}
async function profileForAuthUser(userId){
  const rows=await sqlRequest(`profiles?id=eq.${encodeURIComponent(userId)}&select=id,role,full_name,email,phone,area`);
  return Array.isArray(rows)?rows[0]||null:null;
}
async function auth(req){
  const h=req.headers.authorization||''; if(!h.startsWith('Bearer ')) return null;
  try{
    const token=h.slice(7);
    const user=await supabaseAuthRequest('user',{headers:{Authorization:`Bearer ${token}`}});
    if(!user?.id) return null;
    const profile=await profileForAuthUser(user.id);
    if(!profile || !['customer','technician','admin'].includes(profile.role)) return null;
    return {id:user.id,role:profile.role,email:profile.email||user.email,name:profile.full_name||user.user_metadata?.full_name||user.email,phone:profile.phone||'',area:profile.area||''};
  }catch{return null;}
}
function normalizePhone(v){ return String(v||'').replace(/[^+0-9]/g,''); }
function otpCode(){ return String(crypto.randomInt(0,1000000)).padStart(6,'0'); }
function findUser(data,id){ return data.users.find(u=>String(u.id)===String(id)); }
function technicianFor(data,id){ return data.technicians.find(t=>String(t.id)===String(id)); }
function technicianForUser(data,userId){
  return (data.technicians||[]).find(t=>String(t.userId ?? t.user_id ?? t.user?.id ?? '')===String(userId));
}

function ensureTechnicianProfile(data,user){
  if(!user || user.role!=='technician') return null;
  // Repair legacy records that used user_id/user.id instead of userId.
  let t=(data.technicians||[]).find(x=>String(x.userId ?? x.user_id ?? x.user?.id ?? '')===String(user.id));
  if(t){
    if(!t.userId) t.userId=user.id;
    if(!t.name) t.name=user.name;
    if(!t.area) t.area=user.area||'Ghaziabad, Uttar Pradesh';
    if(!t.service) t.service='Handyman';
    if(!t.category) t.category='General Repair';
    if(!Array.isArray(t.skills)) t.skills=[];
    if(t.available===undefined) t.available=false;
    if(t.rating===undefined) t.rating=0;
    if(t.reviews===undefined) t.reviews=0;
    return t;
  }
  t={id:id('tech'),userId:user.id,name:user.name,service:user.service||'Handyman',category:user.category||user.service||'General Repair',rating:0,reviews:0,exp:0,distance:3.5,price:299,available:false,jobs:0,verified:false,identityVerified:false,skillVerified:false,experienceVerified:false,response:0,completionRate:100,cancellationRate:0,repeatCustomers:0,eta:15,area:user.area||'Ghaziabad, Uttar Pradesh',skills:[],upiId:`${user.id}@nearfix`};
  data.technicians.push(t);
  return t;
}
function technicianView(data,t){
  if(!t) return null;
  const u=findUser(data,t.userId);
  return {...t,phone:u?.phone||t.phone||null};
}
function techniciansView(data,list){ return list.map(t=>technicianView(data,t)); }
function accountSummary(data,userId){
  const u=findUser(data,userId); if(!u) return null;
  const myTech=u.role==='technician'?data.technicians.find(t=>t.userId===userId):null;
  const payments=data.payments.filter(p=>p.customerId===userId || (myTech&&p.technicianId===myTech.id));
  const paid=payments.filter(p=>p.status==='SUCCESS').reduce((s,p)=>s+Number(p.amount||0),0);
  const pending=payments.filter(p=>p.status==='PENDING_CONFIRMATION').reduce((s,p)=>s+Number(p.amount||0),0);
  const technicianPending=u.role==='technician' ? data.payments.filter(p=>p.technicianId===myTech?.id&&p.status==='PENDING_CONFIRMATION').reduce((s,p)=>s+Number(p.amount||0),0) : 0;
  return {role:u.role,totalPaid:u.role==='customer'?paid:0,earnings:u.role==='technician'?paid:0,pending:u.role==='technician'?technicianPending:pending,availableBalance:u.role==='technician'?paid-technicianPending:0,invoiceCount:data.invoices.filter(i=>i.customerId===userId || (myTech&&i.technicianId===myTech.id)).length};
}
function serviceFor(data,name){ return data.services.find(s=>s.name===name)||data.services.find(s=>s.technicianType===name); }
function validCoords(lat,lng){
  return Number.isFinite(Number(lat)) &&
    Number.isFinite(Number(lng)) &&
    Number(lat) >= -90 && Number(lat) <= 90 &&
    Number(lng) >= -180 && Number(lng) <= 180;
}
function haversine(a,b){
  const R=6371,rad=Math.PI/180;
  const dLat=(Number(b.lat)-Number(a.lat))*rad;
  const dLon=(Number(b.lng)-Number(a.lng))*rad;
  const x=Math.sin(dLat/2)**2+
    Math.cos(Number(a.lat)*rad)*
    Math.cos(Number(b.lat)*rad)*
    Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function normalizeService(v){ return String(v||'').trim().toLowerCase(); }
function updateDistanceForTech(t, customerLat, customerLng){
  if(validCoords(customerLat,customerLng) && validCoords(t.lat,t.lng)){
    t.distance=Number(haversine(
      {lat:Number(customerLat),lng:Number(customerLng)},
      {lat:Number(t.lat),lng:Number(t.lng)}
    ).toFixed(2));
    t.locationSource=t.locationSource||'technician-gps';
  }
  return t;
}
function scoreTech(t, service, urgent=false, budget=0){
  const svc=normalizeService(service);
  const skills=Array.isArray(t.skills)?t.skills:[];
  const skill=(normalizeService(t.category).includes(svc)||
    normalizeService(t.service).includes(svc)||
    skills.some(s=>normalizeService(s).includes(svc)))?1:0;
  const skillScore=skill*40;
  const availability=(t.available?20:0);
  const distance=Math.max(0,15-(Number(t.distance)||10)*2.5);
  const reliability=Math.max(0,10-(100-(t.completionRate||90))/2);
  const rating=(t.rating||0)*1.8;
  const price=budget?Math.max(0,10-Math.abs((t.price||0)-budget)/100):7;
  return skillScore+availability+distance+reliability+rating+price+(urgent&&t.available?10:0);
}
function matchTechs(data,{service,radius=5,budget=0,urgent=false,lat=null,lng=null}={}){
  const customerLat=Number(lat), customerLng=Number(lng);
  let list=data.technicians.map(t=>updateDistanceForTech({...t},customerLat,customerLng));
  if(service){
    const wanted=normalizeService(service);
    const exact=list.filter(t=>normalizeService(t.category)===wanted || normalizeService(t.service)===wanted);
    if(exact.length) list=exact;
  }
  list=list.filter(t=>{
    if(validCoords(customerLat,customerLng) && validCoords(t.lat,t.lng))
      return Number(t.distance)<=Number(radius);
    return Number(t.distance||999)<=Number(radius);
  });
  list.sort((a,b)=>scoreTech(b,service,urgent,budget)-scoreTech(a,service,urgent,budget));
  return list.map(t=>{
    const distanceFee=Math.max(0,Math.min(80,Math.round(Number(t.distance||0)*12)));
    const startingPrice=Number(t.price||0)+distanceFee;
    return {...t,distanceFee,startingPrice,match:Math.min(99,Math.round(scoreTech(t,service,urgent,budget))),eta:t.eta||Math.max(5,Math.round(Number(t.distance||3)*4)),matchReason:service ? (normalizeService(t.category)===normalizeService(service)?'Field match':'Nearby professional') : 'Nearby professional'};
  });
}
function priceEstimate(data,service,problem='',location='',urgent=false){
  const s=serviceFor(data,service)||{baseMin:300,baseMax:1500};
  const text=String(problem).toLowerCase();
  let min=s.baseMin,max=s.baseMax;
  if(/gas|compressor|motor|board|pcb|major/.test(text)){min+=300;max+=1800;}
  if(/leak|wiring|installation|replacement|repair/.test(text)){min+=100;max+=600;}
  if(urgent){min=Math.round(min*1.15);max=Math.round(max*1.25);}
  const policy=pricingPolicy(data,service); return {service:service||'General Repair',labour:{min:Math.round(min*.35),max:Math.round(Math.min(max*.55,policy.baseMax))},parts:{min:Math.round(min*.65),max:Math.round(max*.65)},inspectionFee:policy.inspectionFee,min,max,location:location||'your service area',urgent,platformFeePercent:0,disclaimer:'NearFix shows a range before booking. Final charges must be itemized and approved; catalog parts use shared reference prices and no hidden platform fee is added.'};
}
function analyzeProblem(data,problem,service,urgent=false){
  const text=String(problem||'').toLowerCase();
  const language=detectCustomerLanguage(problem);
  let detected=service||'General Repair', skill='Handyman', urgency=urgent?'High':'Medium', causes=['Requires on-site inspection'];
  if(/ac|cooling|compressor|gas|एसी|ठंडा|कूलिंग/.test(text)){detected='AC Repair';skill='AC Technician';causes=['Refrigerant/gas issue','Airflow or filter restriction','Compressor or electrical issue'];}
  else if(/water|leak|tap|pipe|drain|पानी|लीक|नल|पाइप|टपक/.test(text)){detected='Plumbing';skill='Plumber';causes=['Loose or damaged fitting','Pipe/faucet leakage','Drain blockage'];}
  else if(/switch|fan|socket|wire|electric|power|mcb|बिजली|स्विच|चिंगारी|तार|पंखा|सॉकेट/.test(text)){detected='Electrical';skill='Electrician';causes=['Loose connection','Faulty switch/socket','Circuit protection issue'];}
  else if(/fridge|refrigerator|washing|microwave|appliance|फ्रिज|वॉशिंग|माइक्रोवेव|उपकरण/.test(text)){detected='Appliance Repair';skill='Appliance Technician';causes=['Component fault','Power/control issue','Mechanical wear'];}
  else if(/laptop|computer|wifi|network|pc/.test(text)){detected='Computer Repair';skill='Computer Technician';causes=['Software/configuration issue','Power or hardware issue','Network configuration'];}
  if(/urgent|emergency|sparks|smoke|burn|gas smell|flood|जरूरी|आपात|चिंगारी|धुआँ|जलने|गैस की गंध|बाढ़/.test(text)) urgency='High';
  const estimate=priceEstimate(data,detected,problem,'',urgency==='High');
  if(language!=='English'){
    const translations={
      'General Repair':['मुद्दे की सही वजह पता करने के लिए technician को मौके पर जाँच करनी होगी।',['मौके पर जाँच ज़रूरी है'],'सही technician की पहचान और सुरक्षित अगला कदम'],
      'AC Repair':['यह AC से जुड़ी समस्या लगती है। technician airflow, filter और cooling system की जाँच कर सकता है।',['Filter या airflow में रुकावट','Cooling system की समस्या','Compressor या electrical fault'],'AC technician से जाँच करवाएँ; unit का panel खुद न खोलें'],
      'Plumbing':['यह पानी के leak या plumbing fitting की समस्या हो सकती है।',['ढीली या खराब fitting','Pipe या tap में leak','Drain blockage'],'अगर सुरक्षित हो तो पानी का valve बंद करें और plumber से जाँच करवाएँ'],
      'Electrical':['यह electrical fitting या connection की समस्या हो सकती है।',['ढीला connection','खराब switch या socket','Circuit protection की समस्या'],'अगर spark या जलने की गंध हो तो सुरक्षित होने पर circuit बंद करें; live wiring को न छुएँ'],
      'Appliance Repair':['यह appliance के component या power connection से जुड़ी समस्या हो सकती है।',['Component fault','Power या control issue','Mechanical wear'],'Appliance technician से जाँच करवाएँ; उपकरण खुद न खोलें'],
      'Computer Repair':['यह computer, software या network की समस्या हो सकती है।',['Software या configuration issue','Power या hardware issue','Network configuration'],'Technician से जाँच करवाएँ और अपना password या OTP साझा न करें']
    };
    const translation=translations[detected]||translations['General Repair'];
    causes=translation[1];
    if(language==='Hindi'){
      // Hindi UI copy is in Devanagari; service and skill names stay in English for matching.
      var localizedSummary=translation[0], localizedAction=urgency==='High'?'कृपया जल्द ही verified technician से संपर्क करें और unsafe DIY काम से बचें।':translation[2];
    }else{
      // Hinglish keeps the familiar Latin script while the service taxonomy stays unchanged.
      var localizedSummary={Plumbing:'Yeh plumbing ya water leak ki problem lagti hai.',Electrical:'Yeh electrical fitting ya connection ki problem ho sakti hai. Live wiring ko touch na karein.','AC Repair':'Yeh AC airflow ya cooling system se judi problem lagti hai.','Appliance Repair':'Yeh appliance ke component ya power connection ki problem ho sakti hai.','Computer Repair':'Yeh computer, software ya network ki problem ho sakti hai.','General Repair':'Is issue ki exact wajah technician inspection ke baad pata chalegi.'}[detected]||'Is issue ki exact wajah technician inspection ke baad pata chalegi.';
      causes={Plumbing:['Loose ya damaged fitting','Pipe ya tap leak','Drain blockage'],Electrical:['Loose connection','Faulty switch ya socket','Circuit protection issue'],'AC Repair':['Filter ya airflow blockage','Cooling system issue','Compressor ya electrical fault'],'Appliance Repair':['Component fault','Power ya control issue','Mechanical wear'],'Computer Repair':['Software ya configuration issue','Power ya hardware issue','Network configuration']}[detected]||['On-site inspection zaroori hai'];
      localizedAction=urgency==='High'?'Jaldi verified technician se baat karein aur unsafe DIY work avoid karein.':translation[2];
    }
  }
  return {service:detected,summary:language==='English'?(problem||'General service request'):localizedSummary,possibleCauses:causes,requiredSkill:skill,urgency,estimatedRange:`₹${estimate.min.toLocaleString('en-IN')}–₹${estimate.max.toLocaleString('en-IN')}`,recommendedNextAction:language==='English'?(urgency==='High'?'Arrange a verified technician promptly and avoid unsafe DIY work.':'Book a suitable verified technician for inspection.'):localizedAction,preliminary:true,mode:TINYFISH_API_KEY?'tinyfish-agent':'rule-based-assistant'};
}

// Keep output in Devanagari Hindi or Latin-script Hinglish when that is how the customer writes.
function detectCustomerLanguage(message){
  const text=String(message||'');
  if(/[\u0900-\u097F]/.test(text)) return 'Hindi';
  if(/\b(hai|hain|hoon|h|ho|gya|gaya|gayi|kharab|khrab|nahi|nahin|kya|kaise|mera|meri|mujhe|chahiye|karna|kar|kr+|rha|rhe|rhi|rhh?|yeh|iska|isse|bhejo|batao)\b/i.test(text)) return 'Hinglish';
  return 'English';
}
function localChatReply(service,language){
  const replies={
    Hindi:{'General Repair':'कृपया बताइए कौन-सी चीज़ खराब है, क्या लक्षण दिख रहे हैं और क्या समस्या तुरंत ठीक करवानी है।','Plumbing':'यह plumbing की समस्या लगती है। अगर पानी leak हो रहा है और सुरक्षित हो, तो valve बंद करें। Nearby plumber को बुलाएँ।','Electrical':'यह electrical समस्या हो सकती है। Spark या जलने की गंध हो तो सुरक्षित होने पर circuit बंद करें। Live wire को न छुएँ; verified electrician को बुलाएँ।','AC Repair':'यह AC की समस्या लगती है। Unit का panel न खोलें; AC technician को दिखाने के लिए समस्या की photo या video जोड़ें।','Appliance Repair':'यह appliance repair का मामला हो सकता है। Technician की मदद के लिए model number और समस्या की photo जोड़ें।','Computer Repair':'यह computer या network की समस्या हो सकती है। अपना password, PIN या OTP किसी से साझा न करें।','Mobile Repair':'Mobile model और समस्या का विवरण दें; फिर आसपास के mobile technicians देखें।'},
    Hinglish:{'General Repair':'Kaunsi cheez kharab hai, exact symptom kya hai, aur kya issue urgent hai? Yeh details sahi technician dhoondhne mein help karengi.','Plumbing':'Yeh plumbing problem lagti hai. Agar leak ho raha hai aur safe ho, to valve band kar dein. Nearby plumber ko bula sakte hain.','Electrical':'Yeh electrical issue ho sakta hai. Spark ya jalne ki smell ho to safe hone par circuit band karein. Live wire touch na karein; verified electrician ko bulaein.','AC Repair':'Yeh AC issue lag raha hai. Unit ka panel na kholein; technician ke liye photo ya video add karein.','Appliance Repair':'Yeh appliance repair ka issue ho sakta hai. Model number aur photo share karne se technician prepare ho sakta hai.','Computer Repair':'Yeh computer ya network issue ho sakta hai. Apna password, PIN ya OTP kabhi share na karein.','Mobile Repair':'Mobile model aur issue batayein; phir aas-paas ke mobile technicians dhoondhein.'}
  };
  return replies[language]?.[service]||null;
}

// Use TinyFish to research repair guidance from the web while keeping its API key on the server.
async function tinyFishRepairResearch(service,problem){
  if(!TINYFISH_API_KEY) throw new Error('TinyFish is not configured.');
  const {TinyFish}=await import('@tiny-fish/sdk');
  const client=new TinyFish({apiKey:TINYFISH_API_KEY});
  const availableServices=SERVICES.map(item=>item[1]).join(', ');
  const query=encodeURIComponent(`${String(problem||'').slice(0,180)} home repair service`);
  const stream=await client.agent.stream({
    url:`https://www.wikihow.com/wikiHowTo?search=${query}`,
    goal:`Help a NearFix home-service customer with the actual problem they described. The initial service guess is ${service}, but treat the customer's description as the source of truth and correct the service when needed. Choose the closest service from this list: ${availableServices}. Customer description: ${String(problem||'').slice(0,500)}. First identify what is broken and its symptoms, then answer about that specific issue; do not give unrelated plumbing or electrical advice. Detect the language used in the customer description and write all customer-facing text in that same language. If the customer writes Hindi in Latin letters, reply in Hinglish using Latin letters; if they write Hindi in Devanagari, reply in Devanagari Hindi. Keep JSON keys, service taxonomy, technician skill names, and urgency enum values in English so the app can use them. Research only guidance that matches the described problem. Return a JSON object with keys service (one exact service name from the list), summary (one short paragraph specific to this problem), possibleCauses (array of up to three relevant possibilities), requiredSkill (professional technician type), urgency (Low, Medium, or High), recommendedNextAction (safe next step). Do not give dangerous DIY instructions or tell the customer to open electrical, gas, or appliance equipment. If unsure, ask one focused follow-up question in the customer's language instead of guessing.`
  });
  for await(const event of stream){
    if(event.type==='FAILED'||event.type==='ERROR') throw new Error('TinyFish agent could not complete the repair research.');
    if(event.type!=='COMPLETE') continue;
    let result=event.result??event.result_json??event.data;
    if(result&&typeof result==='object'){
      if(result.result&&typeof result.result==='object') result=result.result;
      if(result.summary||result.possibleCauses) return result;
      result=JSON.stringify(result);
    }
    if(typeof result==='string'){
      const cleaned=result.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
      try{return JSON.parse(cleaned);}catch{return {summary:cleaned};}
    }
    throw new Error('TinyFish returned no repair research.');
  }
  throw new Error('TinyFish stream ended without a completed result.');
}
function audit(data,actor,action,entity,entityId,meta={}){ data.auditLogs.push({id:id('audit'),actorId:actor?.id||null,action,entity,entityId,meta,createdAt:now()}); }
function notify(data,userId,text){ data.notifications.unshift({id:id('n'),userId,text,read:false,time:'Just now',createdAt:now()}); }
function bookingParticipants(data,b){
  const tech=technicianFor(data,b.technicianId);
  return [b.customerId,tech?.userId].filter(Boolean);
}
function pricingPolicy(data,service){
  const s=serviceFor(data,service)||{baseMin:300,baseMax:1500};
  const inspection=Math.min(299,Math.max(99,Math.round(s.baseMin*.25)));
  return {baseMin:Number(s.baseMin||300),baseMax:Number(s.baseMax||1500),inspectionFee:inspection,maxPartsMarkupPercent:5,otherChargeMaxPercent:10,platformFeePercent:0,currency:'INR'};
}
function quotePricingAudit(data,booking,items,labour,otherCharges){
  const policy=pricingPolicy(data,booking.service);
  const catalogItems=items.map(item=>{
    const part=(data.parts||[]).find(p=>String(p.barcode)===String(item.barcode));
    const qty=Math.max(1,Number(item.qty||1));
    const catalogPrice=part?Number(part.price):Number(item.price||0);
    return {...item,qty,catalogPrice,price:catalogPrice,amount:catalogPrice*qty,partFound:Boolean(part),name:part?.name||item.name||'Service item'};
  });
  const catalogPartsTotal=catalogItems.reduce((sum,x)=>sum+x.amount,0);
  const requestedPartsTotal=items.reduce((sum,x)=>sum+Number(x.amount||0),0);
  const markupPercent=catalogPartsTotal?Math.max(0,((requestedPartsTotal-catalogPartsTotal)/catalogPartsTotal)*100):0;
  // Apply the catalog and service policy automatically instead of creating a manual review queue.
  const finalLabour=Math.max(0,Math.min(Number(labour||0),policy.baseMax));
  const otherLimit=(finalLabour+catalogPartsTotal)*(policy.otherChargeMaxPercent/100);
  const finalOtherCharges=Math.max(0,Math.min(Number(otherCharges||0),otherLimit));
  return {policy,catalogItems,catalogPartsTotal,requestedPartsTotal,markupPercent:Number(markupPercent.toFixed(1)),labour:finalLabour,otherCharges:finalOtherCharges,automaticCheck:'APPLIED'};
}
function bookingView(data,b,viewer=null){
  const view={...b,customer:safeUser(findUser(data,b.customerId)),technician:technicianView(data,technicianFor(data,b.technicianId)),quote:data.quotes.find(q=>q.bookingId===b.id)||null,payment:data.payments.find(p=>p.bookingId===b.id)||null,invoice:data.invoices.find(i=>i.bookingId===b.id)||null,media:Array.isArray(b.media)?b.media:[]};
  if(b.arrivalVerification){
    view.arrivalVerification={...b.arrivalVerification};
    // Only the booking's customer can see the in-app code.
    if(!(viewer?.role==='customer' && String(viewer.id)===String(b.customerId))){
      delete view.arrivalVerification.otp;
    }
    delete view.arrivalVerification.otpHash;
  }
  return view;
}

function normArea(v){ return String(v||'').trim().toLowerCase().replace(/\s+/g,' '); }
function adminHasAreaAccess(admin, area){
  const scope=normArea(admin?.area);
  if(!scope || scope==='all areas' || scope==='all') return true;
  const target=normArea(area);
  if(!target) return false;
  return target===scope || target.includes(scope) || scope.includes(target);
}
function userArea(data,u){
  if(!u) return '';
  if(u.area) return u.area;
  if(u.role==='technician'){ const t=data.technicians.find(x=>x.userId===u.id); return t?.area||''; }
  const recent=data.bookings.filter(b=>b.customerId===u.id).slice(-1)[0];
  return recent?.location||'';
}
function adminScopedData(data,admin){
  if(adminHasAreaAccess(admin,'All Areas')) return {users:data.users,technicians:data.technicians,bookings:data.bookings};
  const techs=data.technicians.filter(t=>adminHasAreaAccess(admin,t.area));
  const techIds=new Set(techs.map(t=>t.id));
  const users=data.users.filter(u=>adminHasAreaAccess(admin,userArea(data,u)) || (u.role==='admin' && u.id===admin.id));
  const userIds=new Set(users.map(u=>u.id));
  const bookings=data.bookings.filter(b=>techIds.has(b.technicianId)||userIds.has(b.customerId));
  return {users,technicians:techs,bookings};
}

async function api(req,res,url){
  if(req.method==='OPTIONS') return json(res,204,{});
  await loadPersistentState();
  const data=db();
  if(req.method==='GET'&&url.pathname==='/api/health') return json(res,200,{ok:true,service:'NearFix API',version:'2.4.0',authConfigured:SUPABASE_AUTH_ENABLED,persistentStorageConfigured:SQL_PERSISTENCE_ENABLED,mode:TINYFISH_API_KEY?'tinyfish-agent':'rule-based-assistant',time:now()});
  if(req.method==='GET'&&url.pathname==='/api/public') return json(res,200,{success:true,services:data.services,technicians:techniciansView(data,data.technicians)});

  if(req.method==='GET'&&url.pathname==='/api/parts'){
    const q=String(url.searchParams.get('q')||'').trim().toLowerCase();
    const barcode=String(url.searchParams.get('barcode')||'').trim();
    const category=String(url.searchParams.get('category')||'').trim().toLowerCase();
    let parts=(data.parts||[]).map(p=>({...p}));
    if(barcode) parts=parts.filter(p=>p.barcode===barcode);
    if(q) parts=parts.filter(p=>[p.name,p.brand,p.category,p.barcode].some(v=>String(v||'').toLowerCase().includes(q)));
    if(category) parts=parts.filter(p=>String(p.category||'').toLowerCase()===category);
    return json(res,200,{success:true,parts});
  }
  if(req.method==='GET'&&url.pathname.startsWith('/api/parts/')){
    const barcode=decodeURIComponent(url.pathname.split('/').pop());
    const p=(data.parts||[]).find(x=>x.barcode===barcode);
    return p?json(res,200,{success:true,part:p}):json(res,404,{success:false,message:'Part not found',code:'PART_NOT_FOUND'});
  }


  if(req.method==='POST'&&url.pathname==='/api/auth/login'){
    try{
      const b=await readBody(req); const session=await supabaseAuthRequest('token?grant_type=password',{method:'POST',body:JSON.stringify({email:b.email,password:b.password})});
      const profile=await profileForAuthUser(session.user?.id); if(!profile)return json(res,403,{success:false,message:'Account profile is not ready. Verify your email or contact support.',code:'PROFILE_NOT_READY'});
      const user={id:profile.id,role:profile.role,name:profile.full_name,email:profile.email,phone:profile.phone||'',area:profile.area||''};
      const old=data.users.find(x=>x.id===user.id); if(old)Object.assign(old,user);else data.users.push(user);
      await savePersistent(data);
      return json(res,200,{success:true,token:session.access_token,refreshToken:session.refresh_token,expiresIn:session.expires_in,user});
    }catch(e){return json(res,e.status||503,{success:false,message:e.message,code:'AUTH_FAILED'});}
  }
  if(req.method==='POST'&&url.pathname==='/api/auth/register'){
    try{
      const b=await readBody(req); const name=String(b.name||'').trim(),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||''),role=String(b.role||'customer'),phone=normalizePhone(b.phone);
      if(!name||!email||password.length<8||phone.replace(/\D/g,'').length<7||!['customer','technician'].includes(role))return json(res,400,{success:false,message:'Name, valid email, mobile number, password of at least 8 characters and customer or technician role are required.',code:'VALIDATION'});
      const result=await supabaseAuthRequest('signup',{method:'POST',body:JSON.stringify({email,password,data:{full_name:name,role,phone,area:String(b.area||''),service:String(b.service||''),category:String(b.category||'')}})});
      const authUser=result.user||result;
      const profile=authUser?.id?await profileForAuthUser(authUser.id):null;
      if(profile){const user={id:profile.id,role:profile.role,name:profile.full_name,email:profile.email,phone:profile.phone||'',area:profile.area||''};data.users.push(user);await savePersistent(data);return json(res,201,{success:true,token:result.access_token||null,refreshToken:result.refresh_token||null,expiresIn:result.expires_in||null,user,emailVerificationRequired:!result.access_token});}
      return json(res,201,{success:true,token:result.access_token||null,refreshToken:result.refresh_token||null,expiresIn:result.expires_in||null,emailVerificationRequired:true,message:'Check your email to verify your NearFix account.'});
    }catch(e){return json(res,e.status||503,{success:false,message:e.message,code:'REGISTRATION_FAILED'});}
  }
  if(req.method==='POST'&&url.pathname==='/api/auth/refresh'){
    try{const b=await readBody(req);if(!b.refreshToken)return json(res,400,{success:false,message:'Refresh token is required.',code:'VALIDATION'});const session=await supabaseAuthRequest('token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:b.refreshToken})});const profile=await profileForAuthUser(session.user?.id);if(!profile)return json(res,401,{success:false,message:'Account profile is unavailable.',code:'PROFILE_NOT_READY'});return json(res,200,{success:true,token:session.access_token,refreshToken:session.refresh_token,expiresIn:session.expires_in,user:{id:profile.id,role:profile.role,name:profile.full_name,email:profile.email,phone:profile.phone||'',area:profile.area||''}});}catch(e){return json(res,e.status||401,{success:false,message:e.message,code:'REFRESH_FAILED'});}
  }
  if(req.method==='POST'&&url.pathname==='/api/auth/password-reset'){
    try{const b=await readBody(req);if(!b.email)return json(res,400,{success:false,message:'Email is required.',code:'VALIDATION'});await supabaseAuthRequest('recover',{method:'POST',body:JSON.stringify({email:String(b.email).trim().toLowerCase()})});return json(res,200,{success:true,message:'If an account exists for that email, a password reset link has been sent.'});}catch(e){return json(res,e.status||503,{success:false,message:e.message,code:'PASSWORD_RESET_FAILED'});}
  }
  if(req.method==='POST'&&url.pathname==='/api/auth/password-update'){
    const h=req.headers.authorization||'';if(!h.startsWith('Bearer '))return json(res,401,{success:false,message:'Use the password reset link from your email.',code:'UNAUTHORIZED'});
    try{const b=await readBody(req);if(String(b.password||'').length<8)return json(res,400,{success:false,message:'Password must be at least 8 characters.',code:'VALIDATION'});await supabaseAuthRequest('user',{method:'PUT',headers:{Authorization:h},body:JSON.stringify({password:String(b.password)})});return json(res,200,{success:true,message:'Password updated. You can now sign in.'});}catch(e){return json(res,e.status||400,{success:false,message:e.message,code:'PASSWORD_UPDATE_FAILED'});}
  }
  if(req.method==='POST'&&url.pathname==='/api/auth/logout'){
    const h=req.headers.authorization||'';if(!h.startsWith('Bearer '))return json(res,200,{success:true});try{await supabaseAuthRequest('logout',{method:'POST',headers:{Authorization:h}});}catch{}return json(res,200,{success:true});
  }

  const me=await auth(req);
  if(me){
    const profile={id:me.id,role:me.role,name:me.name,email:me.email,phone:me.phone,area:me.area};
    const stored=findUser(data,me.id);
    if(stored)Object.assign(stored,profile);else data.users.push(profile);
  }
  if(req.method==='GET'&&url.pathname==='/api/config'){
    return json(res,200,{
      success:true,
      mapProvider:'OpenStreetMap + Leaflet + OSRM',
      location:{
        browserGeolocation:true,
        technicianLiveLocation:true,
        roadRouting:true
      }
    });
  }
  if(req.method==='GET'&&url.pathname==='/api/bootstrap'){
    if(!me) return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'});
    const meUser=findUser(data,me.id);
    if(!meUser) return json(res,401,{success:false,message:'User not found',code:'USER_NOT_FOUND'});
    // Self-heal technician accounts created before technician profiles were persisted.
    if(meUser.role==='technician' && !technicianForUser(data,meUser.id)){
      ensureTechnicianProfile(data,meUser);
      await savePersistent(data);
    }
    const user=safeUser(meUser);
    const bookings=data.bookings.filter(b=>me.role==='admin'||b.customerId===me.id||(me.role==='technician'&&technicianFor(data,b.technicianId)?.userId===me.id)).map(b=>bookingView(data,b,me));
    const myTechProfile=me.role==='technician'?technicianForUser(data,me.id):null; const base={success:true,user,services:data.services,technicians:techniciansView(data,data.technicians),bookings,reviews:data.reviews.filter(r=>me.role==='admin'||r.customerId===me.id),quotes:data.quotes.filter(q=>me.role==='admin'||q.customerId===me.id||q.technicianId===me.id||myTechProfile?.id===q.technicianId),parts:data.parts||[],payments:data.payments.filter(p=>me.role==='admin'||p.customerId===me.id||myTechProfile?.id===p.technicianId),invoices:data.invoices.filter(i=>me.role==='admin'||i.customerId===me.id||myTechProfile?.id===i.technicianId),notifications:data.notifications.filter(n=>n.userId===me.id),messages:data.messages.filter(m=>m.participantIds?.includes(me.id)||me.role==='admin'),disputes:data.disputes.filter(d=>me.role==='admin'||d.customerId===me.id),account:accountSummary(data,me.id),mode:TINYFISH_API_KEY?'tinyfish-agent':'local-smart-assistant'};
    if(me.role==='admin') {
      const admin=findUser(data,me.id); const scoped=adminScopedData(data,admin); const scopedBookingIds=new Set(scoped.bookings.map(b=>b.id)); const scopedUserIds=new Set(scoped.users.map(u=>u.id)); const scopedTechIds=new Set(scoped.technicians.map(t=>t.id));
      Object.assign(base,{adminArea:admin.area||'All Areas',allUsers:scoped.users.map(safeUser),allBookings:scoped.bookings.map(b=>bookingView(data,b)),allTechnicians:techniciansView(data,scoped.technicians),allQuotes:data.quotes.filter(q=>scopedBookingIds.has(q.bookingId)||scopedUserIds.has(q.customerId)||scopedTechIds.has(q.technicianId)),allPayments:data.payments.filter(p=>scopedBookingIds.has(p.bookingId)||scopedUserIds.has(p.customerId)||scopedTechIds.has(p.technicianId)),allInvoices:data.invoices.filter(i=>scopedBookingIds.has(i.bookingId)||scopedUserIds.has(i.customerId)||scopedTechIds.has(i.technicianId)),allReviews:data.reviews.filter(r=>scopedUserIds.has(r.customerId)),allMessages:data.messages,allNotifications:data.notifications,allDisputes:data.disputes.filter(d=>scopedUserIds.has(d.customerId)||scopedTechIds.has(d.technicianId)),allAiAnalyses:data.aiAnalyses,allAuditLogs:data.auditLogs,pricingRules:data.pricingRules,allParts:data.parts||[],allAdmins:data.users.filter(u=>u.role==='admin' && adminHasAreaAccess(admin,u.area)).map(safeUser)});
    }
    return json(res,200,base);
  }
  if(req.method==='GET'&&url.pathname==='/api/me'){
    if(!me) return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'}); return json(res,200,{success:true,user:safeUser(findUser(data,me.id))});
  }

  if(req.method==='GET'&&url.pathname==='/api/technicians'){
    const service=url.searchParams.get('service')||'';
    const radius=Number(url.searchParams.get('radius')||5);
    const urgent=url.searchParams.get('urgent')==='true';
    const budget=Number(url.searchParams.get('budget')||0);
    const lat=url.searchParams.get('lat');
    const lng=url.searchParams.get('lng');
    let technicians=matchTechs(data,{service,radius,budget,urgent,lat,lng});
    let searchRadiusUsed=radius;
    if(technicians.length<5 && radius<10){
      const expanded=matchTechs(data,{service,radius:10,budget,urgent,lat,lng});
      const ids=new Set(technicians.map(t=>t.id));
      technicians=technicians.concat(expanded.filter(t=>!ids.has(t.id)).map(t=>({...t,matchReason:t.matchReason==='Service match'?'Service match · expanded radius':'Nearby · expanded radius'})));
      searchRadiusUsed=10;
    }
    const visible=technicians.slice(0,Math.max(5,Math.min(8,technicians.length)));
    return json(res,200,{success:true,technicians:techniciansView(data,visible),radius,searchRadiusUsed,minimumNearbyTarget:5,location:validCoords(lat,lng)?{lat:Number(lat),lng:Number(lng)}:null});
  }
  if(req.method==='POST'&&url.pathname==='/api/ai/analyze-problem'){
    if(!me) return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'});
    const b=await readBody(req); const result=analyzeProblem(data,b.problem,b.service,b.urgent);
    if(TINYFISH_API_KEY){
      try{
        const research=await tinyFishRepairResearch(result.service,b.problem);
        result.summary=String(research.summary||result.summary);
        if(Array.isArray(research.possibleCauses)&&research.possibleCauses.length) result.possibleCauses=research.possibleCauses.slice(0,3).map(String);
        if(research.requiredSkill) result.requiredSkill=String(research.requiredSkill);
        if(['Low','Medium','High'].includes(research.urgency)) result.urgency=research.urgency;
        if(research.recommendedNextAction) result.recommendedNextAction=String(research.recommendedNextAction);
        result.mode='tinyfish-agent';
      }catch(error){console.error('TinyFish diagnosis failed:',error.message); result.mode='rule-based-assistant';}
    }
    const row={id:id('ai'),userId:me.id,type:'problem',input:b.problem,result,createdAt:now()}; data.aiAnalyses.push(row); audit(data,me,'AI_ANALYZE','AIAnalysis',row.id); await savePersistent(data); return json(res,200,{success:true,analysis:result,analysisId:row.id});
  }
  if(req.method==='POST'&&url.pathname==='/api/ai/chat'){
    if(!me&&!allowGuestAiChat(req)) return json(res,429,{success:false,message:'Please wait a minute before sending another AI request.',code:'RATE_LIMITED'});
    const b=await readBody(req); const message=String(b.message||'').trim();
    if(!message) return json(res,400,{success:false,message:'Message is required',code:'VALIDATION'});
    let reply='Tell me the appliance/service, the exact symptom and whether it is urgent. I can help you choose the right skill and find nearby technicians.'; let service='General Repair'; const text=message.toLowerCase();
    if(/ac|air conditioner|cooling|compressor|gas|एसी|एयर कंडीशनर|ठंडा|कूलिंग/.test(text)){service='AC Repair';reply='This sounds like an AC issue. If water is leaking or the unit is sparking, switch it off safely and avoid opening electrical panels. I recommend an AC technician and a photo/video with the request.';}
    else if(/switch|spark|wire|wiring|current|electric|fan|socket|mcb|बिजली|स्विच|चिंगारी|तार|पंखा|सॉकेट/.test(text)){service='Electrical';reply='This appears electrical. If there are sparks, burning smell or exposed wires, switch off the affected circuit if safe. Do not touch live wiring; choose a verified electrician.';}
    else if(/pipe|tap|nal|water|leak|drain|plumb|पानी|लीक|नल|पाइप|टपक/.test(text)){service='Plumbing';reply='This looks like a plumbing issue. If water is actively leaking, close the nearest isolation valve if safe. NearFix can show plumbers within your chosen radius and transparent starting prices.';}
    else if(/washing|fridge|microwave|appliance|फ्रिज|वॉशिंग|माइक्रोवेव|उपकरण/.test(text)){service='Appliance Repair';reply='This sounds like an appliance repair. Share a clear photo/video and model number if available so the technician can prepare before arriving.';}
    else if(/laptop|computer|wifi|network|pc|printer/.test(text)){service='Computer Repair';reply='This appears to be a computer/network issue. Never share passwords, PINs or OTPs. A computer technician can inspect the device and quote after diagnosis.';}
    else if(/mobile|phone|screen|charging/.test(text)){service='Mobile Repair';reply='This sounds like a mobile repair. Tell me the model and symptom, then NearFix can show nearby mobile technicians and reference parts pricing.';}
    reply=localChatReply(service,detectCustomerLanguage(message))||reply;
    const local={reply,service,mode:'local-smart-assistant',suggestedAction:`Find ${service} technicians near your live location.`};
    if(service==='Plumbing'&&detectCustomerLanguage(message)==='Hinglish') local.reply='Yeh nal/plumbing repair ka issue lag raha hai. Kya nal se paani leak ho raha hai, ya nal khul-band nahi ho raha? Agar leak ho aur safe ho, to valve band kar dein. Main nearby plumber dhoondhne mein help karunga.';
    if(TINYFISH_API_KEY){
      try{
        const research=await tinyFishRepairResearch(service,message);
        const correctedService=data.services.find(item=>item.active&&item.name.toLowerCase()===String(research.service||'').trim().toLowerCase());
        if(correctedService) service=correctedService.name;
        local.service=service;
        local.suggestedAction=`Find ${service} technicians near your live location.`;
        local.reply=String(research.summary||reply);
        if(Array.isArray(research.possibleCauses)&&research.possibleCauses.length) local.reply+=` Likely checks include: ${research.possibleCauses.slice(0,3).join('; ')}.`;
        if(research.recommendedNextAction) local.reply+=` ${research.recommendedNextAction}`;
        local.mode='tinyfish-agent';
      }catch(error){console.error('TinyFish chat lookup failed:',error.message);local.mode='tinyfish-unavailable';}
    }
    // Store chat history for signed-in customers; guest prompts stay ephemeral.
    if(me){data.aiAnalyses.push({id:id('ai'),userId:me.id,type:'chat',input:message,result:local,createdAt:now()}); await savePersistent(data);}
    return json(res,200,{success:true,...local});
  }

  if(req.method==='POST'&&url.pathname==='/api/ai/estimate-price'){
    if(!me) return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'}); const b=await readBody(req); const result=priceEstimate(data,b.service,b.problem,b.location,b.urgent); const row={id:id('ai'),userId:me.id,type:'price',input:b,result,createdAt:now()}; data.aiAnalyses.push(row); await savePersistent(data); return json(res,200,{success:true,estimate:result,mode:TINYFISH_API_KEY?'tinyfish-agent':'rule-based-assistant'});
  }
  if(req.method==='POST'&&url.pathname==='/api/matching/find'){
    if(!me) return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'}); const b=await readBody(req); return json(res,200,{success:true,matches:matchTechs(data,b).slice(0,8)});
  }

  const technicianIdMatch=url.pathname.match(/^\/api\/technicians\/([^/]+)$/);
  if(technicianIdMatch&&req.method==='GET'){
    const t=technicianFor(data,technicianIdMatch[1]);
    if(!t) return json(res,404,{success:false,message:'Technician not found',code:'NOT_FOUND'});
    return json(res,200,{success:true,technician:technicianView(data,t)});
  }

  if(req.method==='PATCH'&&url.pathname==='/api/location/customer'){
    const me=await auth(req);
    if(!me) return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'});
    const body=await readBody(req);
    const lat=Number(body.latitude), lng=Number(body.longitude);
    if(!validCoords(lat,lng)) return json(res,400,{success:false,message:'Valid latitude and longitude are required',code:'INVALID_COORDINATES'});
    const u=findUser(data,me.id);
    if(!u) return json(res,404,{success:false,message:'User not found',code:'NOT_FOUND'});
    u.lastLocation={
      lat,lng,
      accuracy:Number.isFinite(Number(body.accuracy))?Number(body.accuracy):null,
      updatedAt:now(),
      source:'customer-gps'
    };
    await savePersistent(data);
    return json(res,200,{success:true,location:u.lastLocation});
  }

  if(req.method==='PATCH'&&url.pathname==='/api/technicians/me/availability'){
    if(!me||me.role!=='technician')return json(res,403,{success:false,message:'Technician access required',code:'FORBIDDEN'});
    const t=ensureTechnicianProfile(data,me); if(!t)return json(res,404,{success:false,message:'Technician profile not found',code:'NOT_FOUND'});
    const b=await readBody(req); t.available=Boolean(b.available); audit(data,me,'AVAILABILITY_UPDATE','Technician',t.id,{available:t.available}); await savePersistent(data); return json(res,200,{success:true,technician:technicianView(data,t)});
  }
  if(req.method==='PATCH'&&url.pathname==='/api/technicians/me/profile'){
    if(!me||me.role!=='technician')return json(res,403,{success:false,message:'Technician access required',code:'FORBIDDEN'});
    const t=ensureTechnicianProfile(data,me); if(!t)return json(res,404,{success:false,message:'Technician profile not found',code:'NOT_FOUND'});
    const b=await readBody(req);
    if(typeof b.name==='string'&&b.name.trim()){t.name=b.name.trim(); const u=findUser(data,me.id); if(u)u.name=t.name;}
    if(b.service) { t.service=String(b.service); const svc=serviceFor(data,b.service); if(svc)t.category=svc.name; }
    if(b.category) t.category=String(b.category);
    if(Number.isFinite(Number(b.price)) && Number(b.price)>=0)t.price=Number(b.price);
    if(Number.isFinite(Number(b.exp)) && Number(b.exp)>=0)t.exp=Number(b.exp);
    if(typeof b.area==='string'&&b.area.trim())t.area=b.area.trim();
    if(Array.isArray(b.skills))t.skills=b.skills.map(x=>String(x).trim()).filter(Boolean).slice(0,20); if(typeof b.upiId==='string'&&b.upiId.trim())t.upiId=b.upiId.trim().toLowerCase();
    audit(data,me,'PROFILE_UPDATE','Technician',t.id); await savePersistent(data); return json(res,200,{success:true,technician:technicianView(data,t),user:safeUser(findUser(data,me.id))});
  }
  if(req.method==='PATCH'&&url.pathname==='/api/technicians/me/location'){
    if(!me) return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'});
    if(me.role!=='technician') return json(res,403,{success:false,message:'Technician access required',code:'FORBIDDEN'});
    const body=await readBody(req);
    const lat=Number(body.lat), lng=Number(body.lng);
    if(!validCoords(lat,lng)) return json(res,400,{success:false,message:'Valid latitude and longitude are required',code:'INVALID_COORDINATES'});
    const t=ensureTechnicianProfile(data,me);
    if(!t) return json(res,404,{success:false,message:'Technician profile not found',code:'NOT_FOUND'});
    t.lat=lat; t.lng=lng;
    t.accuracy=Number.isFinite(Number(body.accuracy))?Number(body.accuracy):null;
    t.heading=Number.isFinite(Number(body.heading))?Number(body.heading):null;
    t.speed=Number.isFinite(Number(body.speed))?Number(body.speed):null;
    t.locationUpdatedAt=body.timestamp||now();
    t.locationSource='technician-gps';
    await savePersistent(data);
    audit(data,me,'LOCATION_UPDATE','Technician',t.id,{lat,lng});
    return json(res,200,{success:true,technician:technicianView(data,t)});
  }

  if(req.method==='GET'&&url.pathname==='/api/bookings'){
    if(!me) return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'}); const list=data.bookings.filter(b=>me.role==='admin'||b.customerId===me.id||(me.role==='technician'&&technicianFor(data,b.technicianId)?.userId===me.id)).map(b=>bookingView(data,b,me)); return json(res,200,{success:true,bookings:list});
  }
  if(req.method==='POST'&&url.pathname==='/api/bookings'){
    if(!me||me.role!=='customer') return json(res,403,{success:false,message:'Customer access required',code:'FORBIDDEN'});
    const b=await readBody(req);
    const customerLat=Number(b.latitude), customerLng=Number(b.longitude);
    const matches=matchTechs(data,{
      service:b.service,
      radius:Number(b.radius||5),
      budget:Number(b.budget||0),
      urgent:Boolean(b.urgent),
      lat:validCoords(customerLat,customerLng)?customerLat:null,
      lng:validCoords(customerLat,customerLng)?customerLng:null
    });
    const t=technicianFor(data,b.technicianId)||matches[0];
    if(!t) return json(res,409,{success:false,message:'No technician found in the selected radius',code:'NO_MATCH'});
    const ai=analyzeProblem(data,b.problem,b.service,b.urgent); const estimate=priceEstimate(data,ai.service,b.problem,b.location,b.urgent); const distanceFee=Math.max(0,Math.min(80,Math.round(Number(t.distance||0)*12))); const selectedStartingPrice=Number(t.price||0)+distanceFee; const fairMin=Math.max(Number(estimate.min||0),selectedStartingPrice); estimate.min=fairMin; estimate.selectedTechnicianStartingPrice=selectedStartingPrice; estimate.distanceFee=distanceFee; estimate.selectedTechnicianId=t.id; const media=Array.isArray(b.media)?b.media.filter(x=>x&&typeof x.data==='string').slice(0,3):[]; const booking={id:Date.now(),customerId:me.id,technicianId:t.id,service:ai.service,problem:b.problem||'',file:b.file||'',location:b.location||'',latitude:validCoords(customerLat,customerLng)?customerLat:null,longitude:validCoords(customerLat,customerLng)?customerLng:null,date:b.date||'',time:b.time||'',budget:Number(b.budget||0),status:'REQUESTED',urgent:Boolean(b.urgent),estimate:fairMin,estimateRange:estimate,createdAt:now(),statusHistory:[{status:'REQUESTED',at:now(),by:me.id}],paymentStatus:'PENDING',media,cancellation:null};
    data.bookings.push(booking); notify(data,me.id,`Booking request sent to ${t.name}.`); const tu=findUser(data,t.userId); if(tu) notify(data,tu.id,`New ${booking.service} request from ${findUser(data,me.id)?.name||'customer'}.`); audit(data,me,'CREATE','Booking',booking.id,{technicianId:t.id}); await savePersistent(data); return json(res,201,{success:true,booking:bookingView(data,booking,me),technician:t,ai,estimate});
  }
  const arrivalVerifyMatch=url.pathname.match(/^\/api\/bookings\/([^/]+)\/arrival-otp\/verify$/);
  if(arrivalVerifyMatch&&req.method==='POST'){
    if(!me||me.role!=='technician') return json(res,403,{success:false,message:'Technician access required',code:'FORBIDDEN'});
    const booking=data.bookings.find(x=>String(x.id)===String(arrivalVerifyMatch[1]));
    if(!booking) return json(res,404,{success:false,message:'Booking not found',code:'NOT_FOUND'});
    const assignedTech=technicianFor(data,booking.technicianId);
    if(!assignedTech||assignedTech.userId!==me.id) return json(res,403,{success:false,message:'Only the assigned technician can verify the arrival OTP.',code:'FORBIDDEN'});
    if(booking.status!=='ARRIVED') return json(res,409,{success:false,message:'Arrival OTP can only be verified after you mark the job as arrived.',code:'ARRIVAL_OTP_STAGE'});
    const arrival=booking.arrivalVerification;
    if(!arrival?.otp) return json(res,409,{success:false,message:'Arrival OTP is not available. Ask the customer to refresh the booking details.',code:'ARRIVAL_OTP_NOT_AVAILABLE'});
    if(arrival.expiresAt&&Date.now()>new Date(arrival.expiresAt).getTime()) return json(res,400,{success:false,message:'Arrival OTP expired. Ask the customer to request a new arrival code.',code:'OTP_EXPIRED'});
    arrival.attempts=Number(arrival.attempts||0);
    if(arrival.attempts>=OTP_MAX_ATTEMPTS) return json(res,400,{success:false,message:'Too many incorrect attempts. Ask the customer to refresh/request a new arrival code.',code:'OTP_LOCKED'});
    const body=await readBody(req);
    arrival.attempts+=1;
    const submittedHash=crypto.createHash('sha256').update(String(body.otp||'').trim()).digest();
    const expectedHash=Buffer.from(String(arrival.otpHash||''),'hex');
    if(expectedHash.length!==submittedHash.length||!crypto.timingSafeEqual(submittedHash,expectedHash)) { await savePersistent(data); return json(res,400,{success:false,message:`Incorrect OTP. ${Math.max(0,OTP_MAX_ATTEMPTS-arrival.attempts)} attempts left.`,code:'OTP_INVALID'}); }
    booking.arrivalVerification={status:'VERIFIED',verifiedAt:now(),verifiedBy:me.id};
    booking.status='INSPECTION';
    booking.statusHistory=booking.statusHistory||[];
    booking.statusHistory.push({status:'INSPECTION',at:now(),by:me.id,via:'ARRIVAL_OTP'});
    notify(data,booking.customerId,`Arrival verified for booking #${String(booking.id).slice(-6)}. Service inspection can now begin.`);
    notify(data,me.id,`Customer arrival OTP verified for booking #${String(booking.id).slice(-6)}.`);
    audit(data,me,'VERIFY_ARRIVAL_OTP','Booking',booking.id);
    await savePersistent(data);
    return json(res,200,{success:true,message:'Arrival verified. You can now start the inspection.',booking:bookingView(data,booking,me)});
  }
  const arrivalGetMatch=url.pathname.match(/^\/api\/bookings\/([^/]+)\/arrival-verification$/);
  if(arrivalGetMatch&&req.method==='POST'){
    if(!me||me.role!=='customer') return json(res,403,{success:false,message:'Customer access required',code:'FORBIDDEN'});
    const booking=data.bookings.find(x=>String(x.id)===String(arrivalGetMatch[1]));
    if(!booking||String(booking.customerId)!==String(me.id)) return json(res,404,{success:false,message:'Booking not found',code:'NOT_FOUND'});
    if(booking.status!=='ARRIVED') return json(res,409,{success:false,message:'The in-app code is available after the technician marks arrival.',code:'ARRIVAL_OTP_STAGE'});
    const otp=otpCode();
    const expiresAt=new Date(Date.now()+OTP_TTL_MS).toISOString();
    booking.arrivalVerification={status:'PENDING',sentAt:now(),expiresAt,otp,otpHash:crypto.createHash('sha256').update(otp).digest('hex'),attempts:0,deliveryMode:'IN_APP'};
    await savePersistent(data);
    return json(res,200,{success:true,status:'PENDING',otp,expiresAt});
  }
  if(arrivalGetMatch&&req.method==='GET'){
    if(!me) return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'});
    const booking=data.bookings.find(x=>String(x.id)===String(arrivalGetMatch[1]));
    if(!booking) return json(res,404,{success:false,message:'Booking not found',code:'NOT_FOUND'});
    const isCustomer=me.role==='customer'&&booking.customerId===me.id;
    const assignedTech=technicianFor(data,booking.technicianId);
    const isTech=me.role==='technician'&&assignedTech?.userId===me.id;
    if(!(isCustomer||isTech||me.role==='admin')) return json(res,403,{success:false,message:'Forbidden',code:'FORBIDDEN'});
    let arrival=booking.arrivalVerification;
    // Replace a legacy SMS-only code with an app-only code when its customer
    // opens the booking details; the previously sent code becomes invalid.
    if(isCustomer && arrival?.status==='PENDING' && !arrival.otp){
      const otp=otpCode();
      arrival={...arrival,otp,otpHash:crypto.createHash('sha256').update(otp).digest('hex'),attempts:0,sentAt:now(),expiresAt:new Date(Date.now()+OTP_TTL_MS).toISOString(),deliveryMode:'IN_APP'};
      booking.arrivalVerification=arrival;
      await savePersistent(data);
    }
    const response={success:true,status:arrival?.status||'NOT_SENT',expiresAt:arrival?.expiresAt||null,verifiedAt:arrival?.verifiedAt||null};
    if(isCustomer && arrival?.status==='PENDING' && arrival.otp && (!arrival.expiresAt || Date.now()<=new Date(arrival.expiresAt).getTime())) response.otp=arrival.otp;
    return json(res,200,response);
  }
  const bm=url.pathname.match(/^\/api\/bookings\/([^/]+)$/);
  if(bm&&req.method==='PATCH'){
    if(!me) return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'});
    const b=data.bookings.find(x=>String(x.id)===String(bm[1]));
    if(!b)return json(res,404,{success:false,message:'Booking not found',code:'NOT_FOUND'});
    const assignedTech=technicianFor(data,b.technicianId);
    const isAssignedTechnician=me.role==='technician' && assignedTech?.userId===me.id;
    const isCustomer=me.role==='customer' && b.customerId===me.id;
    const isAdmin=me.role==='admin';
    if(!(isAdmin||isCustomer||isAssignedTechnician))return json(res,403,{success:false,message:'You can only manage your own booking or assigned job.',code:'FORBIDDEN'});
    const body=await readBody(req);
    if(body.status){
      const allowedStatuses=['REQUESTED','ACCEPTED','ON_THE_WAY','ARRIVED','INSPECTION','IN_PROGRESS','AWAITING_APPROVAL','COMPLETED','CANCELLED'];
      if(!allowedStatuses.includes(body.status))return json(res,400,{success:false,message:'Invalid booking status',code:'INVALID_STATUS'});
      const transitions={
        REQUESTED:['ACCEPTED','CANCELLED'],
        ACCEPTED:['ON_THE_WAY','CANCELLED'],
        ON_THE_WAY:['ARRIVED','CANCELLED'],
        ARRIVED:['INSPECTION','CANCELLED'],
        INSPECTION:['AWAITING_APPROVAL','IN_PROGRESS','CANCELLED'],
        AWAITING_APPROVAL:['IN_PROGRESS','CANCELLED'],
        IN_PROGRESS:['COMPLETED','AWAITING_APPROVAL','CANCELLED'],
        COMPLETED:[], CANCELLED:[]
      };
      if(!isAdmin && isCustomer && body.status!=='CANCELLED') return json(res,403,{success:false,message:'Customers cannot change technician job status.',code:'ROLE_STATUS_RESTRICTED'});
      if(!isAdmin && isAssignedTechnician && body.status==='ACCEPTED' && b.status!=='REQUESTED') return json(res,409,{success:false,message:'This request is no longer pending.',code:'REQUEST_NOT_PENDING'});
      if(!isAdmin && isAssignedTechnician && b.status==='ARRIVED' && body.status==='INSPECTION') return json(res,409,{success:false,message:'Enter the customer arrival OTP before starting inspection.',code:'ARRIVAL_OTP_REQUIRED'});
      if(!isAdmin && isAssignedTechnician && !transitions[b.status]?.includes(body.status)) return json(res,409,{success:false,message:`Cannot move booking from ${b.status} to ${body.status}.`,code:'INVALID_TRANSITION'});
      if(isCustomer && body.status==='CANCELLED' && ['COMPLETED','CANCELLED'].includes(b.status)) return json(res,409,{success:false,message:'Completed bookings cannot be cancelled.',code:'BOOKING_CLOSED'});
      if(body.status==='ARRIVED' && isAssignedTechnician){
        const otp=otpCode();
        const expiresAt=new Date(Date.now()+OTP_TTL_MS).toISOString();
        b.arrivalVerification={status:'PENDING',sentAt:now(),expiresAt,otp,otpHash:crypto.createHash('sha256').update(otp).digest('hex'),attempts:0,deliveryMode:'IN_APP'};
        notify(data,b.customerId,`Technician has arrived. Open this booking's details in NearFix to view the arrival verification code.`);
      }
      b.status=body.status; b.statusHistory=b.statusHistory||[]; b.statusHistory.push({status:body.status,at:now(),by:me.id});
      if(body.status==='CANCELLED'){
        b.cancellation={cancelledBy:me.id,role:me.role,reason:String(body.reason||'Cancelled by user').trim().slice(0,240),at:now()};
        if(b.paymentStatus==='PAID') b.refundStatus='PENDING_ADMIN_REVIEW';
      }
      if(b.status==='COMPLETED' && me.role==='technician'){
        const customer=findUser(data,b.customerId);
        if(customer) notify(data,customer.id,`Service completed for booking #${String(b.id).slice(-6)}. You can now rate the service and choose Cash or Online payment.`);
        if(assignedTech?.userId) notify(data,assignedTech.userId,`Booking #${String(b.id).slice(-6)} completed. Payment status: ${b.paymentStatus||'PENDING'}.`);
      }
    }
    audit(data,me,'STATUS_UPDATE','Booking',b.id,{status:b.status});
    const technicianUser=assignedTech?.userId ? findUser(data,assignedTech.userId) : null;
    const customerUser=findUser(data,b.customerId);
    const recipient=isCustomer ? technicianUser : customerUser;
    if(recipient && recipient.id!==me.id) notify(data,recipient.id,b.status==='CANCELLED'?`Booking #${String(b.id).slice(-6)} was cancelled. Reason: ${b.cancellation?.reason||'Not provided'}`:`Booking #${String(b.id).slice(-6)} is now ${b.status}.`);
    if(b.status==='CANCELLED' && me.role!=='admin'){
      const admin=data.users.find(u=>u.role==='admin'); if(admin) notify(data,admin.id,`Booking #${String(b.id).slice(-6)} was cancelled by ${me.role}.`);
    }
    await savePersistent(data);
    return json(res,200,{success:true,booking:bookingView(data,b,me)});
  }

  const mediaMatch=url.pathname.match(/^\/api\/bookings\/([^/]+)\/media$/);
  if(mediaMatch&&req.method==='POST'){
    if(!me)return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'});
    const booking=data.bookings.find(x=>String(x.id)===String(mediaMatch[1])); if(!booking)return json(res,404,{success:false,message:'Booking not found',code:'NOT_FOUND'});
    const assigned=technicianFor(data,booking.technicianId); const allowed=me.role==='admin'||booking.customerId===me.id||(me.role==='technician'&&assigned?.userId===me.id); if(!allowed)return json(res,403,{success:false,message:'Only the customer, assigned technician or admin can upload evidence.',code:'FORBIDDEN'});
    const b=await readBody(req); const dataUrl=String(b.data||''); if(!/^data:(image\/|video\/)[^;]+;base64,/i.test(dataUrl))return json(res,400,{success:false,message:'Upload an image or video file.',code:'INVALID_MEDIA'});
    if(dataUrl.length>1500000)return json(res,413,{success:false,message:'Evidence file is too large. Keep each upload under about 1 MB.',code:'MEDIA_TOO_LARGE'});
    const type=String(b.type|| (me.role==='customer'?'CUSTOMER_ISSUE':'WORK_EVIDENCE')).toUpperCase(); const allowedTypes=['CUSTOMER_ISSUE','BEFORE','AFTER','WORK_EVIDENCE','INVOICE']; if(!allowedTypes.includes(type))return json(res,400,{success:false,message:'Invalid evidence type',code:'INVALID_MEDIA_TYPE'});
    booking.media=Array.isArray(booking.media)?booking.media:[]; booking.media.push({id:id('media'),type,name:String(b.name||'Evidence'),data:dataUrl,uploadedBy:me.id,uploadedRole:me.role,createdAt:now()});
    // Work photos stay optional and informational; they never block completion or payment.
    audit(data,me,'UPLOAD','BookingMedia',booking.id,{type}); await savePersistent(data); return json(res,201,{success:true,booking:bookingView(data,booking)});
  }
  if(req.method==='POST'&&url.pathname==='/api/quotes'){
    if(!me||!['technician','admin'].includes(me.role))return json(res,403,{success:false,message:'Technician access required',code:'FORBIDDEN'}); const b=await readBody(req); const booking=data.bookings.find(x=>x.id===b.bookingId); if(!booking)return json(res,404,{success:false,message:'Booking not found',code:'NOT_FOUND'}); if(me.role==='technician'&&booking.technicianId!==me.id&&technicianFor(data,booking.technicianId)?.userId!==me.id)return json(res,403,{success:false,message:'Forbidden',code:'FORBIDDEN'});
    const items=Array.isArray(b.items)?b.items:[]; const auditPrice=quotePricingAudit(data,booking,items,Number(b.labour||0),Number(b.otherCharges||0)); const catalogItems=auditPrice.catalogItems; const catalogParts=auditPrice.catalogPartsTotal; const total=auditPrice.labour+catalogParts+auditPrice.otherCharges; const q={id:id('q'),bookingId:booking.id,customerId:booking.customerId,technicianId:booking.technicianId,labour:auditPrice.labour,parts:catalogParts,otherCharges:auditPrice.otherCharges,items:catalogItems,notes:b.notes||'',total:total||Number(b.total||booking.estimate),reason:b.reason||'Inspection-based quotation',status:'PENDING',createdAt:now(),pricingAudit:auditPrice}; data.quotes.push(q); booking.status='AWAITING_APPROVAL'; booking.statusHistory.push({status:'AWAITING_APPROVAL',at:now(),by:me.id}); notify(data,booking.customerId,`A quotation of ₹${q.total.toLocaleString('en-IN')} is ready for approval.`); audit(data,me,'CREATE','Quote',q.id); await savePersistent(data); return json(res,201,{success:true,quote:q});
  }
  const qm=url.pathname.match(/^\/api\/quotes\/([^/]+)\/(approve|reject)$/);
  if(qm&&req.method==='POST'){
    if(!me||me.role!=='customer')return json(res,403,{success:false,message:'Customer access required',code:'FORBIDDEN'}); const q=data.quotes.find(x=>x.id===qm[1]); if(!q||q.customerId!==me.id)return json(res,404,{success:false,message:'Quote not found',code:'NOT_FOUND'}); if(q.status!=='PENDING')return json(res,409,{success:false,message:'Quote already processed',code:'QUOTE_PROCESSED'}); q.status=qm[2]==='approve'?'APPROVED':'REJECTED'; q.approvedAt=now(); q.approvedBy=me.id; const booking=data.bookings.find(x=>x.id===q.bookingId); if(booking){booking.total=q.total;booking.status=q.status==='APPROVED'?'IN_PROGRESS':'CANCELLED';booking.statusHistory.push({status:booking.status,at:now(),by:me.id});notify(data,technicianFor(data,booking.technicianId)?.userId,`Customer ${q.status.toLowerCase()} the quotation.`);} audit(data,me,q.status,'Quote',q.id);await savePersistent(data);return json(res,200,{success:true,quote:q,booking:booking?bookingView(data,booking):null});
  }

  const paymentQrMatch=url.pathname.match(/^\/api\/payments\/([^/]+)\/qr$/);
  if(paymentQrMatch&&req.method==='GET'){
    if(!me)return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'});
    const booking=data.bookings.find(x=>String(x.id)===String(paymentQrMatch[1]));
    if(!booking)return json(res,404,{success:false,message:'Booking not found',code:'NOT_FOUND'});
    const assigned=technicianFor(data,booking.technicianId);
    const allowed=me.role==='admin'||booking.customerId===me.id||assigned?.userId===me.id;
    if(!allowed)return json(res,403,{success:false,message:'You can only access the payment QR for your booking or assigned job.',code:'FORBIDDEN'});
    if(booking.status!=='COMPLETED')return json(res,409,{success:false,message:'Payment QR is available after service completion.',code:'PAYMENT_LOCKED'});
    const upiId=String(assigned?.upiId||'').trim();
    if(!upiId)return json(res,409,{success:false,message:'Technician UPI account is not configured.',code:'UPI_NOT_CONFIGURED'});
    const amount=Number(booking.total||booking.estimate||0);
    const payee=String(assigned?.name||'NearFix Technician').trim();
    const note=`NearFix booking #${String(booking.id).slice(-6)}`;
    const upiUri=`upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payee)}&am=${encodeURIComponent(amount.toFixed(2))}&cu=INR&tn=${encodeURIComponent(note)}`;
    const qrImageUrl=`https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(upiUri)}`;
    return json(res,200,{success:true,bookingId:booking.id,amount,upiId,payee,upiUri,qrImageUrl,paymentStatus:booking.paymentStatus||'PENDING'});
  }
  if(req.method==='GET'&&url.pathname==='/api/payment/config'){
    return json(res,200,{success:true,enabled:Boolean(RAZORPAY_KEY_ID&&RAZORPAY_KEY_SECRET),keyId:RAZORPAY_KEY_ID||null,provider:'Razorpay',mode:RAZORPAY_KEY_ID&&RAZORPAY_KEY_SECRET?'test-ready':'unavailable'});
  }
  if(req.method==='POST'&&url.pathname==='/api/payments/order'){
    if(!me||me.role!=='customer')return json(res,403,{success:false,message:'Customer access required',code:'FORBIDDEN'});
    if(!RAZORPAY_KEY_ID||!RAZORPAY_KEY_SECRET)return json(res,503,{success:false,message:'Razorpay test keys are not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env.',code:'PAYMENT_NOT_CONFIGURED'});
    const b=await readBody(req); const booking=data.bookings.find(x=>String(x.id)===String(b.bookingId)); if(!booking||booking.customerId!==me.id)return json(res,404,{success:false,message:'Booking not found',code:'NOT_FOUND'});
    if(booking.status!=='COMPLETED') return json(res,409,{success:false,message:'Payment unlocks after service completion.',code:'PAYMENT_LOCKED'});
    const amount=Math.round(Number(booking.total||booking.estimate||0)*100); if(amount<=0)return json(res,400,{success:false,message:'Invalid payment amount',code:'INVALID_AMOUNT'});
    const authHeader=Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
    const response=await fetch('https://api.razorpay.com/v1/orders',{method:'POST',headers:{Authorization:`Basic ${authHeader}`,'Content-Type':'application/json'},body:JSON.stringify({amount,currency:'INR',receipt:`nfx_${String(booking.id).slice(-10)}`,notes:{bookingId:String(booking.id),customerId:me.id}})});
    const order=await response.json(); if(!response.ok)return json(res,502,{success:false,message:order?.error?.description||'Razorpay order creation failed',code:'GATEWAY_ERROR'});
    return json(res,201,{success:true,order,keyId:RAZORPAY_KEY_ID,amount:amount/100,currency:'INR'});
  }
  if(req.method==='POST'&&url.pathname==='/api/payments/verify'){
    if(!me||me.role!=='customer')return json(res,403,{success:false,message:'Customer access required',code:'FORBIDDEN'});
    const b=await readBody(req); const booking=data.bookings.find(x=>String(x.id)===String(b.bookingId)); if(!booking||booking.customerId!==me.id)return json(res,404,{success:false,message:'Booking not found',code:'NOT_FOUND'});
    if(!RAZORPAY_KEY_SECRET)return json(res,503,{success:false,message:'Razorpay is not configured.',code:'PAYMENT_NOT_CONFIGURED'});
    const expected=crypto.createHmac('sha256',RAZORPAY_KEY_SECRET).update(`${b.orderId}|${b.paymentId}`).digest('hex');
    if(!b.signature||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(String(b.signature))))return json(res,400,{success:false,message:'Payment signature verification failed.',code:'INVALID_SIGNATURE'});
    const existing=data.payments.find(p=>p.bookingId===booking.id&&p.status==='SUCCESS'); if(existing)return json(res,200,{success:true,payment:existing});
    const amount=Number(booking.total||booking.estimate||0); const payment={id:id('pay'),bookingId:booking.id,customerId:booking.customerId,technicianId:booking.technicianId,amount,method:'Razorpay',status:'SUCCESS',transactionId:String(b.paymentId),gatewayOrderId:String(b.orderId),createdAt:now(),mode:'razorpay-test'}; data.payments.push(payment); booking.paymentStatus='PAID'; booking.paidAt=now(); const q=data.quotes.find(x=>String(x.bookingId)===String(booking.id)); if(!data.invoices.some(i=>String(i.bookingId)===String(booking.id))) data.invoices.push({id:id('inv'),number:`NFX-${new Date().getFullYear()}-${String(data.invoices.length+1).padStart(5,'0')}`,bookingId:booking.id,customerId:booking.customerId,technicianId:booking.technicianId,service:booking.service,labour:Number(q?.labour||Math.round(amount*.35)),parts:Number(q?.parts||Math.round(amount*.65)),platformFee:0,total:amount,paymentStatus:'PAID',createdAt:now()}); notify(data,technicianFor(data,booking.technicianId)?.userId,`Payment received for booking ${String(booking.id).slice(-6)}.`); notify(data,me.id,`Payment successful for booking ${String(booking.id).slice(-6)}. Invoice generated.`); audit(data,me,'PAYMENT_SUCCESS','Payment',payment.id,{amount,mode:'razorpay'}); await savePersistent(data); return json(res,201,{success:true,payment});
  }
  if(req.method==='POST'&&url.pathname==='/api/payments/manual'){
    if(!me||me.role!=='customer')return json(res,403,{success:false,message:'Customer access required',code:'FORBIDDEN'});
    const b=await readBody(req); const booking=data.bookings.find(x=>String(x.id)===String(b.bookingId));
    if(!booking||booking.customerId!==me.id)return json(res,404,{success:false,message:'Booking not found',code:'NOT_FOUND'});
    if(booking.status!=='COMPLETED')return json(res,409,{success:false,message:'Payment unlocks after service completion.',code:'PAYMENT_LOCKED'});
    const method=String(b.method||'CASH').toUpperCase(); if(!['CASH','UPI'].includes(method))return json(res,400,{success:false,message:'Choose Cash or UPI.',code:'INVALID_METHOD'});
    if(method==='UPI'&&!String(b.reference||'').trim())return json(res,400,{success:false,message:'UPI reference is required.',code:'REFERENCE_REQUIRED'});
    const existing=data.payments.find(p=>String(p.bookingId)===String(booking.id)&&['SUCCESS','PENDING_CONFIRMATION'].includes(p.status));
    if(existing?.status==='SUCCESS'||(existing&&existing.method!=='CASH'))return json(res,409,{success:false,message:'A payment is already pending or completed for this booking.',code:'PAYMENT_EXISTS'});
    const amount=Number(booking.total||booking.estimate||0);
    const p=existing||{id:id('pay'),bookingId:booking.id,customerId:booking.customerId,technicianId:booking.technicianId,amount,method,transactionId:`NFX-${Date.now().toString(36).toUpperCase()}`,createdAt:now()};
    p.method=method;p.amount=amount;p.reference=String(b.reference||'');p.status='PENDING_CONFIRMATION';p.verification={status:'PENDING',verifiedBy:null,verifiedAt:null};
    if(!existing)data.payments.push(p);
    booking.paymentStatus='PENDING_CONFIRMATION';notify(data,technicianFor(data,booking.technicianId)?.userId,`${method==='CASH'?'Customer reported cash paid':'Online payment'} awaits confirmation for booking #${String(booking.id).slice(-6)}.`);const admin=data.users.find(u=>u.role==='admin');if(admin)notify(data,admin.id,`Payment confirmation pending for booking #${String(booking.id).slice(-6)}.`);audit(data,me,'PAYMENT_SUBMITTED','Payment',p.id,{method:p.method});await savePersistent(data);return json(res,201,{success:true,message:method==='CASH'?'Cash payment reported. The technician must confirm receipt.':'Online payment submitted for confirmation.',payment:p});
  }
  const manualVerifyMatch=url.pathname.match(/^\/api\/payments\/([^/]+)\/verify$/);
  if(manualVerifyMatch&&req.method==='PATCH'){
    if(!me||!['technician','admin'].includes(me.role))return json(res,403,{success:false,message:'Technician or admin access required',code:'FORBIDDEN'});
    const p=data.payments.find(x=>String(x.id)===String(manualVerifyMatch[1])); if(!p)return json(res,404,{success:false,message:'Payment not found',code:'NOT_FOUND'});
    const booking=data.bookings.find(x=>String(x.id)===String(p.bookingId)); const assigned=booking?technicianFor(data,booking.technicianId):null; if(me.role==='technician'&&assigned?.userId!==me.id)return json(res,403,{success:false,message:'Only the assigned technician can confirm this payment.',code:'FORBIDDEN'});
    if(p.status!=='PENDING_CONFIRMATION')return json(res,409,{success:false,message:'Payment is not awaiting confirmation.',code:'PAYMENT_STATE'});
    p.status='SUCCESS'; p.verification={status:'VERIFIED',verifiedBy:me.id,verifiedAt:now()}; p.verifiedAt=now(); if(booking){booking.paymentStatus='PAID';booking.paidAt=now();}
    if(booking){const exists=data.invoices.some(i=>String(i.bookingId)===String(booking.id)); const q=data.quotes.find(x=>String(x.bookingId)===String(booking.id)); if(!exists)data.invoices.push({id:id('inv'),number:`NFX-${new Date().getFullYear()}-${String(data.invoices.length+1).padStart(5,'0')}`,bookingId:booking.id,customerId:booking.customerId,technicianId:booking.technicianId,service:booking.service,labour:Number(q?.labour||Math.round((booking.total||booking.estimate)*.35)),parts:Number(q?.parts||Math.round((booking.total||booking.estimate)*.65)),platformFee:0,total:Number(booking.total||booking.estimate||0),paymentStatus:'PAID',createdAt:now()});}
    notify(data,p.customerId,`Payment verified for booking #${String(p.bookingId).slice(-6)}. Invoice generated.`); if(booking?.technicianId){const techUser=technicianFor(data,booking.technicianId)?.userId;if(techUser)notify(data,techUser,`Payment verified for booking #${String(p.bookingId).slice(-6)}. Invoice generated.`);} audit(data,me,'PAYMENT_VERIFIED','Payment',p.id,{method:p.method}); await savePersistent(data); return json(res,200,{success:true,message:'Payment verified and invoice generated.',payment:p});
  }

  if(req.method==='POST'&&url.pathname==='/api/payments')return json(res,410,{success:false,message:'This payment endpoint is disabled. Use a configured payment provider or submit a customer-reported cash payment.',code:'PAYMENT_ENDPOINT_DISABLED'});
  if(req.method==='GET'&&url.pathname==='/api/invoices'){
    if(!me)return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'}); return json(res,200,{success:true,invoices:data.invoices.filter(i=>me.role==='admin'||i.customerId===me.id||i.technicianId===me.id)});
  }
  if(req.method==='POST'&&url.pathname==='/api/invoices'){
    if(!me)return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'});
    const b=await readBody(req); const booking=data.bookings.find(x=>x.id===b.bookingId); if(!booking)return json(res,404,{success:false,message:'Booking not found',code:'NOT_FOUND'});
    const assigned=technicianFor(data,booking.technicianId); const allowed=me.role==='admin'||booking.customerId===me.id||assigned?.userId===me.id;
    if(!allowed)return json(res,403,{success:false,message:'You can only create an invoice for your booking or assigned job.',code:'FORBIDDEN'});
    const invoice={id:id('inv'),number:`NFX-${new Date().getFullYear()}-${String(data.invoices.length+1).padStart(5,'0')}`,bookingId:booking.id,customerId:booking.customerId,technicianId:booking.technicianId,service:booking.service,labour:Number(b.labour||Math.round((booking.total||booking.estimate)*.35)),parts:Number(b.parts||Math.round((booking.total||booking.estimate)*.65)),platformFee:Number(b.platformFee||0),total:Number(booking.total||booking.estimate||0),paymentStatus:booking.paymentStatus||'PENDING',createdAt:now()};data.invoices.push(invoice);await savePersistent(data);return json(res,201,{success:true,invoice});
  }
  if(req.method==='POST'&&url.pathname==='/api/reviews'){
    if(!me||me.role!=='customer')return json(res,403,{success:false,message:'Customer access required',code:'FORBIDDEN'});const b=await readBody(req);const booking=data.bookings.find(x=>x.id===b.bookingId);if(!booking||booking.customerId!==me.id)return json(res,404,{success:false,message:'Booking not found',code:'NOT_FOUND'});const r={id:id('r'),bookingId:booking.id,customerId:me.id,technicianId:booking.technicianId,rating:Math.min(5,Math.max(1,Number(b.rating))),serviceQuality:Number(b.serviceQuality||b.rating),behaviour:Number(b.behaviour||b.rating),priceTransparency:Number(b.priceTransparency||b.rating),arrivalTime:Number(b.arrivalTime||b.rating),text:String(b.text||b.comment||''),tags:[],createdAt:now()};if(/late|delay/i.test(r.text))r.tags.push('Late arrival');if(/price|charge|expensive/i.test(r.text))r.tags.push('Price transparency');if(/good|great|communication/i.test(r.text))r.tags.push('Good communication');data.reviews.push(r);const t=technicianFor(data,booking.technicianId);if(t){const rs=data.reviews.filter(x=>x.technicianId===t.id);t.rating=Number((rs.reduce((s,x)=>s+x.rating,0)/rs.length).toFixed(1));t.reviews=rs.length;}audit(data,me,'CREATE','Review',r.id);await savePersistent(data);return json(res,201,{success:true,review:r});
  }
  if(req.method==='GET'&&url.pathname==='/api/messages'){
    if(!me)return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'});const bookingId=url.searchParams.get('bookingId');return json(res,200,{success:true,messages:data.messages.filter(m=>(!bookingId||m.bookingId===bookingId)&&(m.participantIds?.includes(me.id)||me.role==='admin'))});
  }
  if(req.method==='POST'&&url.pathname==='/api/messages'){
    if(!me)return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'});const b=await readBody(req);const booking=data.bookings.find(x=>x.id===b.bookingId);const participants=booking?[booking.customerId,technicianFor(data,booking.technicianId)?.userId].filter(Boolean):[me.id];const m={id:id('m'),bookingId:b.bookingId||null,senderId:me.id,participantIds:participants,text:String(b.text||'').trim(),createdAt:now()};if(!m.text)return json(res,400,{success:false,message:'Message is required',code:'VALIDATION'});data.messages.push(m);participants.filter(x=>x!==me.id).forEach(x=>notify(data,x,'New NearFix chat message.'));await savePersistent(data);return json(res,201,{success:true,message:m});
  }
  if(req.method==='GET'&&url.pathname==='/api/notifications'){
    if(!me)return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'});return json(res,200,{success:true,notifications:data.notifications.filter(n=>n.userId===me.id)});
  }
  if(req.method==='PATCH'&&url.pathname==='/api/notifications/read'){
    if(!me)return json(res,401,{success:false,message:'Unauthorized',code:'UNAUTHORIZED'});data.notifications.filter(n=>n.userId===me.id).forEach(n=>n.read=true);await savePersistent(data);return json(res,200,{success:true});
  }
  if(req.method==='POST'&&url.pathname==='/api/disputes'){
    if(!me||me.role!=='customer')return json(res,403,{success:false,message:'Customer access required',code:'FORBIDDEN'});const b=await readBody(req);const d={id:id('dsp'),bookingId:b.bookingId||null,customerId:me.id,technicianId:b.technicianId||null,reason:b.reason||'Other',subject:b.subject||'Service issue',details:b.details||'',status:'OPEN',createdAt:now(),messages:[]};data.disputes.push(d);audit(data,me,'CREATE','Dispute',d.id);await savePersistent(data);return json(res,201,{success:true,dispute:d});
  }

  if(req.method==='POST'&&url.pathname==='/api/admin/admins')return json(res,410,{success:false,message:'Provision administrators in Supabase using the documented owner-only SQL process.',code:'ADMIN_PROVISIONING_DISABLED'});

  if(req.method==='POST'&&url.pathname==='/api/admin/parts'){
    if(!me||me.role!=='admin')return json(res,403,{success:false,message:'Admin access required',code:'FORBIDDEN'});
    const b=await readBody(req); if(!b.name||!b.barcode||!Number.isFinite(Number(b.price)))return json(res,400,{success:false,message:'Name, barcode and price are required',code:'VALIDATION'});
    if((data.parts||[]).some(p=>p.barcode===String(b.barcode)))return json(res,409,{success:false,message:'Barcode already exists',code:'DUPLICATE_BARCODE'});
    const p={id:id('part'),barcode:String(b.barcode).trim(),name:String(b.name).trim(),category:String(b.category||'General').trim(),brand:String(b.brand||'NearFix Supply').trim(),price:Number(b.price),unit:String(b.unit||'piece'),stock:Number(b.stock||0),image:String(b.image||'assets/parts/led-bulb.svg'),description:String(b.description||''),compatible:Array.isArray(b.compatible)?b.compatible:[]}; data.parts.push(p); audit(data,me,'CREATE','Part',p.id,{barcode:p.barcode}); await savePersistent(data); return json(res,201,{success:true,part:p});
  }
  if(req.method==='PATCH'&&url.pathname.startsWith('/api/admin/parts/')){
    if(!me||me.role!=='admin')return json(res,403,{success:false,message:'Admin access required',code:'FORBIDDEN'});
    const pid=url.pathname.split('/').pop(); const p=(data.parts||[]).find(x=>x.id===pid); if(!p)return json(res,404,{success:false,message:'Part not found',code:'PART_NOT_FOUND'});
    const b=await readBody(req); ['name','barcode','category','brand','unit','image','description'].forEach(k=>{if(typeof b[k]==='string'&&b[k].trim())p[k]=b[k].trim();}); if(Number.isFinite(Number(b.price)))p.price=Number(b.price); if(Number.isFinite(Number(b.stock)))p.stock=Number(b.stock); if(Array.isArray(b.compatible))p.compatible=b.compatible; audit(data,me,'UPDATE','Part',pid,b); await savePersistent(data); return json(res,200,{success:true,part:p});
  }
  if(req.method==='DELETE'&&url.pathname.startsWith('/api/admin/parts/')){
    if(!me||me.role!=='admin')return json(res,403,{success:false,message:'Admin access required',code:'FORBIDDEN'});
    const pid=url.pathname.split('/').pop(); const before=(data.parts||[]).length; data.parts=(data.parts||[]).filter(x=>x.id!==pid); if(data.parts.length===before)return json(res,404,{success:false,message:'Part not found',code:'PART_NOT_FOUND'}); audit(data,me,'DELETE','Part',pid); await savePersistent(data); return json(res,200,{success:true});
  }

  if(req.method==='GET'&&url.pathname==='/api/admin/analytics'){
    if(!me||me.role!=='admin')return json(res,403,{success:false,message:'Admin access required',code:'FORBIDDEN'});const completed=data.bookings.filter(b=>b.status==='COMPLETED');const revenue=data.payments.filter(p=>p.status==='SUCCESS').reduce((s,p)=>s+p.amount,0);const categories=data.bookings.reduce((m,b)=>(m[b.service]=(m[b.service]||0)+1,m),{});const complaintThemes=data.reviews.flatMap(r=>r.tags||[]).reduce((m,t)=>(m[t]=(m[t]||0)+1,m),{});return json(res,200,{success:true,metrics:{users:data.users.length,technicians:data.technicians.length,verifiedTechnicians:data.technicians.filter(t=>t.verified).length,activeBookings:data.bookings.filter(b=>!['COMPLETED','CANCELLED'].includes(b.status)).length,completedBookings:completed.length,revenue,openDisputes:data.disputes.filter(d=>d.status==='OPEN').length,pendingVerification:data.technicians.filter(t=>!t.verified).length},charts:{categories,complaintThemes},recentBookings:data.bookings.slice(-10).reverse().map(b=>bookingView(data,b)),pendingTechnicians:data.technicians.filter(t=>!t.verified),disputes:data.disputes,payments:data.payments});
  }
  if(req.method==='PATCH'&&url.pathname.startsWith('/api/admin/technicians/')){
    if(!me||me.role!=='admin')return json(res,403,{success:false,message:'Admin access required',code:'FORBIDDEN'});const tid=url.pathname.split('/').pop();const t=technicianFor(data,tid);if(!t)return json(res,404,{success:false,message:'Technician not found',code:'NOT_FOUND'});const b=await readBody(req);Object.assign(t,{...('verified'in b&&{verified:Boolean(b.verified)}),...('identityVerified'in b&&{identityVerified:Boolean(b.identityVerified)}),...('skillVerified'in b&&{skillVerified:Boolean(b.skillVerified)}),...('experienceVerified'in b&&{experienceVerified:Boolean(b.experienceVerified)})});audit(data,me,'VERIFY','Technician',tid,b);await savePersistent(data);return json(res,200,{success:true,technician:technicianView(data,t)});
  }
  if(req.method==='PATCH'&&url.pathname.startsWith('/api/admin/disputes/')){
    if(!me||me.role!=='admin')return json(res,403,{success:false,message:'Admin access required',code:'FORBIDDEN'});const did=url.pathname.split('/').pop();const d=data.disputes.find(x=>x.id===did);if(!d)return json(res,404,{success:false,message:'Dispute not found',code:'NOT_FOUND'});const b=await readBody(req);d.status=b.status||d.status;d.resolution=b.resolution||d.resolution||'';audit(data,me,'RESOLVE','Dispute',did,b);await savePersistent(data);return json(res,200,{success:true,dispute:d});
  }
  return json(res,404,{success:false,message:'API route not found',code:'NOT_FOUND'});
}

function serve(req,res){
  let pathname=decodeURIComponent(req.url.split('?')[0]); if(pathname==='/')pathname='/index.html';
  const full=path.normalize(path.join(FRONTEND,pathname)); if(!full.startsWith(FRONTEND))return res.writeHead(403).end('Forbidden');
  fs.readFile(full,(err,data)=>{ if(err){fs.readFile(path.join(FRONTEND,'index.html'),(e,d)=>{if(e){res.writeHead(404);return res.end('Not found');}res.writeHead(200,{'Content-Type':mime['.html'],'Cache-Control':'no-cache'});res.end(d);});return;}res.writeHead(200,{'Content-Type':mime[path.extname(full).toLowerCase()]||'application/octet-stream','Cache-Control':'no-cache'});res.end(data); });
}

async function requestHandler(req,res){
  try{
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(url.pathname.startsWith('/api/')) return await api(req,res,url);
    serve(req,res);
  }catch(e){
    console.error(e);
    json(res,500,{success:false,message:e.message||'Internal server error',code:'SERVER_ERROR'});
  }
}

const server=http.createServer(requestHandler);

function listen(port){
  server.once('error',err=>{
    if(err.code==='EADDRINUSE') return listen(port+1);
    throw err;
  });
  server.listen(port,'0.0.0.0',()=>console.log(`NearFix API + web running at http://0.0.0.0:${port}`));
}

if(require.main===module) listen(PORT);

module.exports = requestHandler;
