/* ShiftWeaver static demo app (vanilla JS)
   - pages: home, post, manager, worker, simulator
   - uses localStorage to persist shifts, workers, applications
   - simple matching & dynamic pricing heuristics for demo
*/

const STORAGE = {
  SHIFTS: 'sw_shifts_v1',
  WORKERS: 'sw_workers_v1',
  APPS: 'sw_apps_v1',
  ACTIVITY: 'sw_activity_v1'
};

function uid(prefix='id'){ return prefix + '_' + Math.random().toString(36).slice(2,9); }

function nowISO(){ return new Date().toISOString(); }

function loadData(key, fallback){ try { return JSON.parse(localStorage.getItem(key)||'null') || fallback; } catch(e){ return fallback; } }
function saveData(key, val){ localStorage.setItem(key, JSON.stringify(val)); }

// Seed sample data if empty
function seedIfNeeded(){
  if(!localStorage.getItem(STORAGE.SHIFTS)){
    const sample = [
      { id:'s1', business:'Corner Cafe', location:'10 Main St', start: new Date(Date.now()+3600*1000).toISOString(), end: new Date(Date.now()+3600*1000*4).toISOString(), wage:15, skills:['barista'], status:'open', posted_at: nowISO(), fallback_seconds:15 },
      { id:'s2', business:'Green Grocery', location:'2 Oak Ave', start: new Date(Date.now()+7200*1000).toISOString(), end: new Date(Date.now()+7200*1000*5).toISOString(), wage:18, skills:['stocking','cashier'], status:'open', posted_at: nowISO(), fallback_seconds:20 }
    ];
    saveData(STORAGE.SHIFTS, sample);
  }
  if(!localStorage.getItem(STORAGE.WORKERS)){
    const workers = [
      { id:'w1', name:'Alex', skills:['barista','cashier'], rating:4.8, assigned:0 },
      { id:'w2', name:'Sam', skills:['cashier'], rating:4.2, assigned:0 },
      { id:'w3', name:'Priya', skills:['barista','stocking'], rating:4.9, assigned:0 },
      { id:'w4', name:'Jordan', skills:['stocking'], rating:4.0, assigned:0 }
    ];
    saveData(STORAGE.WORKERS, workers);
  }
  if(!localStorage.getItem(STORAGE.APPS)) saveData(STORAGE.APPS, []);
  if(!localStorage.getItem(STORAGE.ACTIVITY)) saveData(STORAGE.ACTIVITY, []);
}

/* simple activity log */
function pushActivity(text){
  const log = loadData(STORAGE.ACTIVITY, []);
  log.unshift({id: uid('act'), ts: nowISO(), text});
  saveData(STORAGE.ACTIVITY, log.slice(0,200));
}

/* simple dynamic pricing suggestion:
   - if few workers with required skill, add surcharge
   - returns suggested wage
*/
function suggestDynamicPrice(shift){
  const workers = loadData(STORAGE.WORKERS, []);
  const skillSet = new Set(shift.skills || []);
  const skilled = workers.filter(w => (w.skills || []).some(s => skillSet.has(s)));
  const base = Number(shift.wage) || 12;
  if(skilled.length <= 2) return Math.round(base * 1.35);
  if(skilled.length <= 5) return Math.round(base * 1.15);
  return base;
}

/* Basic matching function (scores workers for a shift):
   Score factors: skill match, rating, assigned count (for fairness)
*/
function scoreWorkerForShift(worker, shift, options={fairness:false}){
  let score = 0;
  const skillMatch = (worker.skills || []).filter(s => shift.skills.includes(s)).length;
  score += skillMatch * 30;
  score += (worker.rating || 3) * 10;
  // fewer past assignments favored for fairness
  score += (options.fairness ? Math.max(0, 20 - (worker.assigned || 0) * 5) : 0);
  return score;
}

