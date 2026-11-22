// DicePlot — SillyTavern extension
// Simple mode: one precomputed 2d20 roll before each generation.
// The AI uses it only when a meaningful uncertain action occurs in this reply.
// Legacy check tags are kept available as an optional mode.

import { LEGACY_INSTRUCTIONS, LEGACY_RESULT_TEMPLATES, LEGACY_CATEGORY_DESC, LEGACY_TIER_TEXT } from './legacy-defaults.js';

const MODULE = 'diceplot';
const KEY_INSTRUCTION = 'diceplot_instruction';
const KEY_RESULT = 'diceplot_result';

// Mirrors of SillyTavern enums (not exposed through getContext)
const PROMPT_POSITION = { IN_PROMPT: 0, IN_CHAT: 1 };
const PROMPT_ROLE_SYSTEM = 0;

const CHECK_RE = /<check\b([^>]*?)\/?>(?:\s*<\/check>)?/gi;
const JUDGED_RE = /<judged\b([^>]*?)\/?>(?:\s*<\/judged>)?/gi;
const SIMPLE_TAG_RE = /<dp-roll\b([^>]*?)\/?>(?:\s*<\/dp-roll>)?/gi;
const ESCAPED_TAG_RE = /&lt;(check|judged|dp-roll)\b[\s\S]*?&gt;(?:\s*&lt;\/\1&gt;)?/gi;

const CATEGORIES = [
    { key: 'overwhelming', label: 'Подавляющее преимущество', promptLabel: 'Overwhelming advantage', aliases: ['압도적우위', 'overwhelming', 'overwhelmingadvantage', '압도'] },
    { key: 'advantage', label: 'Преимущество', promptLabel: 'Advantage', aliases: ['우위', 'advantage'] },
    { key: 'normal', label: 'Обычная проверка', promptLabel: 'Normal', aliases: ['평범', 'normal', '보통'] },
    { key: 'disadvantage', label: 'Помеха', promptLabel: 'Disadvantage', aliases: ['불리', 'disadvantage'] },
    { key: 'irrelevant', label: 'Не относится к проверке', promptLabel: 'Irrelevant', aliases: ['무관', 'irrelevant', '해당없음'] },
];

const TIER_LABELS = {
    crit: 'Критический успех',
    success: 'Успех',
    partial: 'Частичный успех',
    fail: 'Провал',
    fumble: 'Критический провал',
};

const DEFAULT_INSTRUCTION = `[Dice Check Tag Rules]
Only when a challenge is uncertain AND failure would meaningfully change the story, end your response with the tag below on its own line. If either condition is missing, do not add it.
<check who="user" action="what is being attempted" dc="number" stake="what happens on failure"/>
- who="user": the scene presents a challenge to {{user}}. The check applies to {{user}}'s next action.
- who="char": {{char}} (or an NPC) is about to attempt something with an uncertain outcome. The check resolves in the next response. In the response that adds this tag, stop right before the attempt and do not narrate its result.
- dc is 5-25, based only on how difficult the situation itself is. Ignore the abilities or resources of whoever acts. (5 easy / 10 moderate / 15 hard / 20 very hard / 25 nearly impossible)
- At most one tag per response. Never narrate or hint at the outcome in advance.
- Write action and stake in the same language as the story.

Use a check:
- A guarded door → <check who="user" action="get past the guard" dc="13" stake="spotted and chased"/>
- An angry merchant must be persuaded → <check who="user" action="persuade the merchant" dc="12" stake="the deal falls through"/>
- A collapsing bridge, a spreading poison, a pursuer closing in, cracking a safe before the alarm goes off
- {{char}} is about to lie to {{user}} → <check who="char" action="hide the lie" dc="12" stake="the lie is exposed"/>
- An NPC is about to ambush {{user}} → <check who="char" action="ambush" dc="13" stake="the attack misses and their position is revealed"/>
Do not use a check:
- There is no reason to fail, like ordering food or opening an unlocked door
- There is no success or failure involved, like small talk with a friend
- {{char}}'s reaction to a confession or a date invitation (decide by personality, not dice)
- It can simply be retried with no time pressure
- In combat, not on every attack; only at decisive moments that turn the fight`;

const DEFAULT_RESULT_TEMPLATE = `[Dice Check — follow this in the current response]
Check: {subject} — {action} / DC {dc} / On failure: {stake}
Dice (2d20): {d1}, {d2}

Classify {subject}'s action this turn into exactly one category below and follow its outcome as written.
Only facts already established in the character card, persona, or earlier conversation count as grounds. Abilities or resources newly claimed or invented this turn do not count. If unsure, choose Normal.
{outcomes}

Do not change or soften the outcome. Narrate it in a way true to the characters. Do not mention dice rolls or DC numbers in the story.
At the very end of the response, add <judged as="category" why="the established fact used as grounds"/> on its own line.`;

