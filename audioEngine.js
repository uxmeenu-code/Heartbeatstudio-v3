/* ================================================================
   HeartBeat Studio — audioEngine.js v4
   GENERATIVE BIOMETRIC MUSIC ENGINE

   Every session sounds uniquely different.
   Music evolves in 4 phases driven by scan elapsed time.
   Real-time heartbeat detection fires audio at biological tempo.

   ┌─────────────────────────────────────────────────────────┐
   │  REAL-TIME BIOMETRIC HOOKS (called from app.js)        │
   │  triggerBeat(amplitude) → fires LUB-DUB on each peak   │
   │  updateParams(bpm,hrv,amp,trend) → live update, no gap │
   │  setPhase(0-3) → unlocks instrument layers             │
   │                                                         │
   │  EVOLUTION PHASES                                       │
   │  0 Warmup   0–20s  : heartbeat pulse only              │
   │  1 Building 20–40s : + bass                            │
   │  2 Evolving 40–60s : + melody + percussion             │
   │  3 Climax   60s+   : + pads + full harmony             │
   │                                                         │
   │  BIOMETRIC → MUSICAL MAPPING                           │
   │  BPM       → tempo (live, bar-accurate)                │
   │  HRV       → swing amount + melodic range              │
   │  Amplitude → beat accent volume                        │
   │  BPM trend → melodic contour direction                 │
   │  Mood      → scale, timbre, reverb, patterns           │
   └─────────────────────────────────────────────────────────┘

   CALM     Eb Pentatonic · sine/triangle · long hall reverb
   BALANCED D Dorian      · triangle     · room reverb
   STRESSED B Phrygian    · sawtooth     · tight plate

   Public API (backward-compatible with v3):
     start(bpm, hrv, onStopFn)
     stop() / fadeOut(sec) / resume()
     getMeta(bpm, hrv)
     getDuration() / getIsPlaying()
     triggerBeat(amplitude)    ← NEW
     updateParams(b,h,a,t)     ← NEW
     setPhase(0-3)             ← NEW
     getPhaseName()            ← NEW
================================================================ */
'use strict';