/* When shift is posted, create ranked offer list and send offers sequentially
   For demo we simulate offers using timeouts and localStorage APPS entries
*/
function processNewShift(shift){
  const workers = loadData(STORAGE.WORKERS, []);
  const options = { fairness: !!shift.fairness };
  // compute score and sort desc
  const scored = workers.map(w => ({ w, score: scoreWorkerForShift(w, shift, options) }))
                      .sort((a,b)=> b.score - a.score)
                      .map(s=> s.w);

  const apps = loadData(STORAGE.APPS, []);
  // simulate sending offers sequentially with expiry fallback
  const offerTTL = Math.max(5, (shift.fallback_seconds || 12)); // seconds before fallback to auto-fill
  // create app entries for top N workers (we simulate top 6)
  const candidates = scored.slice(0, Math.min(12, scored.length));
  candidates.forEach((worker, idx) => {
    const app = {
      id: uid('app'),
      shiftId: shift.id,
      workerId: worker.id,
      status: 'offered',
      offered_wage: shift.wage,
      offer_sent_at: nowISO(),
      offer_expires_at: new Date(Date.now() + offerTTL*1000).toISOString(),
    };
    apps.unshift(app);
    pushActivity(`Offer sent to ${worker.name} for ${shift.business} ($${shift.wage}/hr)`);
  });
  saveData(STORAGE.APPS, apps);
  // schedule auto-fill fallback after fallback_seconds
  setTimeout(()=> autoFillShift(shift.id), (shift.fallback_seconds || 12) * 1000);
}

/* autoFillShift: check apps for accepted; if none, assign top candidate automatically */
function autoFillShift(shiftId){
  const shifts = loadData(STORAGE.SHIFTS, []);
  const shift = shifts.find(s=>s.id===shiftId);
  if(!shift || shift.status !== 'open') return;
  const apps = loadData(STORAGE.APPS, []);
  const shiftApps = apps.filter(a=>a.shiftId===shiftId && a.status==='offered');
  if(shiftApps.length === 0){
    pushActivity(`No offers available to auto-fill shift ${shift.business}`);
    return;
  }
  // pick highest-scored available worker (recompute to be consistent)
  const workers = loadData(STORAGE.WORKERS, []);
  const candidates = shiftApps.map(a => workers.find(w=>w.id===a.workerId)).filter(Boolean);
  if(candidates.length === 0){
    pushActivity(`No candidate workers for ${shift.business}`);
    return;
  }
  candidates.sort((a,b)=> scoreWorkerForShift(b, shift,{ fairness: !!shift.fairness }) - scoreWorkerForShift(a, shift,{ fairness: !!shift.fairness }));
  const chosen = candidates[0];
  // create assignment
  assignWorkerToShift(chosen.id, shiftId);
  // mark apps for this shift as closed
  const updatedApps = apps.map(a => a.shiftId===shiftId ? {...a, status: a.workerId===chosen.id ? 'accepted' : 'no_response'} : a);
  saveData(STORAGE.APPS, updatedApps);
  pushActivity(`Auto-filled: ${chosen.name} assigned to ${shift.business}`);
}

/* assignWorkerToShift: mark shift assigned and increment worker assigned count */
function assignWorkerToShift(workerId, shiftId){
  const shifts = loadData(STORAGE.SHIFTS, []);
  const idx = shifts.findIndex(s=>s.id===shiftId);
  if(idx===-1) return;
  shifts[idx].status = 'assigned';
  shifts[idx].assigned_to = workerId;
  shifts[idx].assigned_at = nowISO();
  saveData(STORAGE.SHIFTS, shifts);

  const workers = loadData(STORAGE.WORKERS, []);
  const wi = workers.find(w=>w.id===workerId);
  if(wi){ wi.assigned = (wi.assigned||0) + 1; saveData(STORAGE.WORKERS, workers); }

  // create a payment placeholder
  pushActivity(`Shift ${shifts[idx].business} assigned to ${wi ? wi.name : workerId}`);
}