const DEFAULT_CATEGORY_DESC = {
    overwhelming: 'established facts make this practically no obstacle',
    advantage: 'directly uses established resources, abilities, or circumstances',
    normal: 'no particular edge or handicap',
    disadvantage: 'established as unskilled at this, underprepared, or a reckless approach',
    irrelevant: 'does something unrelated to this check',
};

const DEFAULT_TIER_TEXT = {
    crit: 'Critical success. Succeeds beyond expectations and gains an extra benefit.',
    success: 'Success. Achieves what was intended.',
    partial: 'Partial success. Succeeds, but at a cost or with a new complication.',
    fail: 'Failure. Does not succeed, and the risk comes true: {stake}',
    fumble: 'Critical failure. Fails, and the situation gets significantly worse: {stake}',
};

const OVERWHELMING_TEXT = 'Automatic success. No roll needed.';
const IRRELEVANT_TEXT = 'Ignore this check and continue naturally.';

const defaultSettings = Object.freeze({
    enabled: true,
    mode: 'simple', // 'simple' or 'legacy'
    hideTags: true,
    showBadges: true,
    showToast: false,
    rerollOnSwipe: false,
    partialMargin: 4,
    cooldown: 0,
    instructionPosition: 'chat', // 'chat' | 'prompt'
    instructionDepth: 1,
    instruction: DEFAULT_INSTRUCTION,
    resultTemplate: DEFAULT_RESULT_TEMPLATE,
    categoryDesc: DEFAULT_CATEGORY_DESC,
    tierText: DEFAULT_TIER_TEXT,
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE]) {
        extensionSettings[MODULE] = structuredClone(defaultSettings);
    }
    const s = extensionSettings[MODULE];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!Object.hasOwn(s, key)) {
            s[key] = structuredClone(value);
        } else if (value && typeof value === 'object') {
            for (const [sub, subValue] of Object.entries(value)) {
                if (!Object.hasOwn(s[key], sub)) s[key][sub] = subValue;
            }
        }
    }
    if (LEGACY_INSTRUCTIONS.includes(s.instruction)) s.instruction = DEFAULT_INSTRUCTION;
    if (LEGACY_RESULT_TEMPLATES.includes(s.resultTemplate)) s.resultTemplate = DEFAULT_RESULT_TEMPLATE;
    for (const [key, legacy, current] of [['categoryDesc', LEGACY_CATEGORY_DESC, DEFAULT_CATEGORY_DESC], ['tierText', LEGACY_TIER_TEXT, DEFAULT_TIER_TEXT]]) {
        for (const sub of Object.keys(current)) {
            if (legacy.some(l => l[sub] === s[key][sub])) s[key][sub] = current[sub];
        }
    }
    delete s.sideText;
    return s;
}

function getChatState() {
    const { chatMetadata } = SillyTavern.getContext();
    if (!chatMetadata) return {};
    if (!chatMetadata[MODULE]) chatMetadata[MODULE] = {};
    return chatMetadata[MODULE];
}

