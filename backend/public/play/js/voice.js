// Voice chat in the browser: opt-in, push-to-talk, and a WebRTC mesh with the people the SERVER puts in your building's room.
// The server only relays the connection set-up (voice / vsig messages); the audio goes straight between browsers.
// See docs/VOICE_CHAT_PLAN.md. Adults only; the server enforces that, this file only shows what it is told.

const KEY = 'mvw.voice';
const remembered = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const remember = (on) => { try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private mode: fine */ } };

export function createVoice({ send, myId, toast, iceServers, onChange }) {
  const v = { on: false, wantOn: remembered(), room: null, peers: new Map(), stream: null, talking: false, speaking: new Set(), mode: 'ptt' };
  const peers = v.peers;                           // id -> { name, pc, audio, analyser, pending[] }
  let ctx = null;
  const ice = { iceServers: iceServers?.length ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }] };
  const changed = () => onChange?.(v);

  const audioCtx = () => ctx ?? (ctx = new (window.AudioContext || window.webkitAudioContext)());
  function watch(id, stream) {
    try {
      const a = audioCtx().createAnalyser(); a.fftSize = 512; audioCtx().createMediaStreamSource(stream).connect(a);
      return a;
    } catch { return null; }
  }
  function level(a) { if (!a) return 0; const b = new Uint8Array(a.fftSize); a.getByteTimeDomainData(b); let m = 0; for (const x of b) m = Math.max(m, Math.abs(x - 128)); return m / 128; }

  const setTrack = () => { const on = v.on && (v.mode === 'open' || v.talking); v.stream?.getAudioTracks().forEach((t) => { t.enabled = on; }); };

  async function enable() {
    if (!navigator.mediaDevices?.getUserMedia) { toast('error', 'This browser cannot use a microphone here (it needs https or localhost).'); return false; }
    try {
      v.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    } catch { toast('error', 'Microphone permission was refused, so voice stays off.'); v.wantOn = false; remember(false); changed(); return false; }
    v.wantOn = true; remember(true); setTrack();
    v.localAnalyser = watch('me', v.stream);
    send({ t: 'voice', on: true }); return true;
  }
  function disable() {
    v.wantOn = false; remember(false); v.on = false; v.room = null;
    for (const id of [...peers.keys()]) drop(id);
    v.stream?.getTracks().forEach((t) => t.stop()); v.stream = null; v.localAnalyser = null; v.talking = false; v.speaking.clear();
    send({ t: 'voice', on: false }); changed();
  }

  function make(id, name) {
    if (peers.has(id)) return peers.get(id);
    const pc = new RTCPeerConnection(ice), audio = new Audio(); audio.autoplay = true;
    const p = { name, pc, audio, analyser: null, pending: [] }; peers.set(id, p);
    v.stream?.getTracks().forEach((t) => pc.addTrack(t, v.stream));
    pc.onicecandidate = (e) => { if (e.candidate) send({ t: 'vsig', to: id, kind: 'ice', data: e.candidate.toJSON() }); };
    pc.ontrack = (e) => { audio.srcObject = e.streams[0]; p.analyser = watch(id, e.streams[0]); audio.play().catch(() => {}); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') { drop(id); changed(); } };
    return p;
  }
  function drop(id) { const p = peers.get(id); if (!p) return; try { p.pc.close(); } catch { /* already closed */ } p.audio.srcObject = null; peers.delete(id); v.speaking.delete(id); }

  /** The server's view of who is in my room. The player with the smaller id starts each call, so two people never both offer. */
  async function onRoom(m) {
    if (m.reason) { toast('info', m.text ?? 'Voice is off.'); if (m.reason === 'adults_only' || m.reason === 'muted' || m.reason === 'suspended') { v.wantOn = false; remember(false); v.stream?.getTracks().forEach((t) => t.stop()); v.stream = null; } }
    v.on = m.on && !!v.stream; v.room = m.room ?? null;
    const want = new Map((m.peers ?? []).map((p) => [p.id, p.name]));
    for (const id of [...peers.keys()]) if (!want.has(id)) drop(id);
    if (v.on) for (const [id, name] of want) {
      if (peers.has(id)) continue;
      const p = make(id, name);
      if (myId < id) { const offer = await p.pc.createOffer(); await p.pc.setLocalDescription(offer); send({ t: 'vsig', to: id, kind: 'offer', data: { type: offer.type, sdp: offer.sdp } }); }
    }
    changed();
  }
  async function onSignal(m) {
    if (!v.on) return;
    let p = peers.get(m.from);
    if (!p) { if (m.kind !== 'offer') return; p = make(m.from, '?'); }
    try {
      if (m.kind === 'offer') {
        await p.pc.setRemoteDescription(m.data); for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c);
        const ans = await p.pc.createAnswer(); await p.pc.setLocalDescription(ans); send({ t: 'vsig', to: m.from, kind: 'answer', data: { type: ans.type, sdp: ans.sdp } });
      } else if (m.kind === 'answer') {
        await p.pc.setRemoteDescription(m.data); for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c);
      } else if (p.pc.remoteDescription) await p.pc.addIceCandidate(m.data); else p.pending.push(m.data);
    } catch { /* a stale or malformed message from a peer: ignore it */ }
  }

  const loud = new Map();                          // id -> last time it was loud; "speaking" holds for 600 ms so short sounds still show
  setInterval(() => {
    const now = performance.now(), s = new Set();
    for (const [id, p] of peers) if (level(p.analyser) > 0.05) loud.set(id, now);
    if (v.on && (v.mode === 'open' || v.talking) && level(v.localAnalyser) > 0.05) loud.set(myId, now);
    for (const [id, t] of loud) { if (now - t < 600) s.add(id); else loud.delete(id); }
    if (s.size !== v.speaking.size || [...s].some((x) => !v.speaking.has(x))) { v.speaking = s; changed(); }
  }, 100);

  /** Debug helper (window.mvwVoice() in the console): connection state and received audio bytes per peer. */
  async function debug() {
    const out = [];
    for (const [id, p] of peers) { let bytes = 0; (await p.pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') bytes += r.bytesReceived; }); out.push({ id, state: p.pc.connectionState, ice: p.pc.iceConnectionState, bytes, level: level(p.analyser) }); }
    return out;
  }
  return {
    debug, state: v,
    async toggle() { return v.wantOn && v.stream ? disable() : enable(); },
    /** Resume automatically if you turned voice on in an earlier visit (the browser may ask for the microphone again). */
    async resume() { if (v.wantOn && !v.stream) await enable(); },
    talk(down) { v.talking = down; setTrack(); changed(); },
    setMode(mode) { v.mode = mode; setTrack(); changed(); },
    onRoom, onSignal,
    /** Leaving the world (or changing city): stop the microphone but remember that you wanted voice on. */
    close() { for (const id of [...peers.keys()]) drop(id); v.stream?.getTracks().forEach((t) => t.stop()); v.stream = null; v.on = false; v.room = null; v.localAnalyser = null; },
  };
}