/* Worker accept flow (from worker page) */
function workerAccept(appId, workerName){
  const apps = loadData(STORAGE.APPS, []);
  const app = apps.find(a=>a.id===appId);
  if(!app) return alert('Offer not found');
  if(app.status !== 'offered') return alert('Offer already closed');
  app.status = 'accepted';
  app.accepted_at = nowISO();
  saveData(STORAGE.APPS, apps);
  assignWorkerToShift(app.workerId, app.shiftId);
  pushActivity(`${workerName || app.workerId} accepted offer for shift ${app.shiftId}`);
}

/* UI helpers for each page */
function renderHome(){
  const shifts = loadData(STORAGE.SHIFTS, []);
  const open = shifts.filter(s=>s.status==='open');
  const listEl = document.getElementById('shiftList');
  if(!listEl) return;
  if(open.length===0) listEl.textContent = 'No open shifts.';
  else listEl.innerHTML = open.map(s=>`<div><strong>${s.business}</strong> • $${s.wage}/hr • ${s.skills ? s.skills.join(', ') : ''} <div class="muted small">Posted: ${new Date(s.posted_at).toLocaleString()}</div></div>`).join('');
  renderActivity();
}

function renderManager(){
  const shifts = loadData(STORAGE.SHIFTS, []);
  const apps = loadData(STORAGE.APPS, []);
  const activity = loadData(STORAGE.ACTIVITY, []);
  document.getElementById('kpiOpen').textContent = shifts.filter(s=>s.status==='open').length;
  // simple fill rate: assigned / total (demo)
  const assigned = shifts.filter(s=>s.status==='assigned').length;
  const total = shifts.length;
  document.getElementById('kpiFill').textContent = total ? Math.round(assigned/total*100) + '%' : '—';
  // avg time to fill: compute difference between posted_at and assigned_at for assigned shifts
  const assignedShifts = shifts.filter(s=>s.status==='assigned' && s.assigned_at && s.posted_at);
  if(assignedShifts.length){
    const avgMs = assignedShifts.reduce((acc,s)=> acc + (new Date(s.assigned_at) - new Date(s.posted_at)), 0) / assignedShifts.length;
    document.getElementById('kpiAvgTime').textContent = Math.round(avgMs/1000) + 's';
  } else document.getElementById('kpiAvgTime').textContent = '—';

  const mgrList = document.getElementById('mgrShiftList');
  mgrList.innerHTML = shifts.slice(0,20).map(s=>`<div><strong>${s.business}</strong> • ${s.status} • $${s.wage}/hr <div class="muted small">Posted: ${new Date(s.posted_at).toLocaleString()} ${s.assigned_at ? ' • Assigned: '+new Date(s.assigned_at).toLocaleString() : ''}</div></div>`).join('');

  const actEl = document.getElementById('activityLog');
  actEl.innerHTML = activity.slice(0,50).map(a=>`<div>${new Date(a.ts).toLocaleTimeString()} • ${a.text}</div>`).join('');
}