function saveChatState() {
    const ctx = SillyTavern.getContext();
    (ctx.saveMetadataDebounced ?? ctx.saveMetadata)?.();
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function parseAttrs(str) {
    const attrs = {};
    const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/g;
    let m;
    while ((m = re.exec(str)) !== null) {
        attrs[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    }
    return attrs;
}

function findLastTag(text, re) {
    if (typeof text !== 'string') return null;
    let last = null;
    for (const m of text.matchAll(re)) last = m;
    return last ? parseAttrs(last[1]) : null;
}

function parseCheck(text) {
    const attrs = findLastTag(text, CHECK_RE);
    if (!attrs) return null;
    const dc = parseInt(attrs.dc, 10);
    if (!Number.isFinite(dc)) return null;
    return {
        who: String(attrs.who ?? '').toLowerCase() === 'char' ? 'char' : 'user',
        action: attrs.action || 'Challenge',
        dc: Math.max(1, Math.min(30, dc)),
        stake: attrs.stake || 'The situation gets worse',
    };
}

function parseJudged(text) {
    const attrs = findLastTag(text, JUDGED_RE);
    if (!attrs) return null;
    return { category: normalizeCategory(attrs.as), why: attrs.why || '' };
}

function normalizeCategory(value) {
    const v = String(value ?? '').replace(/\s+/g, '').toLowerCase();
    for (const c of CATEGORIES) {
        const names = [c.label, c.promptLabel].map(n => n.replace(/\s+/g, '').toLowerCase());
        if (names.includes(v) || c.aliases.includes(v)) return c.key;
    }
    return null;
}

function stripTags(text) {
    if (typeof text !== 'string') return text;
    return text.replace(CHECK_RE, '').replace(JUDGED_RE, '').replace(SIMPLE_TAG_RE, '').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function rollD20() {
    const buf = new Uint32Array(1);
    // Rejection sampling keeps the distribution uniform
    const limit = Math.floor(0x100000000 / 20) * 20;
    do {
        crypto.getRandomValues(buf);
    } while (buf[0] >= limit);
    return (buf[0] % 20) + 1;
}

function tierOf(die, dc, margin) {
    if (die === 20) return 'crit';
    if (die === 1) return 'fumble';
    if (die >= dc) return 'success';
    if (die >= dc - margin) return 'partial';
    return 'fail';
}

function dieFor(category, d1, d2) {
    switch (category) {
        case 'advantage': return Math.max(d1, d2);
        case 'disadvantage': return Math.min(d1, d2);
        case 'normal': return d1;
        default: return null;
    }
}

function fill(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, (all, key) => (Object.hasOwn(vars, key) ? String(vars[key]) : all));
}

function describeOutcome(category, roll, s) {
    const vars = { action: roll.action, dc: roll.dc, stake: roll.stake, d1: roll.d1, d2: roll.d2 };
    if (category === 'overwhelming') return { tier: 'success', text: OVERWHELMING_TEXT };
    if (category === 'irrelevant') return { tier: null, text: IRRELEVANT_TEXT };
    const die = dieFor(category, roll.d1, roll.d2);
    const tier = tierOf(die, roll.dc, Number(s.partialMargin) || 0);
    return { tier, die, text: `${die} → ${fill(s.tierText[tier], vars)}` };
}

function buildResultPrompt(roll, s) {
    const lines = CATEGORIES.map(c => {
        const desc = s.categoryDesc[c.key] ? ` (${s.categoryDesc[c.key]})` : '';
        return `- ${c.promptLabel}${desc} → ${describeOutcome(c.key, roll, s).text}`;
    });
    return fill(s.resultTemplate, {
        subject: roll.who === 'char' ? '{{char}}' : '{{user}}',
        action: roll.action,
        dc: roll.dc,
        stake: roll.stake,
        d1: roll.d1,
        d2: roll.d2,
        outcomes: lines.join('\n'),
    });
}


 // ---------------------------------------------------------------------------
 // One-response simple checks
 // ---------------------------------------------------------------------------

 const SIMPLE_DIFFICULTIES = [7, 11, 15, 19];
 const SIMPLE_SKILLS = ['advantage', 'normal', 'disadvantage'];
 const SIMPLE_LABELS = {
     advantage: 'Преимущество', normal: 'Обычно', disadvantage: 'Помеха',
 };

 function parseSimpleUsed(text) {
     const tag = findLastTag(text, SIMPLE_TAG_RE);
     if (!tag || !SIMPLE_SKILLS.includes(tag.skill)) return null;
     const dc = Number(tag.dc);
     if (!SIMPLE_DIFFICULTIES.includes(dc)) return null;
     return { skill: tag.skill, dc };
 }

 function resolveSimpleRoll(chat, type, s) {
     const anchorIdx = findAnchorIndex(chat, type);
     if (anchorIdx < 0) return null;
     const anchor = chat[anchorIdx];
     // Message-scoped storage: each chat keeps its own rolls.
     anchor.extra = anchor.extra ?? {};
     let roll = anchor.extra.diceplotSimple;
     const reroll = s.rerollOnSwipe && (type === 'swipe' || type === 'regenerate');
     if (!roll || !Number.isInteger(roll.d1) || !Number.isInteger(roll.d2) || reroll) {
         roll = { d1: rollD20(), d2: rollD20() };
         anchor.extra.diceplotSimple = roll;
     }
     return { roll, anchorIdx };
 }

 function simpleTierText(tier) {
     return ({ crit:'CRITICAL SUCCESS', success:'SUCCESS', partial:'PARTIAL SUCCESS (with cost)',
         fail:'FAILURE (meaningful setback)', fumble:'CRITICAL FAILURE (serious setback)' })[tier];
 }

 function buildSimplePrompt(roll, margin) {
     const rows = SIMPLE_SKILLS.map(skill => {
         const die = dieFor(skill, roll.d1, roll.d2);
         return `${skill} (${die}): ${SIMPLE_DIFFICULTIES.map(dc => `${dc}: ${simpleTierText(tierOf(die, dc, margin))}`).join(' | ')}`;
     });
     return `[DicePlot — optional one-step scene check]
 Only apply ONE check when an action already attempted or unfolding in THIS reply has genuinely uncertain success AND meaningful consequences for failure. Otherwise IGNORE this block entirely. Do not invent danger to justify a check. Never decide {{user}}'s unspoken actions. Do not roll for everyday activities, normal conversation, personal feelings, affection, consent or romantic choices.
 Choose obstacle difficulty independently of character ability: 7 easy; 11 moderate; 15 hard; 19 extreme. Choose advantage ONLY for established relevant skills, equipment or favorable circumstances; disadvantage for established limitations or bad position; otherwise normal. Do not invent stats, modifiers or established facts. If outcome is practically certain or impossible, narrate naturally without a roll.
 Dice were already rolled in JavaScript: ${roll.d1}, ${roll.d2}. Use only the table cell matching selected difficulty and approach:
 ${rows.join('\n')}
 SUCCESS: succeeds. PARTIAL: succeeds with a meaningful cost. FAILURE: does not succeed and a reasonable complication follows. CRITICAL results intensify the consequence without overriding player control. The fiction and established character abilities always apply. Do not force random mishaps into uneventful scenes.
 If and ONLY if a check affected the scene, append <dp-roll skill="normal" dc="11"/> on a separate final line, replacing skill and dc with the actual selected values. This marker is hidden. Do not mention dice in prose and do not output <check> or <judged>.`;
 }

// ---------------------------------------------------------------------------
// Pending check resolution
// ---------------------------------------------------------------------------

function findLastIndex(arr, pred, from = arr.length - 1) {
    for (let i = from; i >= 0; i--) if (pred(arr[i], i)) return i;
    return -1;
}

const isVisible = m => m && !m.is_system;

/**
 * The anchor is the message the upcoming reply responds to. Rolls are stored on it,
 * so swipes and continues of the same reply reuse the same dice.
 */
function findAnchorIndex(chat, type) {
    const last = findLastIndex(chat, isVisible);
    if (last < 0) return -1;
    if (type === 'swipe' || type === 'continue' || type === 'regenerate') return findLastIndex(chat, isVisible, last - 1);
    return last;
}

/**
 * Finds the <check/> that applies to the reply after the anchor.
 * - Anchor is a user message: the check in the AI message(s) right before it (user or char check).
 * - Anchor is an AI message (generation without user input): only a char check on that message.
 */
function findSourceCheck(chat, anchorIdx) {
    const anchor = chat[anchorIdx];
    if (!anchor) return null;
    if (!anchor.is_user) {
        const check = parseCheck(anchor.mes);
        return check?.who === 'char' ? { index: anchorIdx, ...check } : null;
    }
    for (let i = anchorIdx - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m) continue;
        if (m.is_user) break;
        if (m.is_system) continue;
        const check = parseCheck(m.mes);
        if (check) return { index: i, ...check };
    }
    return null;
}

/** True if a roll happened within the last `cooldown` user turns before the anchor. */
function isOnCooldown(chat, anchorIdx, cooldown) {
    if (!cooldown || cooldown <= 0) return false;
    let userTurns = 0;
    for (let i = anchorIdx - 1; i >= 0; i--) {
        const m = chat[i];
        if (!isVisible(m)) continue;
        if (m.extra?.[MODULE]) return true;
        if (m.is_user && ++userTurns >= cooldown) break;
    }
    return false;
}

/**
 * Returns the roll that applies to the upcoming generation, rolling new dice if needed.
 */
function resolveRoll(chat, type, s) {
    const anchorIdx = findAnchorIndex(chat, type);
    if (anchorIdx < 0) return null;
    const anchor = chat[anchorIdx];
    const state = getChatState();
    let roll = anchor.extra?.[MODULE] ?? null;

    if (roll) {
        // Keep check info in sync if the user edited the tag; drop the roll if the tag was removed
        if (typeof roll.source === 'number') {
            const check = parseCheck(chat[roll.source]?.mes);
            if (!check) {
                delete anchor.extra[MODULE];
                return null;
            }
            Object.assign(roll, check);
        }
        const isReroll = type === 'swipe' || type === 'regenerate';
        if (s.rerollOnSwipe && isReroll) {
            roll.d1 = rollD20();
            roll.d2 = rollD20();
            return { roll, anchorIdx, fresh: true };
        }
        return { roll, anchorIdx, fresh: false };
    }

    let check = null;
    let source = null;
    if (state.manual) {
        check = state.manual;
        source = 'manual';
        delete state.manual;
        saveChatState();
    } else {
        const found = findSourceCheck(chat, anchorIdx);
        if (!found) return null;
        if (state.cancelled === found.index) return null;
        if (isOnCooldown(chat, anchorIdx, Number(s.cooldown))) return null;
        check = found;
        source = found.index;
    }

    roll = {
        who: check.who ?? 'user',
        action: check.action,
        dc: check.dc,
        stake: check.stake,
        d1: rollD20(),
        d2: rollD20(),
        source,
    };
    anchor.extra = anchor.extra ?? {};
    anchor.extra[MODULE] = roll;
    return { roll, anchorIdx, fresh: true };
}

// ---------------------------------------------------------------------------
// Generation interceptor
// ---------------------------------------------------------------------------

function clearPrompts() {
    const { setExtensionPrompt } = SillyTavern.getContext();
    setExtensionPrompt(KEY_INSTRUCTION, '', PROMPT_POSITION.IN_CHAT, 0);
    setExtensionPrompt(KEY_RESULT, '', PROMPT_POSITION.IN_CHAT, 0);
}

globalThis.diceplotInterceptor = async function (coreChat, _contextSize, _abort, type) {
    clearPrompts();
    const s = getSettings();
    if (!s.enabled) return;
    if (type === 'quiet' || type === 'impersonate') return;

    const ctx = SillyTavern.getContext();

    if (s.mode !== 'legacy') {
        // Strip technical tags from the in-memory prompt copy only.
        for (let i = 0; i < coreChat.length; i++) {
            if (type !== 'continue' || i !== coreChat.length - 1) {
                if (typeof coreChat[i]?.mes === 'string') coreChat[i].mes = stripTags(coreChat[i].mes);
            }
        }
        const simple = resolveSimpleRoll(ctx.chat, type, s);
        if (!simple) return;
        ctx.setExtensionPrompt(KEY_RESULT,
            buildSimplePrompt(simple.roll, Math.max(0, Math.min(10, Number(s.partialMargin) || 0))),
            PROMPT_POSITION.IN_CHAT, 0, false, PROMPT_ROLE_SYSTEM);
        return;
    }

    // 1. The rule that tells the AI when to emit <check/>
    const instructionInChat = s.instructionPosition !== 'prompt';
    ctx.setExtensionPrompt(
        KEY_INSTRUCTION,
        s.instruction,
        instructionInChat ? PROMPT_POSITION.IN_CHAT : PROMPT_POSITION.IN_PROMPT,
        instructionInChat ? Math.max(0, Number(s.instructionDepth) || 0) : 0,
        false,
        PROMPT_ROLE_SYSTEM,
    );

    // 2. Remove old tags from the prompt copy (stored messages stay intact)
    for (let i = 0; i < coreChat.length; i++) {
        const isContinuePrefix = type === 'continue' && i === coreChat.length - 1;
        if (!isContinuePrefix && typeof coreChat[i]?.mes === 'string') {
            coreChat[i].mes = stripTags(coreChat[i].mes);
        }
    }

    // 3. Roll and inject the result at the very bottom
    const resolved = resolveRoll(ctx.chat, type, s);
    if (!resolved) return;
    const { roll, anchorIdx, fresh } = resolved;

    ctx.setExtensionPrompt(KEY_RESULT, buildResultPrompt(roll, s), PROMPT_POSITION.IN_CHAT, 0, false, PROMPT_ROLE_SYSTEM);

    if (fresh) {
        try { ctx.saveChat?.(); } catch (e) { console.warn(`[${MODULE}] save failed`, e); }
        if (s.showToast) {
            toastr.info(`${subjectLabel(roll)} ${roll.action} · СЛ ${roll.dc}`, `🎲 d20: ${roll.d1} / ${roll.d2}`, { timeOut: 4000 });
        }
    }
    renderBadge(anchorIdx);
};

// ---------------------------------------------------------------------------
// Display: hide tags, show badges
// ---------------------------------------------------------------------------

let formatterHookInstalled = false;

function installFormatterHook() {
    const { messageFormatter } = SillyTavern.getContext();
    if (!messageFormatter?.addHook) return;
    messageFormatter.addHook((mes) => (getSettings().hideTags ? stripTags(mes) : mes), {
        stage: messageFormatter.stage?.BEFORE_REGEX ?? 'beforeRegex',
        order: messageFormatter.order?.EARLIEST ?? 0,
    });
    formatterHookInstalled = true;
}

/** Fallback for SillyTavern versions without the message formatter hook API. */
function hideTagsInDom(mesTextEl) {
    if (formatterHookInstalled || !getSettings().hideTags || !mesTextEl) return;
    const html = mesTextEl.innerHTML;
    const cleaned = html.replace(ESCAPED_TAG_RE, '');
    if (cleaned !== html) mesTextEl.innerHTML = cleaned;
}

function subjectLabel(rollOrCheck) {
    const { name1, name2 } = SillyTavern.getContext();
    return rollOrCheck?.who === 'char' ? (name2 || 'Персонаж') : (name1 || 'Пользователь');
}

/** The roll a reply used is stored on the message right before it. */
function findRollBefore(chat, idx) {
    const prev = findLastIndex(chat, isVisible, idx - 1);
    return prev >= 0 ? chat[prev].extra?.[MODULE] ?? null : null;
}

function badgeLines(chat, idx) {
    const msg = chat[idx];
    if (!isVisible(msg)) return [];
    const s = getSettings();
    const lines = [];

    if (!msg.is_user && s.mode !== 'legacy') {
        const used = parseSimpleUsed(msg.mes);
        const previous = findLastIndex(chat, isVisible, idx - 1);
        const roll = previous >= 0 ? chat[previous]?.extra?.diceplotSimple : null;
        if (used && roll) {
            const die = dieFor(used.skill, roll.d1, roll.d2);
            const tier = tierOf(die, used.dc, Math.max(0, Math.min(10, Number(s.partialMargin) || 0)));
            lines.push(`🎲 ${SIMPLE_LABELS[used.skill]} · ${die} / СЛ ${used.dc} · ${TIER_LABELS[tier]}`);
        }
    }

    if (!msg.is_user && s.mode === 'legacy') {
        const judged = parseJudged(msg.mes);
        if (judged) {
            const roll = findRollBefore(chat, idx);
            const label = CATEGORIES.find(c => c.key === judged.category)?.label ?? 'Неизвестная категория';
            let text = `⚖️ ${label}`;
            if (roll && judged.category) {
                const outcome = describeOutcome(judged.category, roll, s);
                if (outcome.die != null) text += ` → ${outcome.die} против СЛ ${roll.dc}`;
                if (outcome.tier) text += ` → ${TIER_LABELS[outcome.tier]}`;
            }
            if (judged.why) text += ` · ${judged.why}`;
            lines.push(text);
        }

        const check = parseCheck(msg.mes);
        if (check) {
            const cancelled = getChatState().cancelled === idx;
            lines.push(`🎯 ${cancelled ? '(отменена) ' : ''}Ожидается проверка: ${subjectLabel(check)} · ${check.action} · СЛ ${check.dc} · При провале: ${check.stake}`);
        }
    }

    const roll = s.mode === 'legacy' ? msg.extra?.[MODULE] : null;
    if (roll) lines.push(`🎲 ${subjectLabel(roll)} · ${roll.action} · СЛ ${roll.dc} · d20: ${roll.d1} / ${roll.d2}`);
    return lines;
}

function renderBadge(idx) {
    const el = document.querySelector(`#chat .mes[mesid="${idx}"]`);
    if (!el) return;
    const mesText = el.querySelector('.mes_text');
    hideTagsInDom(mesText);
    el.querySelector('.diceplot-badges')?.remove();

    const s = getSettings();
    if (!s.enabled || !s.showBadges || !mesText) return;
    const { chat } = SillyTavern.getContext();
    const lines = badgeLines(chat, idx);
    if (!lines.length) return;

    const box = document.createElement('div');
    box.className = 'diceplot-badges';
    for (const line of lines) {
        const div = document.createElement('div');
        div.className = 'diceplot-badge';
        div.textContent = line;
        box.appendChild(div);
    }
    mesText.insertAdjacentElement('afterend', box);
}

let renderAllTimer = null;
function renderAllBadges() {
    clearTimeout(renderAllTimer);
    renderAllTimer = setTimeout(() => {
        document.querySelectorAll('#chat .mes[mesid]').forEach(el => renderBadge(Number(el.getAttribute('mesid'))));
    }, 50);
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

function registerCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandNamedArgument, SlashCommandArgument, ARGUMENT_TYPE } = SillyTavern.getContext();
    if (!SlashCommandParser?.addCommandObject) return;

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dp-check',
        helpString: '<div>Назначает проверку для следующего ответа. Пример: <code>/dp-check dc=13 stake="стражник заметит" перелезть через стену</code>. Для проверки персонажа укажите <code>who=char</code>.</div>',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'dc', description: 'Сложность (DC, 5–25)', typeList: [ARGUMENT_TYPE.NUMBER], isRequired: true }),
            SlashCommandNamedArgument.fromProps({ name: 'stake', description: 'Последствия провала', typeList: [ARGUMENT_TYPE.STRING] }),
            SlashCommandNamedArgument.fromProps({ name: 'who', description: 'user или char (по умолчанию user)', typeList: [ARGUMENT_TYPE.STRING], enumList: ['user', 'char'] }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'Проверяемое действие', typeList: [ARGUMENT_TYPE.STRING] }),
        ],
        callback: (args, value) => {
            const dc = parseInt(args.dc, 10);
            if (!Number.isFinite(dc)) {
                toastr.warning('Укажите числовое значение dc.');
                return '';
            }
            getChatState().manual = {
                who: String(args.who ?? '').toLowerCase() === 'char' ? 'char' : 'user',
                action: String(value ?? '').trim() || 'Challenge',
                dc: Math.max(1, Math.min(30, dc)),
                stake: String(args.stake ?? '').trim() || 'The situation gets worse',
            };
            saveChatState();
            toastr.success(`Проверка назначена для следующего ответа (СЛ ${dc})`);
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dp-cancel',
        helpString: '<div>Отменяет ожидающую проверку. Если кубики уже брошены, удаляет результат.</div>',
        callback: () => {
            const { chat } = SillyTavern.getContext();
            const state = getChatState();
            delete state.manual;
            const lastIdx = findLastIndex(chat, isVisible);
            const last = chat[lastIdx];
            if (last && !last.is_user && parseCheck(last.mes) && !last.extra?.[MODULE]) {
                // Check announced but not rolled yet
                state.cancelled = lastIdx;
            } else {
                // Undo the most recent roll (back to the latest user message)
                for (let i = lastIdx; i >= 0; i--) {
                    const m = chat[i];
                    if (!isVisible(m)) continue;
                    const roll = m.extra?.[MODULE];
                    if (roll) {
                        if (typeof roll.source === 'number') state.cancelled = roll.source;
                        delete m.extra[MODULE];
                        SillyTavern.getContext().saveChat?.();
                        break;
                    }
                    if (m.is_user) break;
                }
            }
            saveChatState();
            renderAllBadges();
            toastr.info('Проверка отменена.');
            return '';
        },
    }));
}

