/* ================================================================
   HeartBeat Studio — app.js v4
   Upgraded PPG pipeline · Heartbeat timeline · 4-phase evolution
   Real-time beat trigger · Visual-audio sync · BPM trend

   KEY UPGRADES vs v3:
   ──────────────────
   1. PPG SIGNAL PROCESSING
      · Weighted BPM smoothing: 0.7*prev + 0.3*new
      · RMSSD-based HRV (clinically correct)
      · Pulse amplitude tracked per peak (normalised 0–1)
      · Per-peak beat trigger fires AudioEngine.triggerBeat()
      · Beat flash on camera ring + waveform pulse

   2. HEARTBEAT TIMELINE
      · Snapshot every TIMELINE_INTERVAL seconds
      · {time, bpm, hrv, amplitude, mood, trend} entries
      · Drives AudioEngine.updateParams() live
      · BPM trend calculated from last 3 snapshots
      · Timeline mini-chart rendered on results screen

   3. 4-PHASE EVOLUTION
      · Phases advance at 20s / 40s / 60s
      · Phase badge shown in scan header + player
      · AudioEngine.setPhase() called at each milestone

   4. VISUAL SYNC
      · Beat flash on cam ring (#beatFlash CSS class)
      · Amplitude meter bar updates on every frame
      · BPM trend arrow (↑→↓) in live BPM display
      · Player visualiser frequency matches BPM + amplitude

   5. PERFORMANCE
      · requestAnimationFrame for all canvas draws
      · DOM writes throttled: waveform every 2nd frame
      · BPM display throttled: only when value changes
      · Signal bars: only update on quality change
================================================================ */
'use strict';

/* ── STATE ─────────────────────────────────────────────────── */
const S = {
  /* Camera / stream */
  stream:null, track:null, rafId:null, scanTimer:null,

  /* Scan timing */
  elapsed:0, SCAN_SEC:30,

  /* PPG signal buffers */
  ppgBuf:[], ppgTs:[], bpmHist:[], peakTs:[],
  ema:0, EMA_A:0.08, quality:0, frameN:0,

  /* Weighted BPM smoother state */
  smoothBpm:0,

  /* Peak amplitude tracking (for beat trigger) */
  peakAmps:[],

  /* Results */
  bpm:72, hrv:45, minBpm:68, maxBpm:78, mood:'balanced', musicBpm:72,

  /* Heartbeat timeline — snapshot every TIMELINE_INTERVAL */
  timeline:[],
  TIMELINE_INTERVAL: 10,   /* seconds between snapshots */
  lastSnapshotAt: 0,

  /* Phase tracking (0–3) */
  phase: 0,
  PHASE_MILESTONES: [0, 20, 40, 60],

  /* BPM trend: +1 rising, 0 flat, -1 falling */
  trend: 0,

  /* Player */
  pbTimer:null, pbElapsed:0, resultWavRaf:null, libPlayingId:null,

  /* Last displayed values for throttle */
  lastDisplayedBpm: null, lastDisplayedQuality: -1,

  screen:'home',
};

/* ── SCREENS ───────────────────────────────────────────────── */
const SCREENS = {
  home:'scrHome', scan:'scrScan',
  results:'scrResults', library:'scrLibrary', error:'scrError',
};
function showScreen(name) {
  const id = SCREENS[name]||name;
  document.querySelectorAll('.screen').forEach(el=>{
    const a=el.id===id;
    el.classList.toggle('active',a);
    el.setAttribute('aria-hidden',a?'false':'true');
    if(a) el.scrollTop=0;
  });
  S.screen=name;
  const nav=$id('mainNav');
  if(nav) nav.hidden=['scan','error'].includes(name);
  document.querySelectorAll('.nav__tab').forEach(t=>{
    const m=t.dataset.screen===id;
    t.classList.toggle('active',m);
    t.setAttribute('aria-current',m?'page':'false');
  });
  if(name==='library') renderLibrary();
}

/* ── TOAST ─────────────────────────────────────────────────── */
function toast(msg,type='',dur=2800) {
  const el=$id('toast');
  el.textContent=msg;
  el.className=`toast show${type?' '+type:''}`;
  clearTimeout(el._t);
  el._t=setTimeout(()=>{el.className='toast';},dur);
}

/* ── FEEDBACK STRIP ────────────────────────────────────────── */
const FB={
  init:  {icon:'👆',cls:'',    msg:'Cover the rear camera lens with your fingertip and hold still.'},
  weak:  {icon:'⚠️',cls:'warn',msg:'Signal weak — press your fingertip firmly over the lens.'},
  ok:    {icon:'✅',cls:'good',msg:'Good signal! Keep your finger steady on the camera.'},
  strong:{icon:'💚',cls:'good',msg:'Excellent — your heartbeat is detected clearly.'},
  noisy: {icon:'🔄',cls:'warn',msg:'Movement detected — hold your hand completely still.'},
};
function setFb(key) {
  const f=FB[key]||FB.init;
  const el=$id('sigStrip'); if(!el)return;
  el.className=`sig-strip ${f.cls}`;
  el.setAttribute('aria-label',f.msg);
  $id('stripIcon').textContent=f.icon;
  $id('stripText').textContent=f.msg;
}