function renderWorker(){
  const offersEl = document.getElementById('offers');
  const acceptedEl = document.getElementById('accepted');
  const apps = loadData(STORAGE.APPS, []);
  const workers = loadData(STORAGE.WORKERS, []);
  const workerSettings = loadData('sw_worker_settings', { id:null, name:'Worker', skills:[] });
  // show offers addressed to this worker if any, else show all offered for demo
  let offers = apps.filter(a=> a.status === 'offered');
  if(workerSettings.id){
    offers = offers.filter(a=> a.workerId === workerSettings.id);
  }

  offersEl.innerHTML = offers.length ? offers.map(a=>{
    const shift = (loadData(STORAGE.SHIFTS,[]).find(s=>s.id===a.shiftId) || {});
    const worker = workers.find(w=>w.id===a.workerId) || {name:a.workerId};
    return `<div><strong>${shift.business || 'Shift'}</strong> • $${a.offered_wage}/hr <div class="muted small">${worker.name} • Expires: ${new Date(a.offer_expires_at).toLocaleTimeString()}</div>
      <div style="margin-top:6px"><button class="btn small" onclick="acceptOffer('${a.id}')">Accept</button> <button class="btn ghost small" onclick="declineOfferUI('${a.id}')">Decline</button></div></div>`;
  }).join('') : 'No offers right now.';

  const accepted = apps.filter(a=> a.status === 'accepted');
  acceptedEl.innerHTML = accepted.length ? accepted.map(a=>{
    const shift = loadData(STORAGE.SHIFTS,[]).find(s=>s.id===a.shiftId) || {};
    return `<div><strong>${shift.business}</strong> • $${a.offered_wage}/hr <div class="muted small">Accepted: ${new Date(a.accepted_at).toLocaleString()}</div></div>`;
  }).join('') : 'No accepted shifts yet.';
}

/* UI actions bound from HTML via global functions for simplicity */
window.acceptOffer = function(appId){
  const name = (document.getElementById('workerName') && document.getElementById('workerName').value) || 'Worker';
  workerAccept(appId, name);
  renderWorker();
};

window.declineOfferUI = function(appId){
  const apps = loadData(STORAGE.APPS, []);
  const app = apps.find(a=>a.id===appId);
  if(!app) return;
  app.status = 'declined';
  saveData(STORAGE.APPS, apps);
  pushActivity(`Offer declined for shift ${app.shiftId}`);
  renderWorker();
};

/* Post page submit handler */
function bindPostForm(){
  const form = document.getElementById('postForm');
  if(!form) return;
  const dynEl = document.getElementById('dynPrice');
  const skillsInput = document.getElementById('skills');
  function updateDyn(){
    const s = {
      wage: Number(document.getElementById('wage').value || 12),
      skills: (skillsInput.value || '').split(',').map(x=>x.trim()).filter(Boolean)
    };
    dynEl.textContent = '$' + suggestDynamicPrice(s);
  }
  document.getElementById('wage').addEventListener('input', updateDyn);
  skillsInput.addEventListener('input', updateDyn);
  updateDyn();

  form.addEventListener('submit', (e)=>{
    e.preventDefault();
    const shift = {
      id: uid('s'),
      business: document.getElementById('business').value || 'Demo Business',
      location: document.getElementById('location').value || '',
      start: document.getElementById('start').value || new Date(Date.now()+3600*1000).toISOString(),
      end: document.getElementById('end').value || new Date(Date.now()+3600*1000*3).toISOString(),
      wage: Number(document.getElementById('wage').value || 12),
      skills: (document.getElementById('skills').value||'').split(',').map(x=>x.trim()).filter(Boolean),
      status: 'open',
      posted_at: nowISO(),
      fallback_seconds: Number(document.getElementById('fallback').value || 12),
      fairness: false
    };
    const shifts = loadData(STORAGE.SHIFTS, []);
    shifts.unshift(shift);
    saveData(STORAGE.SHIFTS, shifts);
    pushActivity(`Shift posted: ${shift.business} $${shift.wage}/hr`);
    processNewShift(shift); // simulate offer sending
    document.getElementById('postResult').style.display='block';
    document.getElementById('postResult').textContent = `Shift posted (demo). Dynamic suggestion: $${suggestDynamicPrice(shift)}. Offers will be simulated.`;
    setTimeout(()=> { window.location.href = 'manager.html'; }, 1200);
  });
}

