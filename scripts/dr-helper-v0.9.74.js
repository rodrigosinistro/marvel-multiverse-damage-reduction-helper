const MODULE_ID = "marvel-multiverse-damage-reduction-helper";
const MMDR_VER  = "0.9.74";

/* ---------------- Settings / Debug ---------------- */
Hooks.once("init", () => {
  try {
    game.settings.register(MODULE_ID, "debug", {
      name: "Enable debug logs",
      hint: "Prints [MMDR] logs to the console.",
      scope: "client", config: true, type: Boolean, default: false
    });
  } catch(e) { console.error("[MMDR] settings error", e); }
});
Hooks.once("ready", () => { console.log(`[MMDR] v${MMDR_VER} ready`); });

function dbg(...args){ try { if (game.settings.get(MODULE_ID, "debug")) console.log("[MMDR]", ...args); } catch(e){} }

/* ---------------- Stamp authoritative targets on message creation ---------------- */
Hooks.on("preCreateChatMessage", (doc, data, options, userId) => {
  try {
    if (game.user?.id !== userId) return; // only the author stamps
    const tgts = Array.from(game.user?.targets || []);
    const ids = tgts.map(t => t?.document?.uuid || t?.document?.id || t?.id).filter(Boolean);
    if (!ids.length) return;
    data.flags = data.flags || {};
    data.flags[MODULE_ID] = Object.assign({}, data.flags[MODULE_ID], {
      authorUserId: userId,
      authorTargets: ids
    });
    dbg("stamped targets", ids);
  } catch(e){ console.warn("[MMDR] preCreateChatMessage error", e); }
});

/* ---------------- Utilities ---------------- */
function gp(obj, path){
  try {
    const getProperty = (foundry?.utils?.getProperty) ? foundry.utils.getProperty : (window.getProperty || null);
    return getProperty ? getProperty(obj, path) : path.split(".").reduce((o,k)=>o?.[k], obj);
  } catch(e){ return undefined; }
}
function sp(obj, path, value){
  try {
    const setProperty = (foundry?.utils?.setProperty) ? foundry.utils.setProperty : (window.setProperty || null);
    if (setProperty) return setProperty(obj, path, value);
    const parts = path.split("."); let o = obj;
    while (parts.length > 1) { const k = parts.shift(); if (!(k in o)) o[k] = {}; o = o[k]; }
    o[parts[0]] = value; return value;
  } catch(e){ return undefined; }
}

function categoryFromText(text){
  const t = (text||"").toLowerCase();
  if (t.includes("damagetype: focus") || t.includes("damage type: focus") || t.includes("focus damage")) return "focus";
  return "health";
}
function readDR(actor, category){
  try { return Number(actor?.system?.[category === "focus" ? "focusDamageReduction" : "healthDamageReduction"] ?? 0) || 0; }
  catch(e){ return 0; }
}
function statPaths(category){
  return category === "focus"
    ? { cur:"system.focus.value", max:"system.focus.max" }
    : { cur:"system.health.value", max:"system.health.max" };
}
async function applyDelta({ actor, category, delta, heal }){
  const paths = statPaths(category);
  const cur = Number(gp(actor, paths.cur) ?? 0) || 0;
  const max = Number(gp(actor, paths.max) ?? 0) || 0;
  const next = heal ? Math.min(max || Number.MAX_SAFE_INTEGER, cur + Math.max(0, delta))
                    : Math.max(0, cur - Math.max(0, delta));
  const patch = {}; sp(patch, paths.cur, next);
  await actor.update(patch);
}

function isSystemDamageMessage(rootEl){
  try {
    const t = (rootEl?.textContent || "").toLowerCase();
    if (rootEl?.querySelector?.(".mmdr-rollline")) return false; // already processed
    return t.includes("damage multiplier") || t.includes("multiplicador de dano");
  } catch(e){ return false; }
}