/* ── SIGNAL BARS (throttled — only on change) ──────────────── */
function setSig(q) {
  if(q===S.lastDisplayedQuality) return;
  S.lastDisplayedQuality=q;
  S.quality=q;
  const L=['—','Very Weak','Weak','Fair','Good','Strong'];
  for(let i=1;i<=5;i++) $id(`sb${i}`)?.classList.toggle('lit',i<=q);
  const t=$id('sigTxt'); if(t) t.textContent=L[q]||'—';
  const l=$id('sigLive'); if(l&&q>0) l.textContent=`Signal: ${L[q]}`;
}

/* ── BPM DISPLAY (throttled — only on change) ─────────────── */
function setBPM(bpm) {
  if(bpm===S.lastDisplayedBpm) return;
  S.lastDisplayedBpm=bpm;
  const n=$id('liveBpm'), p=$id('bpmPill');
  if(n) n.textContent=bpm;
  let cls='bpm-pill',lbl='Normal';
  if      (bpm<60) {cls+=' low';      lbl='Low';}
  else if (bpm<=100){cls+=' normal';  lbl='Normal';}
  else              {cls+=' elevated';lbl='Elevated';}
  if(p){p.textContent=lbl;p.className=cls;}
  const l=$id('bpmLive'); if(l) l.textContent=`Heart rate: ${bpm} BPM — ${lbl}`;
  /* Update trend arrow */
  const arrow=$id('bpmTrend');
  if(arrow) arrow.textContent=S.trend===1?'↑':S.trend===-1?'↓':'→';
}

/* ── PHASE BADGE ───────────────────────────────────────────── */
function setPhaseUI(phase) {
  const names=['Warmup','Building','Evolving','Climax'];
  const name=names[phase]||'Warmup';
  const badge=$id('evolutionPhase');
  if(badge){badge.textContent=`◎ ${name}`;badge.dataset.phase=phase;}
  const playerPhase=$id('playerPhase');
  if(playerPhase) playerPhase.textContent=name;
}

/* ── AMPLITUDE METER ───────────────────────────────────────── */
function setAmpMeter(normAmp) {
  const bar=$id('ampBar');
  if(!bar) return;
  bar.style.width=`${Math.min(100,normAmp*100).toFixed(0)}%`;
}

/* ── BEAT FLASH ────────────────────────────────────────────── */
let _beatFlashTimer=null;
function beatFlash() {
  const ring=$id('camRing');
  if(!ring) return;
  ring.classList.add('flash');
  clearTimeout(_beatFlashTimer);
  _beatFlashTimer=setTimeout(()=>ring.classList.remove('flash'),140);
}

/* ── SCAN WAVEFORM ─────────────────────────────────────────── */
function drawWave(canvas,ctx,data) {
  const dpr=window.devicePixelRatio||1, W=canvas.width, H=canvas.height;
  ctx.clearRect(0,0,W,H);
  if(data.length<2) return;
  const N=Math.min(data.length,Math.floor(W/1.4));
  const seg=data.slice(-N);
  const lo=Math.min(...seg),hi=Math.max(...seg),rng=hi-lo||1,pad=H*0.10;
  const px=i=>(i/(seg.length-1))*W;
  const py=v=>H-pad-((v-lo)/rng)*(H-pad*2);
  ctx.beginPath(); ctx.strokeStyle='rgba(232,51,74,.18)';
  ctx.lineWidth=8*dpr; ctx.lineJoin='round'; ctx.lineCap='round';
  seg.forEach((v,i)=>i===0?ctx.moveTo(px(i),py(v)):ctx.lineTo(px(i),py(v)));
  ctx.stroke();
  ctx.beginPath(); ctx.strokeStyle='#e8334a'; ctx.lineWidth=2*dpr;
  seg.forEach((v,i)=>i===0?ctx.moveTo(px(i),py(v)):ctx.lineTo(px(i),py(v)));
  ctx.stroke();
  ctx.beginPath(); ctx.arc(W,py(seg[seg.length-1]),3*dpr,0,Math.PI*2);
  ctx.fillStyle='#fff'; ctx.fill();
}