/* Worker page bindings */
function bindWorkerPage(){
  const saveBtn = document.getElementById('saveWorker');
  if(!saveBtn) return;
  const nameIn = document.getElementById('workerName');
  const skillsIn = document.getElementById('workerSkills');

  // load worker settings if any
  const ws = loadData('sw_worker_settings', { id:null, name:'Worker', skills:[] });
  nameIn.value = ws.name || '';
  skillsIn.value = (ws.skills || []).join(', ');

  saveBtn.addEventListener('click', ()=>{
    const workers = loadData(STORAGE.WORKERS, []);
    // if settings match a worker exists, pick it; else create a demo worker
    const name = nameIn.value || 'Worker';
    const skills = (skillsIn.value || '').split(',').map(x=>x.trim()).filter(Boolean);
    let existing = workers.find(w=>w.name.toLowerCase() === name.toLowerCase());
    if(!existing){
      existing = { id: uid('w'), name, skills, rating:4.5, assigned:0 };
      workers.push(existing);
      saveData(STORAGE.WORKERS, workers);
    } else {
      existing.skills = skills;
      saveData(STORAGE.WORKERS, workers);
    }
    saveData('sw_worker_settings', { id: existing.id, name: existing.name, skills: existing.skills });
    pushActivity(`Worker profile saved: ${existing.name}`);
    renderWorker();
  });

  document.getElementById('clearWorker').addEventListener('click', ()=>{
    localStorage.removeItem('sw_worker_settings');
    renderWorker();
  });
}

/* Simulator logic */
function bindSimulator(){
  const workersRange = document.getElementById('simWorkers');
  const latencyRange = document.getElementById('simLatency');
  const wageRange = document.getElementById('simWage');
  const supplyRange = document.getElementById('simSupply');
  const workersVal = document.getElementById('simWorkersVal');
  const latencyVal = document.getElementById('simLatencyVal');
  const wageVal = document.getElementById('simWageVal');
  const supplyVal = document.getElementById('simSupplyVal');
  const fairChk = document.getElementById('fairMode');
  const runBtn = document.getElementById('runSim');
  const clearBtn = document.getElementById('clearSim');

  function updateLabels(){
    workersVal.textContent = workersRange.value;
    latencyVal.textContent = latencyRange.value;
    wageVal.textContent = wageRange.value;
    supplyVal.textContent = supplyRange.value;
  }
  [workersRange,latencyRange,wageRange,supplyRange].forEach(el=> el.addEventListener('input', updateLabels));
  updateLabels();

  runBtn.addEventListener('click', ()=>{
    // build synthetic workers
    const W = Number(workersRange.value);
    const AVG_LAT = Number(latencyRange.value); // seconds
    const BASE_WAGE = Number(wageRange.value);
    const SUPPLY = Number(supplyRange.value); // workers per shift
    const FAIR = fairChk.checked;

    // create workers arr
    const workers = Array.from({length: W}).map((_,i)=>({
      id: uid('simw'),
      name: 'W'+(i+1),
      rating: 3 + Math.round(Math.random()*20)/10,
      assigned: 0
    }));

    // run N simulated shifts
    const N = 200;
    let filled = 0;
    let totalFillTime = 0;
    const assignmentCounts = {}; // name => count

    for(let s=0;s<N;s++){
      // pick a random shift skills/urgency: simulate low/high perish -> urgency
      const shift = { id: uid('simsh'), wage: BASE_WAGE, skills: [], fairness: FAIR, fallback_seconds: 5 };
      // each shift needs SUPPLY workers
      // for each worker compute response time ~ exponential around AVG_LAT
      const responses = workers.map(w => {
        // response probability decreases with lower wage
        const respProb = Math.min(0.95, 0.3 + BASE_WAGE/40 + (Math.random()*0.2));
        const responded = Math.random() < respProb;
        const respTime = Math.max(0.5, Math.random()*AVG_LAT*1.8);
        return { w, responded, respTime, score: (1/(1+Math.abs(w.assigned - (AVG_LAT/3)))) };
      });

      // filter responders and sort by (respTime, fairness)
      const responders = responses.filter(r=>r.responded).sort((a,b)=>{
        // prefer faster responders and lower assigned if fairness true
        let va = a.respTime - b.respTime;
        if(FAIR) va += (a.w.assigned - b.w.assigned) * 0.4;
        return va;
      });

      // pick top SUPPLY
      const chosen = responders.slice(0, SUPPLY);
      if(chosen.length >= SUPPLY){
        filled++;
        // fill time is max of chosen respTime (we wait for last needed)
        const fillTime = Math.max(...chosen.map(c=>c.respTime));
        totalFillTime += fillTime;
        chosen.forEach(c => {
          c.w.assigned = (c.w.assigned||0) + 1;
          assignmentCounts[c.w.name] = (assignmentCounts[c.w.name]||0) + 1;
        });
      } else {
        // failed to fill
      }
    }

    const fillRate = Math.round(filled / N * 100);
    const avgTime = filled ? (totalFillTime / filled).toFixed(1) : '—';
    // fairness metric: variance of assignmentCounts normalized
    const counts = Object.values(assignmentCounts);
    const mean = counts.length ? counts.reduce((a,b)=>a+b,0)/counts.length : 0;
    const variance = counts.length ? counts.reduce((a,b)=>a + Math.pow(b-mean,2),0)/counts.length : 0;
    const fairnessScore = counts.length ? (1 - Math.min(1, variance / (mean+0.1))) : 1;
    displaySimResult({W, AVG_LAT, BASE_WAGE, SUPPLY, FAIR, fillRate, avgTime, fairnessScore, assignmentCounts});
  });

  clearBtn.addEventListener('click', ()=> {
    document.getElementById('simResult').innerHTML = '';
    document.getElementById('simBars').innerHTML = '';
  });
}