// ---------------------------------------------------------------------------
// Wand menu (extensions menu next to the chat input)
// ---------------------------------------------------------------------------

function updateWandButton() {
    const enabled = getSettings().enabled;
    const label = document.getElementById('diceplot_wand_label');
    if (label) label.textContent = `DicePlot: ${enabled ? 'вкл.' : 'выкл.'}`;
    document.getElementById('diceplot_wand')?.classList.toggle('diceplot-off', !enabled);
}

function setEnabled(enabled) {
    const s = getSettings();
    s.enabled = enabled;
    if (!enabled) clearPrompts();
    SillyTavern.getContext().saveSettingsDebounced();
    syncSettingsUI();
    updateWandButton();
    renderAllBadges();
}

function createWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    if (document.getElementById('diceplot_wand')) return true;
    menu.insertAdjacentHTML('beforeend', `
        <div id="diceplot_wand" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="Включить/выключить DicePlot">
            <div class="fa-solid fa-dice-d20 extensionsMenuExtensionButton"></div>
            <span id="diceplot_wand_label"></span>
        </div>`);
    document.getElementById('diceplot_wand').addEventListener('click', () => {
        setEnabled(!getSettings().enabled);
        toastr.info(getSettings().enabled ? 'Проверки включены.' : 'Проверки выключены.', '🎲 DicePlot', { timeOut: 2000 });
    });
    updateWandButton();
    return true;
}

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));
}