/* --- Parse numbers from system text (including printed DR & total) --- */
function parseNumbersFrom(rootEl){
  const textAll = rootEl?.textContent || "";
  let md = 0, X = 0, AB = 0, isFant = false, parsedDR = null, printedTotal = null;
  try { const m = /MarvelDie:\s*(\d+)/i.exec(textAll); if (m) md = parseInt(m[1],10); } catch(e){}
  try {
    const m = /\(\s*(\d+)\s*-\s*damageReduction\s*:\s*(-?\d+)\s*=\s*(-?\d+)\s*\)/i.exec(textAll);
    if (m) { X = parseInt(m[1],10); parsedDR = parseInt(m[2],10); }
  } catch(e){}
  if (!X) { try { const m = /\(\s*(\d+)[^\)]*damageReduction/i.exec(textAll); if (m) X = parseInt(m[1],10); } catch(e){} }
  try { const m = /\+\s*[A-Za-zÀ-ÿ]+\s+score\s*(-?\d+)/i.exec(textAll); if (m) AB = parseInt(m[1],10); } catch(e){}
  isFant = /\bFantastic\b/i.test(textAll) || /\bFantástico\b/i.test(textAll);
  try {
    const m = /\btakes\s+(\d+)\s+(?:Fantastic\s+)?(?:health|focus)\s+damage\b/i.exec(textAll);
    if (m) printedTotal = parseInt(m[1], 10);
  } catch(e){}
  return { md, X, AB, isFant, parsedDR, printedTotal };
}