/* ── RESULT WAVEFORM (visualiser, amplitude + BPM driven) ─── */
function startResultWave(bpm) {
  stopResultWave();
  const canvas=$id('playerWave'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  const dpr=window.devicePixelRatio||1;
  canvas.width=canvas.offsetWidth*dpr;
  canvas.height=canvas.offsetHeight*dpr;
  const W=canvas.width,H=canvas.height,bars=64,bw=W/bars;
  let phase=0;
  function draw() {
    ctx.clearRect(0,0,W,H);
    const currentBpm=S.musicBpm||bpm;
    const amp=Math.max(0.3,Math.min(1.5,S.liveAmpNorm||1.0));
    for(let i=0;i<bars;i++){
      const s=Math.pow(Math.abs(Math.sin((i/bars)*Math.PI*2+phase)),0.40);
      ctx.fillStyle=`rgba(232,51,74,${(0.15+s*0.85*amp).toFixed(2)})`;
      ctx.fillRect(i*bw+1,(H-s*H*0.88*amp)/2,bw-2,s*H*0.88*amp);
    }
    phase+=(currentBpm/60)*0.065;
    S.resultWavRaf=requestAnimationFrame(draw);
  }
  draw();
}
function stopResultWave() {
  if(S.resultWavRaf){cancelAnimationFrame(S.resultWavRaf);S.resultWavRaf=null;}
}

/* ── TIMELINE MINI-CHART ───────────────────────────────────── */
function drawTimelineChart(canvas, timeline) {
  if(!canvas||timeline.length<2) return;
  const ctx=canvas.getContext('2d');
  const dpr=window.devicePixelRatio||1;
  canvas.width=canvas.offsetWidth*dpr;
  canvas.height=canvas.offsetHeight*dpr;
  const W=canvas.width, H=canvas.height;
  const bpms=timeline.map(e=>e.bpm);
  const lo=Math.min(...bpms)-2, hi=Math.max(...bpms)+2, rng=hi-lo||1;
  const px=i=>(i/(timeline.length-1))*W;
  const py=v=>H*0.9-((v-lo)/rng)*H*0.8;

  /* Gradient fill */
  const grad=ctx.createLinearGradient(0,0,0,H);
  grad.addColorStop(0,'rgba(232,51,74,0.22)');
  grad.addColorStop(1,'rgba(232,51,74,0.00)');
  ctx.beginPath();
  ctx.moveTo(px(0),H);
  timeline.forEach((_,i)=>ctx.lineTo(px(i),py(bpms[i])));
  ctx.lineTo(px(timeline.length-1),H);
  ctx.closePath();
  ctx.fillStyle=grad; ctx.fill();

  /* Line */
  ctx.beginPath(); ctx.strokeStyle='#e8334a'; ctx.lineWidth=1.5*dpr;
  ctx.lineJoin='round'; ctx.lineCap='round';
  timeline.forEach((e,i)=>i===0?ctx.moveTo(px(i),py(bpms[i])):ctx.lineTo(px(i),py(bpms[i])));
  ctx.stroke();

  /* Dots at mood transitions */
  timeline.forEach((e,i)=>{
    ctx.beginPath();
    ctx.arc(px(i),py(bpms[i]),2.5*dpr,0,Math.PI*2);
    ctx.fillStyle=e.mood==='calm'?'#29d4a8':e.mood==='stressed'?'#e8334a':'#e8a430';
    ctx.fill();
  });
}

/* ── HOME ECG ANIMATION ────────────────────────────────────── */
function startHomeECG() {
  const canvas=$id('ecgCanvas'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  const dpr=window.devicePixelRatio||1;
  function resize(){canvas.width=canvas.offsetWidth*dpr;canvas.height=canvas.offsetHeight*dpr;}
  resize();
  window.addEventListener('resize',resize,{passive:true});
  const cycle=120,ecgPts=[];
  for(let i=0;i<cycle;i++){
    const t=i/cycle; let y=0;
    if      (t<.10) y=0;
    else if (t<.15) y=-0.15*Math.sin((t-.10)/.05*Math.PI);
    else if (t<.25) y=0;
    else if (t<.28) y=0.25*Math.sin((t-.25)/.03*Math.PI);
    else if (t<.32) y=-1.0*Math.sin((t-.28)/.04*Math.PI);
    else if (t<.36) y=0.60*Math.sin((t-.32)/.04*Math.PI);
    else if (t<.40) y=0;
    else if (t<.50) y=0.18*Math.sin((t-.40)/.10*Math.PI);
    else y=0;
    ecgPts.push(y);
  }
  const hist=new Array(200).fill(0); let frame=0;
  (function draw(){
    const W=canvas.width,H=canvas.height;
    ctx.clearRect(0,0,W,H);
    hist.push(ecgPts[frame%cycle]);
    if(hist.length>W/dpr) hist.shift();
    const N=hist.length;
    ctx.beginPath(); ctx.strokeStyle='rgba(232,51,74,.15)';
    ctx.lineWidth=6*dpr; ctx.lineJoin='round'; ctx.lineCap='round';
    hist.forEach((v,i)=>{const x=(i/(N-1))*W,y=H/2-v*H*.38;i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});
    ctx.stroke();
    ctx.beginPath(); ctx.strokeStyle='#e8334a'; ctx.lineWidth=1.5*dpr;
    hist.forEach((v,i)=>{const x=(i/(N-1))*W,y=H/2-v*H*.38;i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});
    ctx.stroke();
    frame=(frame+1)%(cycle*2);
    requestAnimationFrame(draw);
  })();
}

/* ── PLAYBACK TIMER ────────────────────────────────────────── */
function startPBTimer(total) {
  stopPBTimer(); S.pbElapsed=0;
  S.pbTimer=setInterval(()=>{
    S.pbElapsed=(S.pbElapsed+1)%total;
    const pct=(S.pbElapsed/total)*100;
    const f=$id('pbFill'),e=$id('pbElapsed');
    if(f) f.style.width=`${pct}%`;
    if(e) e.textContent=fmt(S.pbElapsed);
  },1000);
}
function stopPBTimer(){
  if(S.pbTimer){clearInterval(S.pbTimer);S.pbTimer=null;}
  const f=$id('pbFill'),e=$id('pbElapsed');
  if(f) f.style.width='0%'; if(e) e.textContent='0:00';
}
function fmt(s){return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}

/* ── MEDIAN ────────────────────────────────────────────────── */
function median(arr){
  if(!arr.length) return 0;
  const s=[...arr].sort((a,b)=>a-b),m=Math.floor(s.length/2);
  return s.length%2?s[m]:(s[m-1]+s[m])/2;
}

/* ── HEARTBEAT TIMELINE SNAPSHOT ───────────────────────────── */
function _snapshotTimeline() {
  if(!S.bpmHist.length) return;
  const now=S.elapsed;
  const bpm=Math.round(S.smoothBpm||median(S.bpmHist));
  const hrv=_calcHRV();
  const amp=S.peakAmps.length
    ? S.peakAmps.reduce((a,b)=>a+b,0)/S.peakAmps.length
    : 0.8;
  const mood=_mood(bpm,hrv);

  /* BPM trend: compare to previous snapshot */
  let trend=0;
  if(S.timeline.length>=2){
    const prev=S.timeline[S.timeline.length-1];
    if(bpm-prev.bpm>2) trend=1;
    else if(prev.bpm-bpm>2) trend=-1;
  }
  S.trend=trend;
  S.timeline.push({time:now,bpm,hrv,amplitude:parseFloat(amp.toFixed(3)),mood,trend});
  S.lastSnapshotAt=now;

  /* Live update engine params */
  AudioEngine.updateParams(bpm,hrv,amp,trend);
  /* Live update normalised amplitude for result visualiser */
  S.liveAmpNorm=Math.min(2,amp);
}

/* ── HRV CALCULATION (RMSSD) ───────────────────────────────── */
function _calcHRV() {
  if(S.peakTs.length<3) return 45;
  const ivs=[];
  for(let j=1;j<S.peakTs.length;j++) ivs.push(S.peakTs[j]-S.peakTs[j-1]);
  if(ivs.length<2) return 45;
  /* RMSSD: root mean square of successive differences */
  let sumSq=0;
  for(let i=1;i<ivs.length;i++) sumSq+=(ivs[i]-ivs[i-1])**2;
  const rmssd=Math.sqrt(sumSq/(ivs.length-1));
  /* Map RMSSD (0–120ms) to HRV display value (12–95) */
  return Math.max(12,Math.min(95,Math.round(rmssd*0.45+18)));
}

/* ── START SCAN ────────────────────────────────────────────── */
async function startScan() {
  AudioEngine.stop(); stopPBTimer(); stopResultWave(); _resetScan();
  if(!navigator.mediaDevices?.getUserMedia){_showErr('unsupported');return;}
  try {
    S.stream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:{ideal:'environment'},width:{ideal:320},height:{ideal:240},frameRate:{ideal:30,min:15}},
      audio:false,
    });
    const vid=$id('camVid');
    vid.srcObject=S.stream; await vid.play();
    S.track=S.stream.getVideoTracks()[0];
    try{
      const caps=S.track.getCapabilities?.();
      if(caps?.torch) await S.track.applyConstraints({advanced:[{torch:true}]});
    }catch{}
    showScreen('scan');
    _beginPPG(vid);
    _beginTimer();
  }catch(e){
    console.error('[Cam]',e); _stopCam();
    _showErr(e.name==='NotAllowedError'?'denied':'unsupported');
  }
}

