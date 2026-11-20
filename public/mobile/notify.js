/* DisasterShield AI - notification centre: pop-up cards (hover to pause / keep open), optional voice (speech synthesis) and alert sound.
   Shared by the Control Room and the mobile app (identical copy in /mobile). Usage: Notifier.mount(el); Notifier.push({title, body, level, speak}) */
(function () {
  const KEY = "shield_voice";
  let voiceOn = true, muted = false, ctx = null, box = null, btn = null;
  try { voiceOn = localStorage.getItem(KEY) !== "off"; } catch {}
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const css = document.createElement("style");
  css.textContent = `
  #ntf-box{position:fixed;top:64px;right:12px;z-index:5000;display:flex;flex-direction:column;gap:8px;width:min(340px,calc(100vw - 24px));pointer-events:none}
  .ntf{pointer-events:auto;background:#fff;color:#0F172A;border:1px solid #CBD5E1;border-left:5px solid #2563EB;border-radius:10px;padding:9px 12px;box-shadow:0 8px 24px #0F172A33;
       font:13px/1.35 system-ui,"Segoe UI",Roboto,sans-serif;cursor:pointer;animation:ntfin .25s ease-out;transition:transform .15s,box-shadow .15s,opacity .3s}
  .ntf:hover{transform:translateX(-4px) scale(1.02);box-shadow:0 12px 30px #0F172A55}
  .ntf.new{border-left-color:#DC2626}.ntf.update{border-left-color:#059669}.ntf.warn{border-left-color:#D97706}
  .ntf b{display:block;font-size:12px;letter-spacing:.03em;margin-bottom:2px}.ntf small{color:#64748B;font-size:10px}
  .ntf.out{opacity:0;transform:translateX(30px)}
  @keyframes ntfin{from{opacity:0;transform:translateX(30px)}to{opacity:1;transform:none}}
  #ntf-btn{border:1px solid #CBD5E1;background:#fff;color:#0F172A;border-radius:99px;padding:2px 9px;font-size:12px;cursor:pointer;white-space:nowrap}
  #ntf-btn.off{color:#64748B;background:#F1F5F9}`;
  document.head.appendChild(css);

  function beep(level) {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = ctx.currentTime, notes = level === "new" ? [880, 1175] : [660];
      notes.forEach((f, i) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = f; o.type = "sine";
        g.gain.setValueAtTime(0.0001, t0 + i * 0.16); g.gain.exponentialRampToValueAtTime(0.25, t0 + i * 0.16 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.16 + 0.15);
        o.connect(g); g.connect(ctx.destination); o.start(t0 + i * 0.16); o.stop(t0 + i * 0.16 + 0.16); });
    } catch {}
  }
  function say(text) {
    try {
      if (!("speechSynthesis" in window)) return;
      const u = new SpeechSynthesisUtterance(text); u.rate = 1; u.lang = "en-IN";
      speechSynthesis.speak(u);
    } catch {}
  }
  function paintBtn() { if (!btn) return; btn.textContent = voiceOn ? "🔊 Voice on" : "🔇 Voice off"; btn.className = voiceOn ? "" : "off"; btn.title = "Toggle spoken + sound alerts"; }

  window.Notifier = {
    mute(v) { muted = !!v; },
    mount(parent) {
      if (!box) { box = document.createElement("div"); box.id = "ntf-box"; document.body.appendChild(box); }
      if (parent && !btn) {
        btn = document.createElement("button"); btn.id = "ntf-btn"; btn.type = "button"; parent.appendChild(btn); paintBtn();
        btn.onclick = () => { voiceOn = !voiceOn; try { localStorage.setItem(KEY, voiceOn ? "on" : "off"); } catch {} paintBtn();
          if (voiceOn) { beep("update"); say("Voice alerts on"); } else { try { speechSynthesis.cancel(); } catch {} } };
      }
    },
    /* level: new | update | warn | info */
    push({ title, body = "", level = "info", speak, sticky = false }) {
      if (muted) return;
      this.mount();
      const el = document.createElement("div"); el.className = "ntf " + level; el.setAttribute("role", "status");
      el.innerHTML = `<b>${esc(title)}</b><div>${esc(body)}</div><small>${new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" })} IST &bull; click to dismiss</small>`;
      let timer = null; const close = () => { clearTimeout(timer); el.classList.add("out"); setTimeout(() => el.remove(), 300); };
      const arm = () => { clearTimeout(timer); if (!sticky) timer = setTimeout(close, level === "new" ? 12000 : 7000); };
      el.onmouseenter = () => clearTimeout(timer); el.onmouseleave = arm; el.onclick = close; arm();
      box.prepend(el); while (box.children.length > 5) box.lastChild.remove();
      if (navigator.vibrate) { try { navigator.vibrate(level === "new" ? [250, 120, 250] : 120); } catch {} }
      if (voiceOn) { beep(level); if (speak !== false) say(speak || `${title}. ${body}`); }
    },
  };
  document.addEventListener("DOMContentLoaded", () => window.Notifier.mount());
})();