/* --- Extract target names from message --- */
function extractTargetNames(rootEl){
  const names = new Set();
  try {
    const content = rootEl.querySelector?.(".message-content") || rootEl;
    content.querySelectorAll?.("strong")?.forEach(s => {
      const n = s.textContent?.trim(); if (n) names.add(n);
    });
    if (!names.size) {
      const p = content.querySelector?.("p");
      if (p) {
        const s = p.querySelector?.("strong");
        if (s?.textContent) names.add(s.textContent.trim());
      }
    }
    if (!names.size) {
      const t = (content.textContent || "").trim();
      const m = /^([\wÀ-ÿ' -]+)\s+(takes|recebe|sofre)\b/i.exec(t);
      if (m) names.add(m[1].trim());
    }
  } catch(e){}
  return Array.from(names);
}
function resolveTokenUUIDsFromNames(names){
  const uuids = new Set();
  try {
    const toks = (canvas?.tokens?.placeables || []);
    const norm = s => String(s||"").trim().toLowerCase();
    for (const nmRaw of names) {
      const nm = norm(nmRaw);
      // 1) tokens whose displayed name contains nm
      toks.filter(t => norm(t?.name).includes(nm)).forEach(t => { if (t?.document?.uuid) uuids.add(t.document.uuid); });
      // 2) tokens by actor name contains nm
      toks.filter(t => norm(t?.actor?.name).includes(nm)).forEach(t => { if (t?.document?.uuid) uuids.add(t.document.uuid); });
      // 3) actor exact/fuzzy -> tokens of that actor
      const act = game.actors?.find(a => norm(a?.name) === nm) || game.actors?.find(a => norm(a?.name).includes(nm));
      if (act) toks.filter(t => t?.actor?.id === act.id).forEach(t => { if (t?.document?.uuid) uuids.add(t.document.uuid); });
    }
  } catch(e){}
  return Array.from(uuids);
}

/* --- Build UI --- */
function appendUI(message, rootEl){
  const nums = parseNumbersFrom(rootEl);
  const category = categoryFromText(rootEl?.textContent || "");
  if (!(nums.md && nums.X)) return;

  const authorTargets = message?.flags?.[MODULE_ID]?.authorTargets || [];
  let targetUUIDs = Array.isArray(authorTargets) ? authorTargets.slice() : [];
  if (!targetUUIDs.length) {
    const names = extractTargetNames(rootEl);
    targetUUIDs = resolveTokenUUIDsFromNames(names);
  }

  let displayTotal = nums.printedTotal;
  if (displayTotal == null) {
    let previewDR = 0;
    if (targetUUIDs.length) {
      try { const doc = fromUuidSync(targetUUIDs[0]); previewDR = Math.abs(readDR(doc?.actor, category)); } catch(e){}
    } else if (nums.parsedDR !== null) previewDR = Math.abs(Number(nums.parsedDR)||0);
    const Z = Math.max(nums.X - previewDR, 0);
    let tot = Z > 0 ? (nums.md * Z) + nums.AB : 0;
    if (nums.isFant) tot *= 2;
    displayTotal = tot;
  }

  const abilityName = category === "focus" ? "Ego/Logic" : "Melee/Agility";
  const badgeCat = category.toUpperCase();
  const $content = rootEl.querySelector(".message-content") || rootEl;

  const wrap = document.createElement("div");
  wrap.className = "mmdr-wrapper";

  wrap.innerHTML = `
    <div class="mmdr-rollline ${category} ${nums.isFant ? 'fantastic' : ''}">
      <div class="mmdr-rollline-left">
        <div class="mmdr-badge">${badgeCat}</div>
        ${nums.isFant ? '<div class="mmdr-badge alt">FANTASTIC</div>' : ''}
      </div>
      <div class="mmdr-rollline-main">
        <div class="value">${displayTotal}</div>
        <div class="formula">${nums.md} × ? + ${abilityName} ${nums.AB >= 0 ? '+'+nums.AB : nums.AB}</div>
      </div>
    </div>
    <div class="mmdr-actions">
      <button type="button" class="mmdr-apply-btn ${category}" data-action="full"
        data-category="${category}" data-md="${nums.md}" data-x="${nums.X}" data-ab="${nums.AB}"
        data-fant="${nums.isFant?1:0}" data-targets="${targetUUIDs.join(',')}">DANO</button>
      <button type="button" class="mmdr-apply-btn ${category}" data-action="half"
        data-category="${category}" data-md="${nums.md}" data-x="${nums.X}" data-ab="${nums.AB}"
        data-fant="${nums.isFant?1:0}" data-targets="${targetUUIDs.join(',')}">1/2 DANO</button>
      <button type="button" class="mmdr-apply-btn ${category}" data-action="heal"
        data-category="${category}" data-md="${nums.md}" data-x="${nums.X}" data-ab="${nums.AB}"
        data-fant="${nums.isFant?1:0}" data-targets="${targetUUIDs.join(',')}">CURA</button>
    </div>
  `;

  $content.appendChild(wrap);
}

/* --- Hook handlers --- */
function handleRender(message, htmlOrEl){
  try {
    const rootEl = (htmlOrEl instanceof HTMLElement) ? htmlOrEl : (htmlOrEl?.[0] || null);
    if (!rootEl) return;
    if (!isSystemDamageMessage(rootEl)) return;
    appendUI(message, rootEl);
  } catch(e){ console.warn("[MMDR] render error", e); }
}
Hooks.on("renderChatMessageHTML", handleRender);
Hooks.on("renderChatMessage", handleRender);

/* --- Clicks (robust target resolution) --- */
document.addEventListener("click", async (ev) => {
  const btn = ev.target?.closest?.(".mmdr-apply-btn");
  if (!btn) return;
  try {
    const md    = Number(btn.getAttribute("data-md"))   || 0;
    const X     = Number(btn.getAttribute("data-x"))    || 0;
    const AB    = Number(btn.getAttribute("data-ab"))   || 0;
    const isFant= Number(btn.getAttribute("data-fant")) === 1;
    let category = btn.getAttribute("data-category") || "health";
    const action   = btn.getAttribute("data-action")   || "full";
    let targetsStr = btn.getAttribute("data-targets") || "";
    let uuids = targetsStr.split(",").map(s=>s.trim()).filter(Boolean);

    const msgEl = btn.closest(".chat-message, li.message, [data-message-id]") || document;
    const mid = msgEl?.dataset?.messageId;
    const msg = (mid && (game.messages?.get?.(mid) || (game.messages?.contents||[]).find(m=>m.id===mid))) || null;

    // Union with stamped targets if present
    const flagged = msg?.flags?.[MODULE_ID]?.authorTargets;
    if (Array.isArray(flagged)) {
      flagged.forEach(u => { if (u) uuids.push(u); });
    }

    // Late name-based resolution
    if (!uuids.length) {
      category = categoryFromText(msgEl?.textContent || category);
      const names = extractTargetNames(msgEl);
      const fromNames = resolveTokenUUIDsFromNames(names);
      uuids = uuids.concat(fromNames);
    }

    // Deduplicate
    uuids = Array.from(new Set(uuids.filter(Boolean)));

    dbg("click resolved", { mid, category, uuids });

    if (!uuids.length) { ui.notifications?.warn?.("MMDR: nenhum alvo encontrado."); return; }

    const results = [];
    for (const uuid of uuids) {
      try {
        const doc = await fromUuid(uuid);
        const actor = doc?.actor;
        if (!actor) continue;
        const DR = Math.abs(readDR(actor, category));
        const Z  = Math.max(X - DR, 0);
        let total = Z > 0 ? (md * Z) + AB : 0;
        if (isFant) total *= 2;
        let delta = total;
        let heal = false;
        if (action === "half") delta = Math.ceil(total/2);
        else if (action === "heal") heal = true;

        await applyDelta({ actor, category, delta, heal });
        results.push({ name: actor.name, delta, heal });
      } catch(err){
        console.error("[MMDR] Apply error (per target)", uuid, err);
      }
    }

    if (results.length){
      const CAT = String(category).toUpperCase();
      const verb = (action==="half") ? "½" : (results[0].heal ? "Heal" : "Apply");
      const human = results.map(r => `${r.name} ${r.heal?"+":"-"}${r.delta}`).join(", ");
      try { await ChatMessage.create({ content: `<div class="mmdr-report">MMDR ${verb} [${CAT}]: ${human}</div>` }); } catch(e){}
      ui.notifications?.info?.(`MMDR ${verb} [${CAT}]: ${human}`);
      // persist uuids on the element to speed up next clicks
      btn.setAttribute("data-targets", uuids.join(","));
    } else {
      ui.notifications?.warn?.("MMDR: nenhum alvo encontrado.");
    }
  } catch(e){ console.error("[MMDR] click handler error", e); }
}, false);


/* === MMDR Augment v0.9.74: GM-only buttons + robust parsing (no unicode props) + colored confirmations === */
(() => {
  "use strict";
  // ---- small utils ----
  const PT_CAT = { "saúde":"health", "foco":"focus", "vigor":"stamina", "resistência":"stamina" };
  function colorFor(cat){
    const c = String(cat||"").toLowerCase();
    if (c === "health" || c === "saúde") return "#b40000";
    if (c === "focus"  || c === "foco")  return "#0e7d2c";
    return "#444";
  }
  function confirmHTML({label, category, entries}){
    const bg = colorFor(category);
    const text = (entries||[]).map(e => `${e.name} ${e.heal?"+":"-"}${e.delta}`).join(", ");
    const safeLabel = label || "CONFIRMAÇÃO";
    return `<div class="mmdr-confirm" style="background:${bg};color:#fff;padding:6px 10px;border-radius:6px;font-weight:600;">
      <div style="font-size:14px;">${safeLabel}</div>
      <div style="opacity:.9;font-weight:500;">${text}</div>
    </div>`;
  }

  // ---- parsing helpers (ASCII-safe) ----
  function parseFromMessage(el){
    try{
      const t = (el.innerText || el.textContent || "").replace(/\s+/g," ").trim();
      // Try "<name> takes N <cat> damage" (EN/PT cat + EN/PT 'damage/dano')
      const rx1 = /(\d+)\s+(?:\w+\s+)?(health|focus|stamina|saúde|foco|vigor|resistência)\s+(?:damage|dano)/i;
      const m1 = t.match(rx1);
      if (m1){
        let cat = (m1[2]||"health").toLowerCase();
        cat = PT_CAT[cat] || cat;
        return { name: null, total: Number(m1[1]||0), category: cat };
      }
      // Fallback: last number in the message + guess cat by keywords
      const nums = Array.from(t.matchAll(/(\d+)/g)).map(x=>Number(x[1]));
      const total = nums.length ? nums[nums.length-1] : 0;
      const cat = /focus|foco/i.test(t) ? "focus" : /stamina|vigor|resist/i.test(t) ? "stamina" : /health|saúde/i.test(t) ? "health" : null;
      if (total && cat) return { name: null, total, category: cat };
      return null;
    }catch(e){ return null; }
  }
  function parseFromPills(el){
    try{
      const pills = Array.from(el.querySelectorAll("span,div,small,strong,b")).map(e => (e.textContent||"").trim().toLowerCase());
      let cat = pills.includes("focus") || pills.includes("foco") ? "focus"
             : pills.includes("stamina") || pills.includes("vigor") || pills.includes("resistência") ? "stamina"
             : pills.includes("health") || pills.includes("saúde") ? "health" : null;
      const nums = Array.from(el.querySelectorAll("*")).map(e => (e.textContent||"").trim()).filter(t => /^\d+$/.test(t));
      const total = nums.length ? Number(nums[nums.length-1]) : 0;
      if (!cat || !total) return null;
      return { name: null, total, category: cat };
    }catch(e){ return null; }
  }
  function parseCatTotal(msgEl){
    return parseFromMessage(msgEl) || parseFromPills(msgEl);
  }
  function collectTargetsGM(msgEl){
    const tks = Array.from(game.user?.targets ?? []);
    if (tks.length) return tks.map(t => t.document?.uuid).filter(Boolean);
    const ctl = canvas?.tokens?.controlled ?? [];
    if (ctl.length) return ctl.map(t => t.document?.uuid).filter(Boolean);
    return [];
  }

  async function gmApplyAndConfirm({msgEl, label}){
    const info = parseCatTotal(msgEl);
    if (!info || !info.total){ ui.notifications?.warn?.("MMDR: não consegui identificar o valor do dano."); return; }
    const uuids = collectTargetsGM(msgEl);
    if (!uuids.length){ ui.notifications?.warn?.("MMDR: selecione/aponte o(s) alvo(s)."); return; }

    const isHalf = /½|1\/2/i.test(label);
    const isHeal = /cura|heal/i.test(label);
    const total  = Number(info.total)||0;
    const delta  = isHalf ? Math.ceil(total/2) : total;
    const entries = [];
    for (const uuid of uuids){
      try{
        const doc = await fromUuid(uuid);
        const actor = doc?.actor ?? (doc?.documentName === "Actor" ? doc : null);
        if (!actor) continue;
        await applyDelta({ actor, category: info.category, delta, heal: isHeal });
        entries.push({ name: actor.name, delta, heal: isHeal });
      }catch(e){ console.error("[MMDR] GM apply error", e); }
    }
    if (entries.length){
      await ChatMessage.create({ content: confirmHTML({label, category: info.category, entries}) });
    }
  }

  function handleRender(_message, html){
    const el = html instanceof HTMLElement ? html : html?.[0];
    if (!el) return;
    const btns = el.querySelectorAll("button, .button, a");
    const isGM = !!game.user?.isGM;
    btns.forEach(btn => {
      const t = (btn.textContent||"").replace(/\s+/g," ").trim().toLowerCase();
      const isOur = (t === "dano" || t === "cura" || t === "1/2 dano" || t === "½ dano" || t === "1⁄2 dano");
      if (!isOur) return;
      if (!isGM){
        btn.style.display = "none";
      } else {
        btn.addEventListener("click", (ev) => {
          ev.preventDefault(); ev.stopImmediatePropagation();
          const label = (btn.textContent||"").replace(/\s+/g," ").trim();
          gmApplyAndConfirm({ msgEl: el, label });
        }, { capture: true });
      }
    });
  }

  Hooks.on("renderChatMessageHTML", handleRender);
  Hooks.on("renderChatMessage", handleRender);

  Hooks.once("ready", () => console.log("[MMDR] v0.9.74 ready (GM-only UI, robust parsing)"));
})();
/* === end augment v0.9.74 === */