function displaySimResult(res){
  const out = document.getElementById('simResult');
  out.innerHTML = `<div class="muted small"><strong>Fill rate:</strong> ${res.fillRate}% • <strong>Avg time to fill:</strong> ${res.avgTime}s • <strong>Fairness:</strong> ${Math.round(res.fairnessScore*100)}%</div>`;
  // render top assignment counts bar chart
  const counts = res.assignmentCounts;
  const names = Object.keys(counts).sort((a,b)=> counts[b]-counts[a]).slice(0,12);
  const max = names.length ? Math.max(...names.map(n=>counts[n])) : 1;
  const bars = names.map(n=> `<div style="margin:6px 0"><div class="muted small">${n} • ${counts[n]}</div><div style="background:#e6f0ff;border-radius:6px;height:10px;margin-top:6px"><div style="background:var(--primary);height:10px;border-radius:6px;width:${Math.round(counts[n]/max*100)}%"></div></div></div>`).join('');
  document.getElementById('simBars').innerHTML = bars;
}

/* render activity log for home */
function renderActivity(){
  const act = loadData(STORAGE.ACTIVITY, []);
  const el = document.getElementById('activity');
  if(!el) return;
  el.innerHTML = act.slice(0,10).map(a=>`<div>${new Date(a.ts).toLocaleTimeString()} • ${a.text}</div>`).join('');
}

/* initial mount depending on page */
function initShiftWeaver(){
  seedIfNeeded();
  // common renders
  renderHome();
  // page-specific
  if(window.SW_PAGE === 'post') bindPostForm();
  if(window.SW_PAGE === 'manager') renderManager();
  if(window.SW_PAGE === 'worker') { renderWorker(); bindWorkerPage(); }
  if(window.SW_PAGE === 'simulator') bindSimulator();

  // periodic refresh for dynamic pages
  setInterval(()=> {
    if(window.SW_PAGE === 'home') renderHome();
    if(window.SW_PAGE === 'manager') renderManager();
    if(window.SW_PAGE === 'worker') renderWorker();
  }, 2000);
}

/* expose some helpers in console for demo */
window._sw = { loadData, saveData, assignWorkerToShift, processNewShift, suggestDynamicPrice, pushActivity };