function settingsHtml(s) {
    const categoryInputs = CATEGORIES.map(c => `
        <label class="diceplot-row">
            <span>${c.label}</span>
            <input class="text_pole" data-dp-path="categoryDesc.${c.key}" type="text" />
        </label>`).join('');
    const tierInputs = Object.keys(DEFAULT_TIER_TEXT).map(k => `
        <label class="diceplot-row">
            <span>${TIER_LABELS[k]}</span>
            <input class="text_pole" data-dp-path="tierText.${k}" type="text" />
        </label>`).join('');

    return `
    <div id="diceplot_settings" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🎲 DicePlot</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content diceplot-settings">
                <label class="checkbox_label"><input type="checkbox" data-dp-path="enabled" /><span>Включить DicePlot</span></label>
                <label class="diceplot-row"><span>Режим</span>
                    <select class="text_pole" data-dp-path="mode">
                        <option value="simple">Простой — без пресетов</option>
                        <option value="legacy">Пошаговый — старые теги проверок</option>
                    </select>
                </label>
                <small>Простой режим сразу готов к игре. Расширение учитывает навыки из карточек и текущие условия. Бросок используется только при неопределённом значимом исходе.</small>
                <label class="checkbox_label"><input type="checkbox" data-dp-path="hideTags" /><span>Скрывать теги в чате</span></label>
                <label class="checkbox_label"><input type="checkbox" data-dp-path="showBadges" /><span>Показывать плашки проверок</span></label>
                <label class="checkbox_label"><input type="checkbox" data-dp-path="showToast" /><span>Показывать уведомления о бросках</span></label>
                <label class="checkbox_label"><input type="checkbox" data-dp-path="rerollOnSwipe" /><span>Перебрасывать кубики при свайпе или повторной генерации</span></label>
                <div class="diceplot-legacy" ${s.mode === 'legacy' ? '' : 'hidden'}>

                <label class="diceplot-row">
                    <span>Диапазон частичного успеха (на сколько результат может быть ниже СЛ)</span>
                    <input class="text_pole" type="number" min="0" max="10" data-dp-path="partialMargin" />
                </label>
                <label class="diceplot-row">
                    <span>Пауза между проверками (число ходов без новых проверок; 0 — без паузы)</span>
                    <input class="text_pole" type="number" min="0" max="20" data-dp-path="cooldown" />
                </label>

                <hr />
                <b>Правила добавления тега проверки</b>
                <small>Правила для ИИ: когда добавлять тег &lt;check/&gt;. Текст отправляется модели на английском.</small>
                <div class="diceplot-inline">
                    <select class="text_pole" data-dp-path="instructionPosition">
                        <option value="chat">В чате (с указанной глубиной)</option>
                        <option value="prompt">После системного промпта</option>
                    </select>
                    <label>Глубина <input class="text_pole" type="number" min="0" max="20" data-dp-path="instructionDepth" /></label>
                </div>
                <textarea class="text_pole textarea_compact" rows="8" data-dp-path="instruction"></textarea>

                <hr />
                <b>Шаблон промпта с результатом проверки</b>
                <small>Доступные переменные: {subject} {action} {dc} {stake} {d1} {d2} {outcomes}</small>
                <textarea class="text_pole textarea_compact" rows="8" data-dp-path="resultTemplate"></textarea>

                <b>Критерии категорий (промпт на английском)</b>
                ${categoryInputs}

                <b>Формулировки результатов (промпт на английском)</b>
                <small>Можно использовать переменные, например {stake}</small>
                ${tierInputs}

                <div class="diceplot-inline">
                    <div id="diceplot_reset" class="menu_button">Восстановить стандартные тексты</div>
                </div>
                </div>
            </div>
        </div>
    </div>`;
}

