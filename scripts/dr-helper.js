
const MODULE_ID = "marvel-multiverse-damage-reduction-helper";
const MMDR_VER = "0.9.37";

Hooks.once("init", () => {
  try {
    game.settings.register(MODULE_ID, "debug", {
      name: "Enable debug logs",
      hint: "Prints [MMDR] logs and embeds a hidden JSON comment in the chat card.",
      scope: "client", config: true, type: Boolean, default: false
    });
    game.settings.register(MODULE_ID, "showStyledBreakdown", {
      name: "Show styled breakdown",
      hint: "Adds a compact, styled summary box to each damage result card.",
      scope: "client", config: true, type: Boolean, default: true
    });
    game.settings.register(MODULE_ID, "useRollStyle", {
      name: "Use roll-like styling",
      hint: "Render a big, dice-result-like line with the final damage total.",
      scope: "client", config: true, type: Boolean, default: true
    });
    game.settings.register(MODULE_ID, "healthDRPaths", { name: "Health DR Paths", hint: "Comma-separated paths to Health DR fields (highest priority first).", scope: "world", config: true, type: String, default: "system.healthDamageReduction,system.health.damageReduction,system.health.dr" });
    game.settings.register(MODULE_ID, "focusDRPaths", { name: "Focus DR Paths", hint: "Comma-separated paths to Focus DR fields (highest priority first).", scope: "world", config: true, type: String, default: "system.focusDamageReduction,system.focus.damageReduction,system.focus.dr" });
  } catch(e) { console.error("[MMDR] init error", e); }
});