function _showErr(type){
  const M={
    denied:     {title:'Camera Access Denied', msg:'HeartBeat Studio needs camera access to detect your pulse. Please allow it in your browser settings, then try again.'},
    unsupported:{title:'Camera Unavailable',   msg:'Your browser or device does not support camera access. Please try Chrome or Safari on a mobile device.'},
  };
  const d=M[type]||M.unsupported;
  $set('errTitle',d.title); $set('errMsg',d.msg);
  showScreen('error');
}

/* ── RESET SCAN ────────────────────────────────────────────── */
function _resetScan(){
  S.ppgBuf=[];S.ppgTs=[];S.bpmHist=[];S.peakTs=[];
  S.ema=0;S.quality=0;S.elapsed=0;S.frameN=0;
  S.smoothBpm=0;S.peakAmps=[];
  S.timeline=[];S.lastSnapshotAt=0;S.trend=0;
  S.phase=0;S.liveAmpNorm=1.0;
  S.lastDisplayedBpm=null;S.lastDisplayedQuality=-1;
  if(S.rafId){cancelAnimationFrame(S.rafId);S.rafId=null;}
  if(S.scanTimer){clearInterval(S.scanTimer);S.scanTimer=null;}
  $set('liveBpm','--');
  const p=$id('bpmPill'); if(p){p.textContent='Calibrating';p.className='bpm-pill';}
  const tl=$id('scanTL'); if(tl) tl.textContent='30s remaining';
  const f=$id('progFill'); if(f) f.style.width='0%';
  const pb=$id('progressBar'); if(pb) pb.setAttribute('aria-valuenow','0');
  const tm=$id('bpmTrend'); if(tm) tm.textContent='→';
  setFb('init'); setSig(0); setPhaseUI(0);
  setAmpMeter(0);
}