function getPath(obj, path) {
    return path.split('.').reduce((o, k) => o?.[k], obj);
}

function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => o[k], obj);
    target[last] = value;
}

function syncSettingsUI() {
    const s = getSettings();
    document.querySelectorAll('#diceplot_settings [data-dp-path]').forEach(el => {
        const value = getPath(s, el.dataset.dpPath);
        if (el.type === 'checkbox') el.checked = !!value;
        else el.value = value ?? '';
    });
}

function createSettingsUI() {
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!container) return;
    container.insertAdjacentHTML('beforeend', settingsHtml(getSettings()));
    syncSettingsUI();

    const root = document.getElementById('diceplot_settings');
    root.addEventListener('input', onSettingChange);
    root.addEventListener('change', onSettingChange);
    root.querySelector('#diceplot_reset').addEventListener('click', async () => {
        const { Popup } = SillyTavern.getContext();
        const ok = Popup?.show?.confirm ? await Popup.show.confirm('DicePlot', 'Восстановить стандартные правила, шаблон, критерии и формулировки результатов?') : confirm('Восстановить стандартные тексты?');
        if (!ok) return;
        const s = getSettings();
        for (const key of ['instruction', 'resultTemplate', 'categoryDesc', 'tierText']) {
            s[key] = structuredClone(defaultSettings[key]);
        }
        SillyTavern.getContext().saveSettingsDebounced();
        syncSettingsUI();
    });
}