const AudioEngine = (() => {

  /* ════════════════════════════════════════════════════════════
     MOOD PROFILES
  ════════════════════════════════════════════════════════════ */
  const PROFILES = {
    calm: {
      scale:    [155.56,174.61,196.00,233.08,261.63,311.13,349.23,392.00,466.16,523.25],
      bassOct:  [77.78, 116.54],
      modeName: 'Eb Pentatonic', style: 'Ambient Float', moodLabel: 'Deep Calm',
      bassWave: 'sine', melWave: 'triangle', padWave: 'sine', harmWave: 'sine',
      bassAmp: 0.28, padAmp: 0.16, melAmp: 0.20, harmAmp: 0.09,
      bassDecF: 0.95, padDecF: 0.99, melDecF: 0.86, harmDecF: 0.92, attackS: 0.045,
      bassGrid: [1,0,0,0,1,0,0,0], melGrid:  [1,0,1,0,0,1,0,0],
      harmGrid: [0,0,1,0,0,0,1,0], padGrid:  [1,0,0,0,0,0,0,0], padDurMul: 7.6,
      kick: false, snare: false, hihat: false,
      beatLpFreq: 130, beatQ: 5.0, beatGain: 0.11, beatDecayS: 0.068,
      delayRatio: 0.75, delayFB: 0.42, delayWet: 0.30,
      reverbSec: 4.2, reverbWet: 0.40, masterVol: 0.150,
      lfoHz: 0.09, lfoDepth: 0.030, swingBase: 0.026, swingHrvMul: 0.00055,
    },
    balanced: {
      scale:    [146.83,164.81,174.61,196.00,220.00,246.94,261.63,293.66,329.63,349.23],
      bassOct:  [73.42, 110.00],
      modeName: 'D Dorian', style: 'Melodic Flow', moodLabel: 'Balanced',
      bassWave: 'triangle', melWave: 'triangle', padWave: 'sine', harmWave: 'sine',
      bassAmp: 0.34, padAmp: 0.09, melAmp: 0.23, harmAmp: 0.11,
      bassDecF: 0.66, padDecF: 0.88, melDecF: 0.60, harmDecF: 0.70, attackS: 0.016,
      bassGrid: [1,0,0,1,0,0,1,0], melGrid:  [1,0,1,1,0,1,0,1],
      harmGrid: [0,1,0,0,1,0,0,1], padGrid:  [1,0,0,0,1,0,0,0], padDurMul: 3.8,
      kick: true,  kickGrid:  [1,0,0,0,1,0,0,0],
      snare: true, snareGrid: [0,0,1,0,0,0,1,0],
      hihat: true, hihatGrid: [1,1,0,1,1,1,0,1],
      beatLpFreq: 190, beatQ: 4.0, beatGain: 0.20, beatDecayS: 0.095,
      delayRatio: 0.50, delayFB: 0.22, delayWet: 0.16,
      reverbSec: 1.7, reverbWet: 0.18, masterVol: 0.162,
      lfoHz: 0.26, lfoDepth: 0.018, swingBase: 0.012, swingHrvMul: 0.00025,
    },
    stressed: {
      scale:    [246.94,261.63,311.13,329.63,369.99,392.00,440.00,493.88,523.25,587.33],
      bassOct:  [123.47,185.00],
      modeName: 'B Phrygian', style: 'Kinetic Pulse', moodLabel: 'Energised',
      bassWave: 'sawtooth', melWave: 'sawtooth', padWave: 'square', harmWave: 'square',
      bassAmp: 0.22, padAmp: 0.06, melAmp: 0.19, harmAmp: 0.13,
      bassDecF: 0.40, padDecF: 0.48, melDecF: 0.36, harmDecF: 0.44, attackS: 0.006,
      bassGrid: [1,0,1,0,1,1,0,1], melGrid:  [1,1,0,1,1,0,1,1],
      harmGrid: [1,0,0,1,0,1,0,0], padGrid:  [1,0,0,0,0,0,0,0], padDurMul: 1.8,
      kick: true,  kickGrid:  [1,0,1,0,1,0,1,0],
      snare: true, snareGrid: [0,0,1,0,0,1,1,0],
      hihat: true, hihatGrid: [1,1,1,1,1,1,1,1],
      beatLpFreq: 270, beatQ: 5.5, beatGain: 0.34, beatDecayS: 0.066,
      delayRatio: 0.25, delayFB: 0.12, delayWet: 0.08,
      reverbSec: 0.65, reverbWet: 0.08, masterVol: 0.148,
      lfoHz: 0.68, lfoDepth: 0.010, swingBase: 0.004, swingHrvMul: 0.00010,
    },
  };

  const PHASES = {
    0: { name:'Warmup',   layers:['beat']                                    },
    1: { name:'Building', layers:['beat','bass']                             },
    2: { name:'Evolving', layers:['beat','bass','melody','perc']             },
    3: { name:'Climax',   layers:['beat','bass','melody','perc','pad','harm'] },
  };

  const TITLE_WORDS = ['Meridian','Artery','Current','Threshold','Resonance',
    'Drift','Continuum','Orbit','Flux','Tide','Pulse','Reverie'];
  const CHROMATIC   = ['C','C♯','D','Eb','E','F','F♯','G','Ab','A','Bb','B'];

  /* ── State ── */
  let _ctx=null, _master=null, _lfoGain=null, _delay=null, _reverb=null;
  let _allNodes=[], _sched=null, _playing=false;
  let _nextBar=0, _barN=0, _dur=60, _stopCb=null;

  /* Live biometric state — updated without restart */
  let _liveBpm=72, _liveHrv=45, _liveAmp=0.8;
  let _liveMood='balanced', _phase=0, _trend=0;

  /* ════════════════════════════════════════════════════════════
     CONTEXT
  ════════════════════════════════════════════════════════════ */
  function _ctxGet() {
    if (!_ctx || _ctx.state==='closed') {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio not supported');
      _ctx = new AC();
    }
    return _ctx;
  }
  async function resume() {
    const c = _ctxGet();
    if (c.state==='suspended') await c.resume();
    return c;
  }

  function _tr(...ns) { _allNodes.push(...ns); return ns[ns.length-1]; }

  /* ════════════════════════════════════════════════════════════
     REVERB IR (synthesised convolution)
  ════════════════════════════════════════════════════════════ */
  function _makeReverb(c, sizeS) {
    const sr=c.sampleRate, len=Math.ceil(sr*Math.max(0.4,sizeS));
    const ir=c.createBuffer(2,len,sr);
    for (let ch=0;ch<2;ch++) {
      const d=ir.getChannelData(ch);
      for (let i=0;i<len;i++) {
        const pre=i<Math.floor(sr*0.008)?0.05:1.0;
        d[i]=(Math.random()*2-1)*pre*Math.pow(1-i/len,2.1);
      }
    }
    const conv=c.createConvolver();
    conv.buffer=ir;
    return _tr(conv);
  }

  function _noiseBuf(c,ms) {
    const len=Math.ceil(c.sampleRate*ms/1000);
    const buf=c.createBuffer(1,len,c.sampleRate);
    const d=buf.getChannelData(0);
    for (let i=0;i<len;i++) d[i]=Math.random()*2-1;
    return buf;
  }

  /* ════════════════════════════════════════════════════════════
     TONAL NOTE
  ════════════════════════════════════════════════════════════ */
  function _note(c,t,freq,wave,amp,attackS,decayFrac,interval,dest) {
    const osc=c.createOscillator(), env=c.createGain();
    osc.type=wave;
    osc.frequency.setValueAtTime(freq,t);
    env.gain.setValueAtTime(0,t);
    env.gain.linearRampToValueAtTime(amp,t+attackS);
    env.gain.exponentialRampToValueAtTime(0.0001,t+Math.max(attackS+0.01,interval*decayFrac));
    osc.connect(env); env.connect(dest);
    osc.start(t); osc.stop(t+interval+0.05);
    _tr(osc,env);
    return env;
  }

  /* ════════════════════════════════════════════════════════════
     PUBLIC: triggerBeat(amplitude)
     Called by app.js on EVERY detected PPG peak.
     Fires biological LUB-DUB transients in real biological time.
     amplitude: 0.0–1.0 (normalised PPG peak amplitude)
  ════════════════════════════════════════════════════════════ */
  function triggerBeat(amplitude) {
    if (!_ctx || !_master || !_playing) return;
    const c   = _ctx;
    const t   = c.currentTime + 0.010;
    const p   = PROFILES[_liveMood];
    const amp = Math.max(0.05, Math.min(1.0, amplitude||0.7));

    /* LUB — low resonant thump */
    const lubSrc=c.createBufferSource(), lubFlt=c.createBiquadFilter(), lubEnv=c.createGain();
    lubSrc.buffer=_noiseBuf(c,72);
    lubFlt.type='lowpass'; lubFlt.frequency.value=p.beatLpFreq; lubFlt.Q.value=p.beatQ;
    lubEnv.gain.setValueAtTime(0,t);
    lubEnv.gain.linearRampToValueAtTime(p.beatGain*amp, t+0.009);
    lubEnv.gain.exponentialRampToValueAtTime(0.0001, t+p.beatDecayS);
    lubSrc.connect(lubFlt); lubFlt.connect(lubEnv); lubEnv.connect(_master);
    lubSrc.start(t); lubSrc.stop(t+p.beatDecayS+0.01);
    _tr(lubSrc,lubFlt,lubEnv);

    /* DUB — softer echo at ~28% of beat interval */
    const dubT   = t + (60/_liveBpm)*0.28;
    const dubSrc = c.createBufferSource(), dubFlt=c.createBiquadFilter(), dubEnv=c.createGain();
    dubSrc.buffer=_noiseBuf(c,50);
    dubFlt.type='lowpass'; dubFlt.frequency.value=p.beatLpFreq*1.35; dubFlt.Q.value=p.beatQ*0.78;
    dubEnv.gain.setValueAtTime(0,dubT);
    dubEnv.gain.linearRampToValueAtTime(p.beatGain*amp*0.52, dubT+0.007);
    dubEnv.gain.exponentialRampToValueAtTime(0.0001, dubT+p.beatDecayS*0.72);
    dubSrc.connect(dubFlt); dubFlt.connect(dubEnv); dubEnv.connect(_master);
    dubSrc.start(dubT); dubSrc.stop(dubT+p.beatDecayS+0.01);
    _tr(dubSrc,dubFlt,dubEnv);

    /* Phase 1+: add a kick sine-sweep accent */
    if (_phase>=1 && _liveMood!=='calm') {
      const kosc=c.createOscillator(), kenv=c.createGain();
      kosc.type='sine';
      kosc.frequency.setValueAtTime(_liveMood==='stressed'?155:95, t);
      kosc.frequency.exponentialRampToValueAtTime(28, t+0.13);
      kenv.gain.setValueAtTime(0,t);
      kenv.gain.linearRampToValueAtTime(0.36*amp, t+0.005);
      kenv.gain.exponentialRampToValueAtTime(0.0001, t+0.22);
      kosc.connect(kenv); kenv.connect(_master);
      kosc.start(t); kosc.stop(t+0.24);
      _tr(kosc,kenv);
    }
  }

  /* ════════════════════════════════════════════════════════════
     PUBLIC: updateParams(bpm, hrv, amplitude, trend)
     Called every 10s from app.js timeline snapshot.
     Updates live parameters — takes effect on next scheduled bar.
     trend: +1=rising BPM, 0=stable, -1=falling
  ════════════════════════════════════════════════════════════ */
  function updateParams(bpm, hrv, amplitude, trend) {
    _liveBpm  = Math.max(40, Math.min(200, bpm  || _liveBpm));
    _liveHrv  = Math.max(10, Math.min(100, hrv  || _liveHrv));
    _liveAmp  = Math.max(0.1, Math.min(1.5, amplitude || _liveAmp));
    _trend    = trend===1?1:trend===-1?-1:0;
    _liveMood = _moodKey(_liveBpm, _liveHrv);

    /* Smoothly glide delay time to match new BPM */
    if (_delay && _ctx) {
      const newStep = 60 / _liveBpm;
      const newDelayT = newStep * PROFILES[_liveMood].delayRatio;
      _delay.delayTime.linearRampToValueAtTime(newDelayT, _ctx.currentTime+0.8);
    }
  }

  /* ════════════════════════════════════════════════════════════
     PUBLIC: setPhase(0-3)
  ════════════════════════════════════════════════════════════ */
  function setPhase(phase) {
    _phase = Math.max(0, Math.min(3, phase|0));
  }

  /* ════════════════════════════════════════════════════════════
     PERCUSSION
  ════════════════════════════════════════════════════════════ */
  function _kick(c,t,stressed) {
    const osc=c.createOscillator(), env=c.createGain();
    osc.type='sine';
    osc.frequency.setValueAtTime(stressed?190:105,t);
    osc.frequency.exponentialRampToValueAtTime(28,t+0.14);
    env.gain.setValueAtTime(0,t);
    env.gain.linearRampToValueAtTime(stressed?0.62:0.45,t+0.004);
    env.gain.exponentialRampToValueAtTime(0.0001,t+(stressed?0.18:0.25));
    osc.connect(env); env.connect(_master);
    osc.start(t); osc.stop(t+0.30);
    _tr(osc,env);
  }

  function _snare(c,t,stressed) {
    const src=c.createBufferSource(), flt=c.createBiquadFilter(), env=c.createGain();
    src.buffer=_noiseBuf(c,200);
    flt.type='bandpass'; flt.frequency.value=stressed?2700:1700; flt.Q.value=0.9;
    env.gain.setValueAtTime(0,t);
    env.gain.linearRampToValueAtTime(stressed?0.36:0.21,t+0.004);
    env.gain.exponentialRampToValueAtTime(0.0001,t+(stressed?0.13:0.17));
    src.connect(flt); flt.connect(env); env.connect(_master);
    src.start(t); src.stop(t+0.22);
    _tr(src,flt,env);
  }

  function _hihat(c,t,open,stressed) {
    const ms=open?115:32;
    const src=c.createBufferSource(), flt=c.createBiquadFilter(), env=c.createGain();
    src.buffer=_noiseBuf(c,ms);
    flt.type='highpass'; flt.frequency.value=stressed?9800:7200;
    env.gain.setValueAtTime(0,t);
    env.gain.linearRampToValueAtTime(open?0.11:0.065,t+0.002);
    env.gain.exponentialRampToValueAtTime(0.0001,t+ms/1000);
    src.connect(flt); flt.connect(env); env.connect(_master);
    src.start(t); src.stop(t+ms/1000+0.01);
    _tr(src,flt,env);
  }

  /* ════════════════════════════════════════════════════════════
     MELODY NOTE PICKER
     HRV → spread (narrow at low HRV, wide at high HRV)
     trend → shifts melodic register over time
  ════════════════════════════════════════════════════════════ */
  function _pickNote(scale, barN, stepN, hrv, trend) {
    const spread   = Math.max(2, Math.min(scale.length-1, Math.round(hrv/8)));
    const trendBias = trend * barN * 0.055;
    const contour  = Math.sin(barN*0.37+stepN*0.23)*(spread*0.55)+trendBias;
    const walk     = Math.round(contour+barN*0.14+stepN*0.10);
    return scale[Math.abs(walk)%scale.length];
  }

  function _swing(stepIdx, hrv, p) {
    const base   = p.swingBase + hrv * p.swingHrvMul;
    const groove = stepIdx%2===1 ? base : -base*0.22;
    const jitter = (Math.random()-0.5)*hrv*0.00028;
    return groove+jitter;
  }

  /* ════════════════════════════════════════════════════════════
     SCHEDULE ONE BAR — phase-gated layer system
  ════════════════════════════════════════════════════════════ */
  function _schedBar(c, barStart, stepSec) {
    const mood     = _liveMood;
    const p        = PROFILES[mood];
    const stressed = mood==='stressed';
    const nSteps   = p.melGrid.length;
    const layers   = PHASES[_phase].layers;
    const hrv      = _liveHrv;

    for (let s=0; s<nSteps; s++) {
      const t = Math.max(barStart, barStart+s*stepSec+_swing(s,hrv,p));

      if (layers.includes('bass') && p.bassGrid[s]) {
        const bf = s<nSteps/2 ? p.bassOct[0] : p.bassOct[1];
        _note(c,t,bf,p.bassWave,p.bassAmp,p.attackS,p.bassDecF,stepSec,_master);
      }

      if (layers.includes('melody') && p.melGrid[s]) {
        const freq = _pickNote(p.scale,_barN,s,hrv,_trend);
        const accent = Math.max(0.5, Math.min(1.5, _liveAmp));
        const melE = _note(c,t,freq,p.melWave,p.melAmp*accent,p.attackS,p.melDecF,stepSec,_delay||_master);
        if (_lfoGain && melE) { try { _lfoGain.connect(melE.gain); } catch {} }
      }

      if (layers.includes('harm') && p.harmGrid[s]) {
        const freq  = _pickNote(p.scale,_barN,s+2,hrv,_trend);
        const ratio = s%4<2 ? 1.4983 : 1.2599;
        _note(c,t,freq*ratio,p.harmWave,p.harmAmp,p.attackS*1.8,p.harmDecF,stepSec,_reverb||_master);
      }

      if (layers.includes('pad') && p.padGrid[s]) {
        const padDur = stepSec*p.padDurMul;
        [p.scale[0],p.scale[2],p.scale[4]].forEach((f,i)=>{
          _note(c,t,f,p.padWave,p.padAmp*(1-i*0.18),p.attackS*5,
            Math.min(0.999,padDur/Math.max(0.01,padDur+0.001)),padDur,_reverb||_master);
        });
      }

      if (layers.includes('perc')) {
        if (p.kick  && p.kickGrid [s]) _kick (c,t,stressed);
        if (p.snare && p.snareGrid[s]) _snare(c,t,stressed);
        if (p.hihat && p.hihatGrid[s]) _hihat(c,t,s===4,stressed);
      }
    }
  }

  /* ════════════════════════════════════════════════════════════
     LOOKAHEAD SCHEDULER — fires every 90ms
     Reads _liveBpm live so tempo changes take effect on next bar
  ════════════════════════════════════════════════════════════ */
  function _scheduler(c) {
    const stepSec = 60/_liveBpm;
    const barDur  = stepSec * PROFILES[_liveMood].melGrid.length;
    while (_nextBar < c.currentTime+0.32) {
      _schedBar(c, _nextBar, stepSec);
      _nextBar += barDur;
      _barN++;
    }
    _sched = setTimeout(()=>_scheduler(c), 90);
  }

  /* ════════════════════════════════════════════════════════════
     PUBLIC: start
  ════════════════════════════════════════════════════════════ */
  async function start(bpm, hrv, onStopFn) {
    stop();
    let c;
    try { c=await resume(); } catch(e) { console.error('[AE]',e); return false; }

    _liveBpm  = Math.max(40,Math.min(200,bpm||72));
    _liveHrv  = Math.max(10,Math.min(100,hrv||45));
    _liveMood = _moodKey(_liveBpm,_liveHrv);
    _phase=0; _trend=0; _barN=0;

    const p       = PROFILES[_liveMood];
    const stepSec = 60/_liveBpm;
    const barDur  = stepSec*p.melGrid.length;
    _dur    = Math.ceil(Math.ceil(60/barDur)*barDur);
    _stopCb = onStopFn||null;
    _allNodes = [];

    _master = c.createGain();
    _master.gain.setValueAtTime(0,c.currentTime);
    _master.gain.linearRampToValueAtTime(p.masterVol,c.currentTime+0.9);
    _master.connect(c.destination);

    const rvWet=c.createGain(); rvWet.gain.value=p.reverbWet;
    _reverb=_makeReverb(c,p.reverbSec);
    _reverb.connect(rvWet); rvWet.connect(_master); _tr(rvWet);

    const dly=c.createDelay(2.0), dfb=c.createGain(), dwt=c.createGain();
    dly.delayTime.setValueAtTime(stepSec*p.delayRatio,c.currentTime);
    dfb.gain.setValueAtTime(p.delayFB,c.currentTime);
    dwt.gain.setValueAtTime(p.delayWet,c.currentTime);
    dly.connect(dfb); dfb.connect(dly); dly.connect(dwt); dwt.connect(_master);
    _delay=dly; _tr(dly,dfb,dwt);

    const lfoOsc=c.createOscillator(), lfoGn=c.createGain();
    lfoOsc.frequency.setValueAtTime(p.lfoHz,c.currentTime);
    lfoGn.gain.setValueAtTime(p.lfoDepth,c.currentTime);
    lfoOsc.connect(lfoGn); lfoOsc.start();
    _lfoGain=lfoGn; _tr(lfoOsc,lfoGn);

    _nextBar=c.currentTime+0.12; _playing=true;
    _scheduler(c);
    return true;
  }

  /* ════════════════════════════════════════════════════════════
     PUBLIC: stop / fadeOut
  ════════════════════════════════════════════════════════════ */
  function stop() {
    if (_sched){clearTimeout(_sched);_sched=null;}
    _allNodes.forEach(n=>{ try{n.stop?.();}catch{} try{n.disconnect();}catch{} });
    _allNodes=[];
    if (_master){try{_master.disconnect();}catch{} _master=null;}
    _reverb=_delay=_lfoGain=null; _playing=false;
    if (_stopCb){_stopCb();_stopCb=null;}
  }

  function fadeOut(sec=1.4) {
    if (!_master||!_ctx){stop();return;}
    _master.gain.setValueAtTime(_master.gain.value,_ctx.currentTime);
    _master.gain.linearRampToValueAtTime(0.0001,_ctx.currentTime+sec);
    setTimeout(stop,(sec+0.15)*1000);
  }

  /* ════════════════════════════════════════════════════════════
     PUBLIC: getMeta
  ════════════════════════════════════════════════════════════ */
  function getMeta(bpm,hrv) {
    const B=Math.max(40,Math.min(200,bpm||72));
    const H=Math.max(10,Math.min(100,hrv||45));
    const mood=_moodKey(B,H);
    const p=PROFILES[mood];
    const tIdx=Math.abs(Math.round(B*1.3+H*0.7))%TITLE_WORDS.length;
    const key=CHROMATIC[Math.round(B/5.5)%12];
    const hrvLbl=H>52?'High Variability':H>28?'Moderate Variability':'Low Variability';
    return {
      title:    `${TITLE_WORDS[tIdx]} in ${key}`,
      subtitle: `${B} BPM · ${p.style} · ${hrvLbl}`,
      mood, moodLabel:p.moodLabel, scaleName:p.modeName,
      phase: PHASES[_phase]?.name||'Warmup',
    };
  }

  function _moodKey(bpm,hrv) {
    if (bpm>100||hrv<20) return 'stressed';
    if (bpm<65 ||hrv>55) return 'calm';
    return 'balanced';
  }

  /* ════════════════════════════════════════════════════════════
     EXPORTS
  ════════════════════════════════════════════════════════════ */
  return {
    start, stop, fadeOut, resume, getMeta,
    getDuration:  ()=>_dur,
    getIsPlaying: ()=>_playing,
    getPhaseName: ()=>PHASES[_phase]?.name||'Warmup',
    getPhase:     ()=>_phase,
    triggerBeat,
    updateParams,
    setPhase,
  };
})();

window.AudioEngine = AudioEngine;