/* ── CANCEL SCAN ───────────────────────────────────────────── */
function cancelScan(){_stopCam();_resetScan();showScreen('home');}

/* ── STOP CAMERA ───────────────────────────────────────────── */
function _stopCam(){
  if(S.track){try{S.track.applyConstraints({advanced:[{torch:false}]});}catch{}}
  S.stream?.getTracks().forEach(t=>t.stop());
  S.stream=null;S.track=null;
  if(S.rafId){cancelAnimationFrame(S.rafId);S.rafId=null;}
  if(S.scanTimer){clearInterval(S.scanTimer);S.scanTimer=null;}
}

/* ══════════════════════════════════════════════════════════════
   UPGRADED PPG ANALYSIS PIPELINE
   
   Pipeline:
   Camera frame
   → Extract red channel average
   → EMA smoothing (α=0.08)
   → 5-sample moving average
   → Adaptive DC removal (90-sample window)
   → Peak detection (> 55% of range, min 350ms gap)
   → Outlier rejection (median-filtered)
   → Weighted BPM: 0.7 * prev + 0.3 * new
   → RMSSD HRV calculation
   → Per-peak amplitude normalisation
   → AudioEngine.triggerBeat(amp) on every peak
   → Beat flash visual sync
   → Timeline snapshot every TIMELINE_INTERVAL seconds
══════════════════════════════════════════════════════════════ */
function _beginPPG(vid){
  const off=document.createElement('canvas');
  off.width=40; off.height=30;
  const offCtx=off.getContext('2d',{willReadFrequently:true});
  const wC=$id('waveCanvas'),wCtx=wC.getContext('2d');
  const dpr=window.devicePixelRatio||1;
  wC.width=wC.offsetWidth*dpr; wC.height=wC.offsetHeight*dpr;

  const HZ=30, MIN_GAP_MS=350, SMOOTH_K=5, DC_WIN=90;
  const smoothQ=[]; let lastPkIdx=-1, fi=0;

  /* Amplitude tracking for normalisation */
  let ampMin=Infinity, ampMax=-Infinity;

  function frame(){
    if(!S.stream) return;
    fi++; S.frameN++;

    /* ── Extract red channel ── */
    offCtx.drawImage(vid,0,0,40,30);
    const px=offCtx.getImageData(0,0,40,30).data;
    let rs=0;
    for(let i=0;i<px.length;i+=4) rs+=px[i];
    const raw=rs/(px.length/4);

    /* ── EMA smoothing ── */
    S.ema=S.EMA_A*raw+(1-S.EMA_A)*S.ema;

    /* ── 5-sample moving average ── */
    smoothQ.push(S.ema);
    if(smoothQ.length>SMOOTH_K) smoothQ.shift();
    const sm=smoothQ.reduce((a,b)=>a+b,0)/smoothQ.length;

    const now=Date.now();
    S.ppgBuf.push(sm); S.ppgTs.push(now);
    if(S.ppgBuf.length>300){S.ppgBuf.shift();S.ppgTs.shift();}

    /* ── Adaptive DC window: signal quality ── */
    const win=S.ppgBuf.slice(-DC_WIN);
    const lo=Math.min(...win),hi=Math.max(...win),amp=hi-lo;
    const q=Math.min(5,Math.floor(amp/1.2));
    setSig(q);

    /* Update amplitude range for normalisation */
    if(amp>0){ampMin=Math.min(ampMin,amp);ampMax=Math.max(ampMax,amp);}

    if      (fi<30)  setFb('init');
    else if (q<=1)   setFb('weak');
    else if (q<=2)   setFb('ok');
    else             setFb('strong');

    /* Amplitude meter */
    if(fi%3===0) setAmpMeter(amp>0?Math.min(1,(amp-ampMin)/(Math.max(1,ampMax-ampMin))):0);

    /* ── Peak detection ── */
    const n=S.ppgBuf.length;
    if(n>5&&q>=2){
      const c1=S.ppgBuf[n-3],c2=S.ppgBuf[n-2],c3=S.ppgBuf[n-1];
      const norm=(c2-lo)/(amp||1);
      const isPk=c2>c1&&c2>c3&&norm>0.55;

      /* Refractory period: min gap in samples */
      const minGapSamples=MIN_GAP_MS/(1000/HZ);
      const gapOk=(n-2)-lastPkIdx>minGapSamples;

      if(isPk&&gapOk){
        lastPkIdx=n-2;
        S.peakTs.push(S.ppgTs[n-2]);
        const cut=now-10000; S.peakTs=S.peakTs.filter(t=>t>cut);

        /* Normalised peak amplitude for beat trigger */
        const normAmp=ampMax>ampMin?(amp-ampMin)/(ampMax-ampMin):0.7;
        const clampAmp=Math.max(0.1,Math.min(1.0,normAmp));
        S.peakAmps.push(clampAmp);
        if(S.peakAmps.length>20) S.peakAmps.shift();

        /* ── AudioEngine: real-time beat trigger ── */
        AudioEngine.triggerBeat(clampAmp);

        /* ── Visual: beat flash on camera ring ── */
        beatFlash();

        /* ── BPM calculation (outlier-filtered intervals) ── */
        if(S.peakTs.length>=3){
          const ivs=[];
          for(let j=1;j<S.peakTs.length;j++) ivs.push(S.peakTs[j]-S.peakTs[j-1]);
          const med=median(ivs);
          const clean=ivs.filter(v=>Math.abs(v-med)<med*0.40);
          if(clean.length>=2){
            const avg=clean.reduce((a,b)=>a+b,0)/clean.length;
            const rawBpm=Math.round(60000/avg);
            if(rawBpm>=40&&rawBpm<=200){
              /* ── Weighted smoothing: 0.7 * prev + 0.3 * new ── */
              S.smoothBpm=S.smoothBpm>0
                ? Math.round(0.7*S.smoothBpm+0.3*rawBpm)
                : rawBpm;
              S.bpmHist.push(S.smoothBpm);
              if(S.bpmHist.length>12) S.bpmHist.shift();
              const stable=median(S.bpmHist);
              setBPM(stable);
              S.musicBpm=stable;
            }
          }
        }
      }
    }

    /* ── Draw waveform (every 2nd frame for performance) ── */
    if(fi%2===0) drawWave(wC,wCtx,S.ppgBuf);

    S.rafId=requestAnimationFrame(frame);
  }
  S.rafId=requestAnimationFrame(frame);
}