function onSettingChange(event) {
    const el = event.target;
    const path = el?.dataset?.dpPath;
    if (!path) return;
    let value;
    if (el.type === 'checkbox') value = el.checked;
    else if (el.type === 'number') value = Number(el.value) || 0;
    else value = el.value;
    setPath(getSettings(), path, value);
    SillyTavern.getContext().saveSettingsDebounced();
    if (path === 'mode') {
        const legacy = document.querySelector('#diceplot_settings .diceplot-legacy');
        if (legacy) legacy.hidden = value !== 'legacy';
        clearPrompts();
        renderAllBadges();
    }
    if (path === 'enabled') {
        if (!value) clearPrompts();
        updateWandButton();
    }
    if (['enabled', 'showBadges', 'hideTags'].includes(path)) renderAllBadges();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(function init() {
    const { eventSource, eventTypes, event_types } = SillyTavern.getContext();
    const ev = eventTypes ?? event_types;

    getSettings();
    installFormatterHook();
    createSettingsUI();
    registerCommands();
    if (!createWandButton() && ev.APP_READY) eventSource.on(ev.APP_READY, createWandButton);

    const rerender = () => renderAllBadges();
    for (const name of [
        'CHARACTER_MESSAGE_RENDERED',
        'USER_MESSAGE_RENDERED',
        'MESSAGE_UPDATED',
        'MESSAGE_EDITED',
        'MESSAGE_SWIPED',
        'MESSAGE_DELETED',
        'MORE_MESSAGES_LOADED',
        'CHAT_CHANGED',
    ]) {
        if (ev[name]) eventSource.on(ev[name], rerender);
    }

    // Prompts are rebuilt by the interceptor on every generation; keep them empty otherwise
    for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED']) {
        if (ev[name]) eventSource.on(ev[name], clearPrompts);
    }

    console.log(`[${MODULE}] loaded`);
})();
