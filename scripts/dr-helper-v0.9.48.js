const MODULE_ID = "marvel-multiverse-damage-reduction-helper";
const MMDR_VER  = "0.9.48";

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
  const names = [];
  try {
    const p = rootEl.querySelector(".message-content p") || rootEl.querySelector("p");
    if (p) {
      const s = p.querySelector("strong");
      if (s) names.push(s.textContent.trim());
    }
    if (!names.length) {
      const strongs = rootEl.querySelectorAll("strong");
      if (strongs && strongs.length) names.push(strongs[0].textContent.trim());
    }
    if (!names.length) {
      const t = (rootEl.textContent || "").trim();
      const m = /^([\wÀ-ÿ' -]+)\s+(takes|recebe|sofre)\b/i.exec(t);
      if (m) names.push(m[1].trim());
    }
  } catch(e){}
  return names;
}
function resolveTokenUUIDsFromNames(names){
  const uuids = [];
  try {
    const toks = (canvas?.tokens?.placeables || []);
    for (const nm of names) {
      let tok = toks.find(t => String(t?.name||"").trim() === nm);
      if (!tok) {
        const candidates = toks.filter(t => String(t?.name||"").trim().toLowerCase().includes(nm.toLowerCase()));
        if (candidates.length === 1) tok = candidates[0];
      }
      if (!tok) {
        const act = game.actors?.find(a => String(a?.name||"").trim().toLowerCase() === nm.toLowerCase());
        if (act) tok = toks.find(t => t?.actor?.id === act.id);
      }
      if (tok?.document?.uuid) uuids.push(tok.document.uuid);
    }
  } catch(e){}
  return uuids;
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

/* --- Clicks (with late target resolution fallback) --- */
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

    if (!uuids.length) {
      // late resolution: parse the surrounding message element
      const msgEl = btn.closest(".chat-message, li.message, [data-message-id]") || document;
      category = categoryFromText(msgEl?.textContent || category);
      const names = extractTargetNames(msgEl);
      uuids = resolveTokenUUIDsFromNames(names);
      if (!uuids.length) {
        const mid = msgEl?.dataset?.messageId;
        const msg = (mid && (game.messages?.get?.(mid) || (game.messages?.contents||[]).find(m=>m.id===mid))) || null;
        const flagged = msg?.flags?.[MODULE_ID]?.authorTargets;
        if (Array.isArray(flagged) && flagged.length) uuids = flagged.slice();
      }
    }

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
    } else {
      ui.notifications?.warn?.("MMDR: nenhum alvo encontrado.");
    }
  } catch(e){ console.error("[MMDR] click handler error", e); }
}, false);