Hooks.once("ready", () => {
  console.log(`[MMDR] v${(game.modules?.get?.("marvel-multiverse-damage-reduction-helper")?.version || MMDR_VER)} ready`);
  Hooks.on("renderChatMessageHTML", (message, html) => {
    try { mmdrRewrite(message, html); }
    catch (e) { console.error("[MMDR] Error:", e); }
  });

// === MMDR delegated click handler (once) — 0.9.13 ===
if (!window.__MMDR_DELEGATED__) {
  window.__MMDR_DELEGATED__ = true;
  document.addEventListener("click", async (ev) => {
    const btn = ev.target?.closest?.(".mmdr-apply-btn");
    if (!btn) return;
    const messageId = btn.getAttribute("data-message-id");
    const total = Number(btn.getAttribute("data-total")) || 0;
    const category = btn.getAttribute("data-category") || "health";
    const action = btn.getAttribute("data-action") || "full";

    const message = game.messages?.get(messageId);
    const html = btn.closest?.(".chat-message");
    const $ = window.jQuery;
    const $html = (html instanceof HTMLElement && $) ? $(html) : (html && html.jquery ? html : null);

    // Read numbers: prefer button dataset, then message data-mmdr, then fallback regex
    let md = Number(btn.getAttribute("data-md") || 0);
    let X  = Number(btn.getAttribute("data-x")  || 0);
    let AB = Number(btn.getAttribute("data-ab") || 0);
    let isFant = btn.getAttribute("data-fant") === "1";
    if (!(md && X)) {
      try {
        const wrapper = html?.querySelector?.(".message-content");
        const metaRaw = wrapper?.getAttribute?.("data-mmdr");
        if (metaRaw) {
          const meta = JSON.parse(metaRaw);
          md = md || Number(meta?.md) || 0;
          X  = X  || Number(meta?.X)  || 0;
          AB = AB || Number(meta?.AB) || 0;
          isFant = isFant || !!meta?.isFant;
        }
      } catch(e) {}
    }
    if (!(md && X)) {
      const textAll = (html?.textContent || "") + "";
      const mdM  = /MarvelDie:\s*(\d+)/i.exec(textAll); if (mdM) md = parseInt(mdM[1],10);
      const xM   = /\(\s*(\d+)/i.exec(textAll);         if (xM)  X  = parseInt(xM[1],10);
      const abM  = /\+\s*[A-Za-zÀ-ÿ]+\s+score\s*(-?\d+)/i.exec(textAll); if (abM) AB = parseInt(abM[1],10);
      isFant = /\bFantastic\b/i.test(textAll);
}
    // Fallback: if md/X still missing, try to read the big total shown in the message (before DAMAGE button)
    if (!(md && X)) {
      try {
        const nums = Array.from(String(textAll).matchAll(/\b(\d{1,3})\b/g)).map(m=>parseInt(m[1],10));
        const maxN = nums.length ? Math.max(...nums) : 0;
        if (maxN > 0) { if (!md) md = 1; X = maxN; }
      } catch(e) {}
    }

// Gather actors (prefer selected targets; fallback to single findTargetActor)
    const targets = Array.from(game.user?.targets || []);
    const actors = [];
    if (targets.length > 0) {
      for (const t of targets) if (t?.actor) actors.push(t.actor);
    } else {
      const a = (typeof findTargetActor === "function") ? findTargetActor(message, $html) : null;
      if (a) actors.push(a);
    }
    if (actors.length === 0) {
      ui.notifications?.warn?.("MMDR: nenhum alvo encontrado.");
      return;
    }

    let count = 0;
    const results = [];
    for (const actor of actors) {
      try {
        // Per-actor DR and total
        const drInfo = (typeof readDR === "function") ? readDR(actor, category) : { chosen: 0 };
        const DR = Math.abs(Number(drInfo?.chosen ?? 0)) || 0;
        const Z = Math.max(X - DR, 0);
        let totalActor = 0;
        if (Z > 0) { totalActor = (md * Z) + AB; if (isFant) totalActor *= 2; }

        let heal = false;
        let delta = totalActor;
        if (action === "half") delta = Math.ceil(totalActor/2);
        if (action === "heal") { heal = true; delta = totalActor; } // keep heal using card total unless requested otherwise

        if (!Number.isFinite(delta) || delta < 0) delta = 0;
        console.log("[MMDR] Apply clicked (delegated)", { actor: actor.name, category, DR, X, md, AB, totalActor, action, delta, heal });
        await mmdr_applyDeltaToActor({ actor, category, delta, heal });
        results.push({ name: actor.name, delta, heal });
        count++;
      } catch (err) {
        console.error("[MMDR] Apply error (per target)", actor?.name, err);
      }
    }
    const CAT = String(category).toUpperCase();
    if (count > 0) {
      const human = results.map(r => `${r.name} ${r.heal?"+":"-"}${r.delta}`).join(", ");
      const verb = (results[0]?.heal) ? "Heal" : (action==="half" ? "Half" : "Apply");
      ui.notifications?.info?.(`MMDR ${verb} [${CAT}]: ${human}`);
      try { await ChatMessage.create({ content: `<div class=\"mmdr-apply-report\"><b>MMDR ${verb} [${CAT}]</b>: ${human}</div>`, speaker: message?.speaker || {} }); } catch(e) { console.warn("[MMDR] chat report failed", e); }
    }
  }, false);
}


});


function safeGetSetting(module, key, fallback=""){
  try { return game.settings.get(module, key); } catch(e){ return fallback; }
}

function dbg(...args){ try { if (safeGetSetting(MODULE_ID, "debug", false)) console.log("[MMDR]", ...args); } catch(e) {} }

function isResultCard($html) {
  const t = ($html.text() || "").toLowerCase();
  if (/\bre:\s*marveldie\b/i.test(t)) return true;
  if (/\btakes\s+-?\d+\s+(?:health|focus)\s+damage\b/i.test(t)) return true;
  return false;
}
// === MMDR Apply Utils (0.9.13) ===
function mmdr_firstNumericPath(obj, paths) {
  for (const p of paths) {
    try {
      const v = foundry?.utils?.getProperty ? foundry.utils.getProperty(obj, p) : undefined;
      if (Number.isFinite(Number(v))) return p;
    } catch(e){}
  }
  return null;
}
function mmdr_getStatPaths(category, actor) {
  const cat = (String(category||"").toLowerCase() === "focus") ? "focus" : "health";
  const base = cat === "focus" ? {
    currentCandidates: ["system.focus.value","system.focus.current","system.resources.focus.value","system.resources.focus","system.attributes.focus.value","system.focus"],
    maxCandidates: ["system.focus.max","system.resources.focus.max","system.attributes.focus.max"]
  } : {
    currentCandidates: ["system.health.value","system.health.current","system.health.hp","system.attributes.hp.value","system.hp.value","system.health"],
    maxCandidates: ["system.health.max","system.attributes.hp.max","system.hp.max"]
  };
  const pathCurrent = mmdr_firstNumericPath(actor, base.currentCandidates) || base.currentCandidates[0];
  const pathMax     = mmdr_firstNumericPath(actor, base.maxCandidates)     || base.maxCandidates[0];
  return { pathCurrent, pathMax };
}
async function mmdr_applyDeltaToActor({ actor, category, delta, heal=false }) {
  const { pathCurrent, pathMax } = mmdr_getStatPaths(category, actor);
  const gp = foundry?.utils?.getProperty;
  const cur = gp ? Number(gp(actor, pathCurrent)) : 0;
  const max = gp ? Number(gp(actor, pathMax)) : NaN;
  let next = heal ? (cur + delta) : (cur - delta);
  if (Number.isFinite(max)) next = Math.min(next, max);
  next = Math.max(0, next);
  console.log("[MMDR] Updated", { path: pathCurrent, from: cur, to: next, category, heal });
  await actor.update({ [pathCurrent]: next });
}

function forceHeaderDamageNumber($html, n) {
  const $c = $html.find(".message-content");
  if (!$c.length) return;
  let h = $c.html();
  h = h.replace(/((?:takes|sofre)(?:\s|&nbsp;)+)(?:<[^>]+>\s*)*-?\d+/i, (m, pre) => pre + String(n));
  $c.html(h);
}

function computeFinal(h, isFantastic){
  let md = 0;
  const m1 = /MarvelDie:\s*(\d+)\s*\*\s*damage\s*multiplier/i.exec(h);
  if (m1 && m1[1]) md = parseInt(m1[1], 10);

  // Capture ( X - damageReduction: Y = Z )
  const m2 = /(\(\s*)(\d+)([\s\S]*?damageReduction:\s*)(-?\d+)([\s\S]*?=\s*)(-?\d+)(\s*\))/i.exec(h);
  let X=0, Y=0, Z=0;
  if (m2) {
    X = parseInt(m2[2], 10);
    Y = Math.abs(parseInt(m2[4], 10)); // DR may be negative in sheet -> take absolute
    Z = Math.max(X - Y, 0);
  }
  let abil = 0;
  const m3 = /\+\s*[A-Za-zÀ-ÿ]+\s+score\s*(-?\d+)/i.exec(h);
  if (m3 && m3[1] != null) abil = parseInt(m3[1], 10);

  if (Z === 0) return 0; // RULE: multiplier zero => damage zero (ignores Fantastic & ability)
  let total = md * Z + abil;
  if (isFantastic) total *= 2;
  return Math.max(total, 0);
}


function detectCategory(flavor, $html){
  try {
    const text = ($html && $html.text && $html.text()) ? $html.text() : "";
    const hay  = `${flavor || ""} ${text}`;

    // 0) Prefer explicit damage type on the card (EN/PT)
    const mdt = /(?:damage\s*type|damagetype)\s*:\s*([A-Za-zÀ-ÿ]+)/i.exec(hay);
    if (mdt && mdt[1]) {
      const dt = mdt[1].toLowerCase();
      if (/(focus|foco)/.test(dt))  return "focus";
      if (/(health|vida|saúde|saude)/.test(dt)) return "health";
    }

    // 1) Legacy ability line (fallback)
    const m = /ability\s*:\s*([A-Za-zÀ-ÿ]+)/i.exec(text);
    if (m && m[1]) {
      const abil = m[1].toLowerCase();
      if (/(ego|logic|lógica|logica)/.test(abil)) return "focus";
      if (/(agility|melee|agilidade)/.test(abil)) return "health";
    }

    // 2) Free-text fallback
    if (/\b(Ego|Logic|Lógica|Logica)\b/i.test(hay)) return "focus";
    if (/\b(Agility|Melee|Agilidade)\b/i.test(hay)) return "health";
  } catch(e) { /* ignore */ }
  return "health";
}


/** Prefer the defender (the one who 'takes/sofre' damage). Fallback to <strong> only if not found. */
function getDefenderNameFromCard($html){
  try {
    const text = ($html && $html.text && $html.text()) ? $html.text() : "";
    // Match lines like "Name takes 10 ..." or "Nome sofre 10 ..."
    const rx = /([A-Za-zÀ-ÖØ-öø-ÿ0-9_'’\-\.\s]+?)\s+(?:sofre|takes)\s+\d+/i;
    const m = rx.exec(text);
    const name = m && (m[1] || "").trim();
    if (name) return name.replace(/\s+/g, " ");
  } catch(e){ /* ignore */ }
  return null;
}

function findTargetActor(message, $html){
  const getByName = (name) => {
    if (!name) return null;
    name = String(name).trim();
    // Prefer targeted tokens whose name matches
    const scene = canvas && canvas.scene;
    if (scene && canvas.tokens) {
      for (const t of canvas.tokens.placeables) {
        if (t?.document?.name?.trim() === name) return t.actor || t.document?.getActor();
      }
    }
    // Fallback: actors directory
    const a = game.actors?.getName?.(name);
    if (a) return a;
    return null;
  };

  // 1) Parse "takes/sofre" line from the card
  const nameFromCard = getDefenderNameFromCard($html);
  if (nameFromCard) {
    const a = getByName(nameFromCard);
    if (a) { dbg("target=cardName", nameFromCard); return a; }
  }

  // 2) Flags on ChatMessage (common patterns)
  try {
    const flags = message?.flags || {};
    const flatVals = new Set();
    const walk = (obj) => {
      if (!obj) return;
      if (typeof obj === "string") flatVals.add(obj);
      else if (Array.isArray(obj)) obj.forEach(walk);
      else if (typeof obj === "object") Object.values(obj).forEach(walk);
    };
    walk(flags);
    // Try matching to token/actor IDs
    const byId = (id) => {
      if (!id) return null;
      // Tokens by id
      if (canvas && canvas.tokens) {
        const t = canvas.tokens.placeables.find(t => t?.id === id || t?.document?.uuid === id || t?.document?.id === id);
        if (t) return t.actor || t.document?.getActor();
      }
      // Actor by id/uuid
      const a = fromUuidSync?.(id) || game.actors?.get?.(id);
      if (a?.actor) return a.actor;
      if (a) return a;
      return null;
    };
    for (const v of flatVals) {
      const a = byId(v);
      if (a) { dbg("target=message.flag", v); return a; }
    }
  } catch(e){ /* ignore */ }

  // 3) Current user targets
  try {
    const tgts = Array.from(game.user?.targets || []);
    if (tgts.length === 1) {
      const a = tgts[0]?.actor || tgts[0]?.document?.getActor?.();
      if (a) { dbg("target=user.targets"); return a; }
    }
  } catch(e){ /* ignore */ }

  // 4) Last resort: if we extracted the name but didn't find a token, try actors directory again
  if (nameFromCard) {
    const a = game.actors?.getName?.(nameFromCard);
    if (a) { dbg("target=actorsDir", nameFromCard); return a; }
  }

  // Give up
  return null;
}

function readDR(actor, category){
  const get = (obj, path) => {
    try {
      const gp = (foundry?.utils?.getProperty) ? foundry.utils.getProperty : (typeof getProperty === "function" ? getProperty : undefined);
      return gp ? gp(obj, path) : undefined;
    } catch(e){ return undefined; }
  };
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.abs(n) : 0;
  };

  // Defaults
  const defaultHealth = [
    "system.healthDamageReduction",
    "system.health.damageReduction",
    "system.health.dr"
  ];
  const defaultFocus = [
    "system.focusDamageReduction",
    "system.focus.damageReduction",
    "system.focus.dr"
  ];

  // Settings-extended paths (comma-separated strings)
  const cfgHealth = String(safeGetSetting(MODULE_ID, "healthDRPaths") || "").split(",").map(s => s.trim()).filter(Boolean);
  const cfgFocus  = String(safeGetSetting(MODULE_ID, "focusDRPaths")  || "").split(",").map(s => s.trim()).filter(Boolean);

  const healthPaths = Array.from(new Set([...cfgHealth, ...defaultHealth]));
  const focusPaths  = Array.from(new Set([...cfgFocus,  ...defaultFocus]));

  const pick = (paths) => {
    for (const p of paths) {
      const v = get(actor, p);
      if (v !== undefined && v !== null && v !== "") return toNum(v);
    }
    return 0;
  };

  const healthDR = actor ? pick(healthPaths) : 0;
  const focusDR  = actor ? pick(focusPaths)  : 0;
  const chosen = (category === "focus") ? focusDR : healthDR;

  dbg("MMDR", { actor: actor?.name, category, dr: { health: healthDR, focus: focusDR }, chosen });

  return { chosen, healthDR, focusDR };
}

function recomputeParenthetical(h, newDR){
  const rxX = /\(\s*([0-9]+)/i;
  let X = 0;
  const mx = rxX.exec(h?.toString() || "");
  if (mx) X = parseInt(mx[1], 10);
  const DR = Math.abs(typeof newDR === "number" ? newDR : 0);
  const Z = Math.max(X - DR, 0);
  h = h.replace(/(damageReduction(?:\s|&nbsp;|<[^>]+>)*:\s*(?:<[^>]+>\s*)*)(-?\d+)/i, (m, pre, num) => pre + String(DR));
  h = h.replace(/(damageReduction[\s\S]*?=\s*(?:<[^>]+>\s*)*)(-?\d+)/i, (m, pre, num) => pre + String(Z));
  return h;
}

function mmdrRewrite(message, html){
  const $ = window.jQuery;
  const $html = (html instanceof HTMLElement && $) ? $(html) : (html && html.jquery ? html : null);
  if (!$html) return;
  const $content = $html.find(".message-content");
  if (!$content.length) return;
  if (!isResultCard($html)) return;

  const flavor = String(message?.flavor || message?._roll?.options?.flavor || "");
  const category = detectCategory(flavor, $html);
dbg("cat", {from:"ability-line", category});

  
  
  const actor = findTargetActor(message, $html);
const drInfo = readDR(actor, category);
let dr = drInfo.chosen;
const drHealth = drInfo.healthDR;
const drFocus = drInfo.focusDR;

  let h = $content.html();
  // replace DR (write normalized DR)
  h = h.replace(/(damageReduction(?:\s|&nbsp;|<[^>]+>)*:\s*(?:<[^>]+>\s*)*)(-?\d+)/i, (m, pre, num) => pre + String(dr));
  // recompute parentheses
  h = recomputeParenthetical(h, dr);

  // compute total & force header
  const isFant = /\bFantastic\b/i.test($html.text() || h);
  const total = computeFinal(h, isFant);

  $content.html(h);
  try {
    if (safeGetSetting(MODULE_ID, "debug", false)) {
      const dbgObj = { actor: actor && actor.name, category, drHealth: drHealth, drFocus: drFocus, chosen: dr };
      $content.append(`<!-- MMDR ${JSON.stringify(dbgObj)} -->`);
    }
  } catch(e){}

  
  // Roll-like result line (optional, big number line)
  try {
    if (safeGetSetting(MODULE_ID, "useRollStyle", true)) {
      const textAll = ($html.text() || h);
      const mdM = /MarvelDie:\s*(\d+)/i.exec(textAll); const md = mdM ? parseInt(mdM[1],10) : 0;
      const xM  = /\(\s*(\d+)/i.exec(textAll);          const X  = xM  ? parseInt(xM[1],10)  : 0;
      const abilM = /\+\s*[A-Za-zÀ-ÿ]+\s+score\s*(-?\d+)/i.exec(textAll); const AB = abilM ? parseInt(abilM[1],10) : 0;
      const DR = Math.abs(dr);
// Effective (override via data-mmdr if present)
let _md = md, _X = X, _AB = AB, _isFant = /\bFantastic\b/i.test(textAll);
try {
  const metaRaw = $content.attr("data-mmdr");
  if (metaRaw) {
    const meta = JSON.parse(metaRaw);
    if (Number.isFinite(Number(meta.md)))  _md = Number(meta.md);
    if (Number.isFinite(Number(meta.X)))   _X  = Number(meta.X);
    if (Number.isFinite(Number(meta.AB)))  _AB = Number(meta.AB);
    if (typeof meta.isFant !== "undefined") _isFant = !!meta.isFant;
  }
} catch(e) {}
let Z  = Math.max(_X - DR, 0);
      const isFant = /\bFantastic\b/i.test(textAll);
      // Compute max total across selected targets for display
      let showZ = Z;
      let showTotal = 0;
      const targetsSel = Array.from(game.user?.targets || []);
      if (targetsSel.length > 0) {
        for (const t of targetsSel) {
          const act = t?.actor; if (!act) continue;
          const dri = (typeof readDR === "function") ? readDR(act, category) : { chosen: 0 };
          const DRi = Math.abs(Number(dri?.chosen ?? 0)) || 0;
          const Zi  = Math.max(X - DRi, 0);
          let toti = 0;
          if (Zi > 0) { toti = (_md * Zi) + _AB; if (_isFant) toti *= 2; }
          if (toti > showTotal) { showTotal = toti; showZ = Zi; }
        }
      } else {
        // Single target / fallback
        showZ = Z;
        if (Z > 0) { showTotal = (_md * Z) + _AB; if (_isFant) showTotal *= 2; }
      }

      const abilityNameM = /(Ego|Logic|Melee|Agility)/i.exec(textAll);
      const abilityName = abilityNameM ? abilityNameM[1] : (category === "focus" ? "Ego/Logic" : "Melee/Agility");
      const badgeCat = category.toUpperCase();
      const line = `
        <div class="mmdr-rollline ${category} ${isFant ? 'fantastic' : ''}">
          <div class="mmdr-rollline-left">
            <div class="mmdr-badge">${badgeCat}</div>
            ${isFant ? '<div class="mmdr-badge alt">FANTASTIC</div>' : ''}
          </div>
          <div class="mmdr-rollline-main">
            <div class="value">${showTotal}</div>
            <div class="formula">${md} × ${showZ} + ${abilityName} ${AB >= 0 ? '+'+AB : AB}</div>
          </div>
        </div>`;
      $content.append(line);
      // === MMDR Actions Row (centered, 3 buttons) ===
      try {
        const $actions = $(`<div class="mmdr-actions"></div>`);
        const targetCat = (String(category).toLowerCase() === "focus") ? "FOCUS" : "HEALTH";
        const btnHtml = `
  <button type="button" class="mmdr-apply-btn ${targetCat.toLowerCase()}" data-action="full"
    data-category="${targetCat.toLowerCase()}" data-total="${showTotal}" data-message-id="${message?.id || ""}"
    data-md="${md}" data-x="${X}" data-ab="${AB}" data-fant="${isFant?1:0}"
    title="Aplicar ${showTotal} em ${targetCat}" tabindex="0">Aplicar</button>
  <button type="button" class="mmdr-apply-btn ${targetCat.toLowerCase()}" data-action="half"
    data-category="${targetCat.toLowerCase()}" data-total="${showTotal}" data-message-id="${message?.id || ""}"
    data-md="${md}" data-x="${X}" data-ab="${AB}" data-fant="${isFant?1:0}"
    title="Aplicar metade (${Math.ceil(showTotal/2)}) em ${targetCat}" tabindex="0">½ Dano</button>
  <button type="button" class="mmdr-apply-btn ${targetCat.toLowerCase()}" data-action="heal"
    data-category="${targetCat.toLowerCase()}" data-total="${showTotal}" data-message-id="${message?.id || ""}"
    data-md="${md}" data-x="${X}" data-ab="${AB}" data-fant="${isFant?1:0}"
    title="Curar ${showTotal} em ${targetCat}" tabindex="0">Curar</button>
`;
        $actions.append($(btnHtml));
        $content.append($actions);
        // Attach MMDR metadata to the message content for robust reads
        try {
          const meta = { md, X, AB, isFant, category: targetCat.toLowerCase() };
          $content.attr("data-mmdr", JSON.stringify(meta));
          // Also add a hidden comment to help debugging in HTML dumps
          $content.append(`<!-- MMDR ${JSON.stringify(meta)} -->`);
        } catch(e) { console.warn("[MMDR] failed to attach meta", e); }


        
      // Build per-target summary table (Alvo | DR | Total) using per-actor DR (no parsing)
      const targets = Array.from(game.user?.targets || []);
      if (targets.length > 0) {
        // Prefer values from our meta attached to the card
        const metaRaw = $content.attr("data-mmdr");
        let md = 0, X = 0, AB = 0, isFant = false;
        try { const meta = metaRaw ? JSON.parse(metaRaw) : null; md = Number(meta?.md)||0; X = Number(meta?.X)||0; AB = Number(meta?.AB)||0; isFant = !!meta?.isFant; } catch(e) {}
        // If still missing, fallback to text parsing
        if (!(md && X)) {
          const textAll = (($html?.text && $html.text()) || (html?.textContent || "") || "") + "";
          const mdM  = /MarvelDie:\s*(\d+)/i.exec(textAll); if (mdM) md = parseInt(mdM[1],10);
          const xM   = /\(\s*(\d+)/i.exec(textAll);         if (xM)  X  = parseInt(xM[1],10);
          const abM  = /\+\s*[A-Za-zÀ-ÿ]+\s+score\s*(-?\d+)/i.exec(textAll); if (abM) AB = parseInt(abM[1],10);
          isFant = /\bFantastic\b/i.test(textAll);
        }
        // Last resort: big number from the card
        if (!(md && X)) {
          try {
            const nums = Array.from(String((($html?.text && $html.text()) || (html?.textContent || "") || "")).matchAll(/\b(\d{1,3})\b/g)).map(m=>parseInt(m[1],10));
            const maxN = nums.length ? Math.max(...nums) : 0;
            if (maxN > 0) { if (!md) md = 1; X = maxN; }
          } catch(e) {}
        }


        let rows = "";
        for (const t of targets) {
          const actor = t?.actor; if (!actor) continue;
          const drInfo = (typeof readDR === "function") ? readDR(actor, category) : { chosen: 0 };
          const DR = Math.abs(Number(drInfo?.chosen ?? 0)) || 0;
          let Z  = Math.max(X - DR, 0);
          let tot = 0;
          if (Z > 0) { tot = (md * Z) + AB; if (_isFant) tot *= 2; }
          rows += `<div class="mmdr-row"><span class="nm">${actor.name}</span><span class="dr">DR ${DR}</span><span class="tt">${tot}</span></div>`;
        }
        if (rows) {
          const $multi = $(`
            <div class="mmdr-multi">
              <div class="hdr">Resumo por Alvo (${targetCat})</div>
              <div class="hdrrow"><span>Alvo</span><span>DR</span><span>Total</span></div>
              <div class="tbl">${rows}</div>
            </div>
          `);
          $content.append($multi);
        }
      }
    // Remove original damage text lines for clarity (multi-target)
    try {
      $content.children("p").filter(function(){
        const t = ($(this).text()||"").toLowerCase();
        return t.includes(" takes ") || t.includes(" sofre ") || (t.includes("re:") && t.includes("damage multiplier"));
      }).remove();
    } catch(e){}
    } catch(e){ console.warn("[MMDR] actions/summary skipped:", e); }

    }
  } catch(e) {}

  // Styled breakdown (optional)
  try {
    if (safeGetSetting(MODULE_ID, "showStyledBreakdown", true)) {
      const textAll = ($html.text() || h);
      const mdM = /MarvelDie:\s*(\d+)/i.exec(textAll); const md = mdM ? parseInt(mdM[1],10) : 0;
      const xM  = /\(\s*(\d+)/i.exec(textAll);          const X  = xM  ? parseInt(xM[1],10)  : 0;
      const abilM = /\+\s*[A-Za-zÀ-ÿ]+\s+score\s*(-?\d+)/i.exec(textAll); const AB = abilM ? parseInt(abilM[1],10) : 0;
      const DR = Math.abs(dr);
      // Effective values (allow meta override)
      let _md = md, _X = X, _AB = AB, _isFant = /\bFantastic\b/i.test(textAll);
      try {
        const metaRaw = $content.attr("data-mmdr");
        if (metaRaw) {
          const meta = JSON.parse(metaRaw);
          if (Number.isFinite(Number(meta.md)))  _md = Number(meta.md);
          if (Number.isFinite(Number(meta.X)))   _X  = Number(meta.X);
          if (Number.isFinite(Number(meta.AB))) _AB = Number(meta.AB);
          if (typeof meta.isFant !== "undefined") _isFant = !!meta.isFant;
        }
      } catch(e) {}
      let Z  = Math.max(_X - DR, 0);
      const chipFant = isFant ? '<span class="mmdr-chip fantastic">Fantastic</span>' : '';
      const box = `
      <div class="mmdr-breakdown">
        <div class="mmdr-header">
          <span class="mmdr-chip ${category}">${category}</span>
          ${chipFant}
        </div>
        <div class="mmdr-grid">
          <div class="mmdr-item"><span class="k">Marvel Die</span><span class="v">${md}</span></div>
          <div class="mmdr-item"><span class="k">Base (X)</span><span class="v">${X}</span></div>
          <div class="mmdr-item"><span class="k">Damage Reduction</span><span class="v">${DR}</span></div>
          <div class="mmdr-item"><span class="k">After DR (Z)</span><span class="v">${Z}</span></div>
          <div class="mmdr-item"><span class="k">Ability</span><span class="v">${AB}</span></div>
          <div class="mmdr-item"><span class="k">Total</span><span class="v">${total}</span></div>
        </div>
      </div>`;
      // removed breakdown box in 0.9.14
    }
  } catch(e) {}

  setTimeout(() => forceHeaderDamageNumber($html, total), 0);
}