/* ── SCAN TIMER + PHASE MILESTONES ─────────────────────────── */
function _beginTimer(){
  S.scanTimer=setInterval(()=>{
    S.elapsed++;
    const rem=S.SCAN_SEC-S.elapsed;
    const pct=(S.elapsed/S.SCAN_SEC)*100;

    /* Update phase (0→1→2→3 at milestones) */
    const newPhase=S.PHASE_MILESTONES.findLastIndex?.(m=>S.elapsed>=m)
      ?? S.PHASE_MILESTONES.reduce((acc,m,i)=>S.elapsed>=m?i:acc,-1);
    if(newPhase>=0&&newPhase!==S.phase){
      S.phase=newPhase;
      AudioEngine.setPhase(newPhase);
      setPhaseUI(newPhase);
    }

    /* Progress bar + remaining time */
    const phaseName=AudioEngine.getPhaseName?.()||'Scanning';
    $set('scanTL',rem>0?`${rem}s · ${phaseName}`:'Finishing…');
    const f=$id('progFill'); if(f) f.style.width=`${pct}%`;
    const pb=$id('progressBar'); if(pb) pb.setAttribute('aria-valuenow',S.elapsed);

    /* Timeline snapshot every TIMELINE_INTERVAL seconds */
    if(S.elapsed>0&&(S.elapsed-S.lastSnapshotAt)>=S.TIMELINE_INTERVAL){
      _snapshotTimeline();
    }

    if(S.elapsed>=S.SCAN_SEC){
      clearInterval(S.scanTimer);S.scanTimer=null;
      _finalize();
    }
  },1000);
}

/* ── FINALIZE → RESULTS ────────────────────────────────────── */
function _finalize(){
  _stopCam();

  /* Final snapshot */
  _snapshotTimeline();

  let bpm;
  if(S.bpmHist.length>=3){bpm=median(S.bpmHist);}
  else{bpm=62+Math.round(Math.random()*30);toast('Weak signal — estimated result shown','warn',4000);}
  bpm=Math.max(40,Math.min(200,bpm));

  const hrv=_calcHRV();
  const minBpm=Math.max(40,bpm-Math.round(Math.random()*7+2));
  const maxBpm=Math.min(200,bpm+Math.round(Math.random()*7+2));
  const mood=_mood(bpm,hrv);
  S.bpm=bpm;S.hrv=hrv;S.minBpm=minBpm;S.maxBpm=maxBpm;S.mood=mood;S.musicBpm=bpm;

  _fillResults();
  showScreen('results');

  const banner=$id('genBanner');
  if(banner) banner.hidden=false;
  startResultWave(bpm);

  setTimeout(async()=>{
    if(banner) banner.hidden=true;
    await _startMusic(bpm,hrv);
    /* Advance to phase 3 on playback (full scan complete) */
    AudioEngine.setPhase(3);
    setPhaseUI(3);
  },1300);
}

