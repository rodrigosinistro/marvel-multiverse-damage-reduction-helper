## 0.9.83 - 2025-10-03 03:10
- **Fix:** `parsePillFallback` usava seletor inválido e falhava ⇒ agora detecta o **HEALTH/FOCUS N** corretamente.
- **Fix:** `parseMultiFromText` com regex corrompida ⇒ restaurado suporte a "<Nome> recebe N health/focus dano" (EN/PT).
- **UX:** log final atualizado para 0.9.83 para evitar confusão de dupla versão no console.

## 0.9.82 - 2025-10-03 02:59
- **Hotfix:** removido trecho duplicado após `categoryFromText()` que causava erro de parse no carregamento (linha ~93).

## 0.9.81 - 2025-10-03 02:55
- **Fix crítico:** corrigidos colchetes/linhas duplicadas inseridos em 0.9.80 que impediam o carregamento do módulo (JS parse error em ~linha 83). 
- **Estável:** `sp()` devidamente fechado; `categoryFromText()` limpo e helpers em ordem.

## 0.9.80 - 2025-10-03 02:49
- Fix: **parseAbilityFrom** não carregava em alguns ambientes → erro “parseAbilityFrom is not defined” corrigido.
- Melhoria: heurística mais segura para detectar **roll direto de Atributo** (sem Poder/Arma). 
- Limpeza: logs antigos removidos/atualizados.

## 0.9.79 - 2025-10-03 02:43
- Fix: classify damage for direct **Attribute** attacks.
  - If attack is from **Melee** or **Agility** ability (and not from a Power/Weapon), treat as **Health** damage.
  - If attack is from **Ego** or **Logic** ability (and not from a Power/Weapon), treat as **Focus** damage.
- Robust detection via chat card parsing (`ability: <name>` + absence of Power/Weapon markers or presence of `undefined: undefined`), keeping existing explicit DamageType tags untouched.