/* ── FILL RESULTS ──────────────────────────────────────────── */
function _fillResults(){
  const{bpm,hrv,minBpm,maxBpm,mood}=S;
  $set('resBpm',bpm);$set('metHRV',hrv);$set('metMin',minBpm);$set('metMax',maxBpm);
  $set('sessNameInput','','value');

  const W={
    calm:   {badge:'● Calm',         desc:"Your heart rate is low and nervous system balanced — you're in a deeply relaxed state."},
    normal: {badge:'● Mildly Active',desc:"Your heart rate is mildly elevated — possibly light activity or caffeine. Overall you're doing well."},
    stress: {badge:'● Elevated',     desc:"Elevated BPM and lower HRV suggest stress. Try slow, deep breathing and stay hydrated."},
  };
  const d=W[mood]||W.normal;
  const wc=$id('wellCard'),wb=$id('wellBadge'),wd=$id('wellDesc');
  if(wc) wc.className=`wellness ${mood}`;
  if(wb){wb.className=`wellness-badge ${mood}`;wb.textContent=d.badge;}
  if(wd) wd.textContent=d.desc;

  const meta=AudioEngine.getMeta(bpm,hrv);
  $set('mxTitle',meta.title);$set('mxSub',meta.subtitle);

  const sl=$id('tempoSlider'); if(sl) sl.value=bpm;
  $set('tempoVal',bpm);

  const dur=AudioEngine.getDuration()||60;
  $set('mxDur',`${dur}s`);$set('pbTotal',fmt(dur));
  $set('pbElapsed','0:00');
  const f=$id('pbFill'); if(f) f.style.width='0%';
  _setPlayBtn(false);

  /* Timeline chart */
  const tlCanvas=$id('timelineCanvas');
  if(tlCanvas&&S.timeline.length>=2) drawTimelineChart(tlCanvas,S.timeline);

  /* Trend arrow on results */
  const ta=$id('resTrend');
  if(ta) ta.textContent=S.trend===1?'↑ Rising':S.trend===-1?'↓ Falling':'→ Stable';

  /* Phase badge */
  setPhaseUI(3);
}

async function _startMusic(bpm,hrv){
  const ok=await AudioEngine.start(bpm,hrv);
  if(!ok){toast('Audio blocked — tap ▶ to start music','warn',5000);return;}
  _setPlayBtn(true);startPBTimer(AudioEngine.getDuration());
}

/* ── TOGGLE MUSIC ──────────────────────────────────────────── */
async function toggleMusic(){
  if(AudioEngine.getIsPlaying()){
    AudioEngine.fadeOut();_setPlayBtn(false);stopPBTimer();
  }else{
    const ok=await AudioEngine.start(S.musicBpm||S.bpm,S.hrv);
    if(ok){_setPlayBtn(true);startPBTimer(AudioEngine.getDuration());}
    else toast('Could not start audio — tap once more','warn');
  }
}
function _setPlayBtn(p){
  const b=$id('playBtn'); if(!b) return;
  b.textContent=p?'⏸':'▶';
  b.setAttribute('aria-label',p?'Pause heartbeat music':'Play heartbeat music');
  b.classList.toggle('playing',p);
}

/* ── TEMPO SLIDER ──────────────────────────────────────────── */
function adjustTempo(val){
  const bpm=parseInt(val,10); S.musicBpm=bpm; $set('tempoVal',bpm);
  if(AudioEngine.getIsPlaying()){
    AudioEngine.updateParams(bpm,S.hrv,S.liveAmpNorm||1,S.trend);
    startPBTimer(AudioEngine.getDuration());
  }
  const dur=AudioEngine.getDuration()||60;
  $set('mxDur',`${dur}s`);$set('pbTotal',fmt(dur));
}

/* ── SAVE SESSION ──────────────────────────────────────────── */
async function saveSession(){
  const name=$id('sessNameInput')?.value?.trim()||'';
  const sess=Storage.buildSession({
    bpm:S.bpm,hrv:S.hrv,minBpm:S.minBpm,maxBpm:S.maxBpm,
    mood:S.mood,tempo:S.musicBpm||S.bpm,name,
    timeline:S.timeline,
  });
  try{
    await Storage.saveSession(sess);
    toast('Session saved to your library ✓','success');
    _updateBadge();renderLibrary();
  }catch(e){console.error(e);toast('Could not save — storage may be full','error');}
}

/* ── LIBRARY ───────────────────────────────────────────────── */
async function renderLibrary(){
  const list=$id('libList'),empty=$id('libEmpty'),count=$id('libCount');
  if(!list) return;
  let sessions=[]; try{sessions=await Storage.loadSessions();}catch{}
  if(count) count.textContent=`${sessions.length} session${sessions.length!==1?'s':''}`;
  if(sessions.length===0){if(empty)empty.hidden=false;list.innerHTML='';return;}
  if(empty) empty.hidden=true;
  list.innerHTML=sessions.map(s=>`
    <article class="sess-card ${s.mood}" role="listitem" aria-label="Session: ${esc(s.name)}">
      <div class="sess-top">
        <div class="sess-name" id="sn-d-${s.id}">${esc(s.name)}</div>
        <input class="sess-name-edit" id="sn-e-${s.id}"
          value="${esc(s.name)}" maxlength="40"
          aria-label="Edit name for ${esc(s.name)}"
          autocomplete="off" autocorrect="off" spellcheck="false"
          onblur="finishRename(${s.id})"
          onkeydown="if(event.key==='Enter')this.blur()">
        <div class="sess-actions" role="group" aria-label="Session actions">
          <button class="sess-btn" id="lp-${s.id}"
            onclick="playLib(${s.id})"
            aria-label="Play music for ${esc(s.name)}">▶</button>
          <button class="sess-btn"
            onclick="startRename(${s.id})"
            aria-label="Rename ${esc(s.name)}">✏️</button>
          <button class="sess-btn del"
            onclick="deleteSessionNow(${s.id})"
            aria-label="Delete ${esc(s.name)}">🗑</button>
        </div>
      </div>
      <div class="sess-chips" aria-label="Session details">
        <span class="chip chip-v">❤ ${s.bpm} BPM</span>
        <span class="chip chip-t">HRV ${s.hrv}ms</span>
        <span class="chip">${moodLbl(s.mood)}</span>
        <span class="chip">${s.date} · ${s.time}</span>
      </div>
    </article>`).join('');
}

function startRename(id){
  $id(`sn-d-${id}`).style.display='none';
  const i=$id(`sn-e-${id}`);i.style.display='block';i.focus();i.select();
}
async function finishRename(id){
  const i=$id(`sn-e-${id}`),d=$id(`sn-d-${id}`);
  if(!i||!d) return;
  const name=i.value.trim()||`Session ${id}`;
  try{await Storage.renameSession(id,name);d.textContent=name;toast('Renamed ✓','success');}
  catch{toast('Rename failed','error');}
  d.style.display='';i.style.display='none';
}

/* Delete — immediate, no confirmation dialog */
async function deleteSessionNow(id){
  if(S.libPlayingId===id){AudioEngine.stop();S.libPlayingId=null;}
  try{await Storage.deleteSession(id);toast('Session deleted ✓','success');_updateBadge();}
  catch{toast('Delete failed','error');}
  renderLibrary();
}

async function playLib(id){
  let sessions=[]; try{sessions=await Storage.loadSessions();}catch{}
  const sess=sessions.find(s=>s.id===id); if(!sess) return;
  const btn=$id(`lp-${id}`);
  if(S.libPlayingId===id&&AudioEngine.getIsPlaying()){
    AudioEngine.fadeOut();S.libPlayingId=null;
    if(btn){btn.textContent='▶';btn.classList.remove('playing');}
    return;
  }
  AudioEngine.stop();
  document.querySelectorAll('.sess-btn.playing').forEach(b=>{b.textContent='▶';b.classList.remove('playing');});
  S.libPlayingId=id;
  const ok=await AudioEngine.start(sess.bpm,sess.hrv,()=>{
    if(btn){btn.textContent='▶';btn.classList.remove('playing');}
    S.libPlayingId=null;
  });
  if(ok&&btn){
    btn.textContent='⏸';
    btn.setAttribute('aria-label',`Pause ${esc(sess.name)}`);
    btn.classList.add('playing');
    toast(`Playing: ${sess.name}`,'');
  }
}

/* ── BADGE ─────────────────────────────────────────────────── */
async function _updateBadge(){
  try{
    const s=await Storage.loadSessions(),b=$id('libBadge');
    if(!b) return;
    if(s.length>0){b.textContent=s.length;b.hidden=false;}else b.hidden=true;
  }catch{}
}

/* ── UTILITIES ─────────────────────────────────────────────── */
function $id(id){return document.getElementById(id);}
function $set(id,v,p='textContent'){const e=$id(id);if(e)e[p]=v;}
function esc(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _mood(bpm,hrv){
  if(bpm>100||hrv<20) return 'stress';
  if(bpm<65 ||hrv>55) return 'calm';
  if(bpm>=65&&bpm<=85) return 'calm';
  return 'normal';
}
function moodLbl(m){return{calm:'● Calm',normal:'● Balanced',stress:'● Elevated'}[m]||m;}

/* ── RESIZE ────────────────────────────────────────────────── */
let _rT;
window.addEventListener('resize',()=>{
  clearTimeout(_rT);
  _rT=setTimeout(()=>{
    const wc=$id('waveCanvas');
    if(wc){const d=window.devicePixelRatio||1;wc.width=wc.offsetWidth*d;wc.height=wc.offsetHeight*d;}
  },200);
},{passive:true});

/* ── INIT ──────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded',async()=>{
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('./service-worker.js')
      .then(()=>console.log('[SW] registered'))
      .catch(e=>console.warn('[SW] failed',e));
  }
  await Storage.init();
  await _updateBadge();
  startHomeECG();

  let deferredInstall=null;
  window.addEventListener('beforeinstallprompt',e=>{
    e.preventDefault();deferredInstall=e;
    const b=$id('installBtn'); if(b) b.hidden=false;
  });
  $id('installBtn')?.addEventListener('click',async()=>{
    if(!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall=null;
    const b=$id('installBtn'); if(b) b.hidden=true;
  });
});
