import { Client, GatewayIntentBits, Partials, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes, MessageFlags } from 'discord.js';
import { SELECTORS } from './selectors.js';
import chokidar from 'chokidar';
import 'dotenv/config';
import WebSocket from 'ws';
import http from 'http';
import https from 'https';
import readline from 'readline';
import { stdin as input, stdout as output } from 'process';
import fs from 'fs';
import path from 'path';

// --- CONFIGURATION ---
const PORTS = [9222, 9000, 9001, 9002, 9003];
const CDP_CALL_TIMEOUT = 30000;
const POLLING_INTERVAL = 2000;
const RAW_CLI_ARGS = process.argv.slice(2).map(arg => String(arg || ''));
const CLI_ARGS = new Set(RAW_CLI_ARGS.map(arg => arg.toLowerCase()));
const RUN_STARTUP_TEST = CLI_ARGS.has('--test');
const EXIT_AFTER_STARTUP_TEST = RUN_STARTUP_TEST && !CLI_ARGS.has('--test-keepalive');

function getCliArgValue(flagName) {
    const lower = String(flagName || '').toLowerCase();
    if (!lower) return '';
    for (let i = 0; i < RAW_CLI_ARGS.length; i++) {
        const arg = RAW_CLI_ARGS[i];
        const a = arg.toLowerCase();
        if (a === lower && i + 1 < RAW_CLI_ARGS.length) {
            return String(RAW_CLI_ARGS[i + 1] || '').trim();
        }
        if (a.startsWith(`${lower}=`)) {
            return String(arg.slice(flagName.length + 1) || '').trim();
        }
    }
    return '';
}

const TEST_CHANNEL_ID = (getCliArgValue('--test-channel') || process.env.DISCORD_TEST_CHANNEL_ID || '').trim();
const RAW_DUMP_MODE = RUN_STARTUP_TEST
    || CLI_ARGS.has('--raw-dump')
    || ['1', 'true', 'on'].includes((process.env.RAW_RESPONSE_DUMP || '').toLowerCase());
const RAW_DUMP_FILE = (getCliArgValue('--raw-dump-file') || process.env.RAW_RESPONSE_DUMP_FILE || '').trim();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
});

// State
let cdpConnection = null;
let explicitTargetUrl = null; // Explicitly selected window
let isGenerating = false;
let lastActiveChannel = null;
let lastDiscordActivity = { key: '', at: 0 };
let WORKSPACE_ROOT = null;
let autoApproveMode = false;
const LOG_FILE = 'discord_interaction.log';
const ALLOWED_DISCORD_USER = (process.env.DISCORD_ALLOWED_USER_ID || '').trim();
const ALLOWED_DISCORD_USER_IS_ID = /^\d+$/.test(ALLOWED_DISCORD_USER);
const DISCORD_ACTIVITY_LOG_ENABLED = !['0', 'false', 'off'].includes((process.env.DISCORD_ACTIVITY_LOG || 'false').toLowerCase());
const DISCORD_ACTIVITY_LOG_TYPES = new Set([
    'APPROVAL',
    'ACTION',
    'ERROR'
]);

function isAuthorizedDiscordUser(user) {
    if (!ALLOWED_DISCORD_USER) return true;

    if (ALLOWED_DISCORD_USER_IS_ID) {
        return user.id === ALLOWED_DISCORD_USER;
    }

    // Backward-compat fallback for existing setups that stored username.
    return (user.username || '').toLowerCase() === ALLOWED_DISCORD_USER.toLowerCase();
}

function sanitizeAssistantResponse(rawText, promptText = '') {
    let text = String(rawText || '').replace(/\r/g, '');
    const prompt = String(promptText || '').trim();

    if (prompt && text.includes(prompt)) {
        const idx = text.lastIndexOf(prompt);
        if (idx >= 0) {
            text = text.slice(idx + prompt.length);
        }
    }

    const lines = text
        .split('\n')
        .map(line => line.replace(/\s+$/g, ''))
        .filter(line => {
            const t = line.trim().toLowerCase();
            if (!t) return false;
            if (/^[+-]\d+$/.test(t)) return false;
            if (t === 'edited') return false;
            if (isUiChromeLine(t)) return false;
            return true;
        });

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function sanitizeAssistantMarkdown(rawText, promptText = '') {
    let text = String(rawText || '').replace(/\r/g, '');
    const prompt = String(promptText || '').trim();

    if (prompt && text.includes(prompt)) {
        const idx = text.lastIndexOf(prompt);
        if (idx >= 0) {
            text = text.slice(idx + prompt.length);
        }
    }

    const lines = text
        .split('\n')
        .map(line => line.replace(/\s+$/g, ''))
        .filter(line => {
            const t = line.trim().toLowerCase();
            if (!t) return true;
            if (/^[+-]\d+$/.test(t)) return false;
            if (t === 'edited') return false;
            if (isUiChromeLine(t)) return false;
            return true;
        });

    return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function isUiChromeLine(line) {
    const t = String(line || '').trim().toLowerCase();
    if (!t) return true;
    if (/^[+-]\d+$/.test(t)) return true;
    if (/^\d+\s+chars[驕ｯ・ｶ繝ｻ・｢繝ｻ繧托ｽｽ・ｷ].*$/i.test(t)) return true;
    if (t === 'analyzed' || t.startsWith('analyzed ')) return true;
    if (t === 'thinking' || t === 'generating' || t === 'generating..' || t === 'generating...') return true;
    if (t.startsWith('thought for ')) return true;
    if (t === 'planning' || t === 'fast') return true;
    if (t === 'review changes') return true;
    if (t === 'add context' || t === 'media' || t === 'mentions' || t === 'workflows') return true;
    if (t === 'conversation mode' || t === 'model' || t === 'new' || t === 'send') return true;
    if (/^\d+\s+files?\s+with\s+changes$/i.test(t)) return true;
    if (t === 'git graph') return true;
    if (t === 'antigravity - settings') return true;
    if (t === 'agq') return true;
    if (/^pro\s+\d+%\s+flash\s+\d+%/i.test(t)) return true;
    if (/^(css|html|javascript|typescript|json)$/i.test(t)) return true;
    if (/^(crlf|lf|utf-8|utf8)$/i.test(t)) return true;
    if (/^ln\s+\d+,\s*col\s+\d+$/i.test(t)) return true;
    if (t === 'reject all' || t === 'accept all') return true;
    if (t.includes('ask anything, @ to mention')) return true;
    if (t.startsWith('agent can plan before executing tasks')) return true;
    if (t.startsWith('agent will execute tasks directly')) return true;
    if (t.startsWith('prioritizing specific tools')) return true;
    if (t.startsWith('gemini ') || t.startsWith('claude ') || t.startsWith('gpt-')) return true;
    if (t === 'files edited' || t === 'progress updates' || t === 'continue') return true;
    if (t === 'good' || t === 'bad') return true;
    if (t.startsWith('info: server is started')) return true;
    if (t.startsWith('allow directory access to')) return true;
    if (t.startsWith('allow file access to')) return true;
    if (t.startsWith('allow access to')) return true;

    // Aggressive filters for Diff and Assistant Message UI panels
    if (/^\s*diff\s+summary\s*$/i.test(t)) return true;
    if (/^\s*files\s+changed\s*$/i.test(t)) return true;
    if (/^\s*assistant\s+message\s*$/i.test(t)) return true;
    if (/^\s*\d+\s+file\(s\)\s*$/i.test(t)) return true;
    if (/^\s*reject\s*all\s*accept\s*all\s*$/i.test(t)) return true;
    if (/^\s*\+\d+\s*-\d+\s*$/i.test(t)) return true; // catches like +20-1 or +20 -1
    if (t.endsWith('.js') || t.endsWith('.ts') || t.endsWith('.css') || t.endsWith('.html') || t.endsWith('.md')) {
        if (t === 'discord_bot.js' || t.includes('\\discord_bot.js') || t === 'discord_bot_clean.js') return true;
        if (t === 'task.md' || t.includes('\\task.md')) return true;
    }

    // Antigravity command execution UI chrome
    if (/^ran\s+command$/i.test(t)) return true;
    if (/^always\s+run$/i.test(t)) return true;
    if (/^exit\s+code\s+\d+$/i.test(t)) return true;
    if (/^relocate(\s|$)/i.test(t)) return true;
    if (/^auto-accept:/i.test(t)) return true;
    if (/^情報:\s*auto-accept/i.test(t)) return true;  // 日本語「情報:」プレフィックス
    if (t.startsWith('ps c:\\') || t.startsWith('ps c:/')) return true;  // PowerShellプロンプト
    if (/^…\\/.test(t) || /^…\//.test(t)) return true;  // Antigravityのコマンドパスプレビュー
    if (/^[\w.]+\\[a-z]+ > /.test(t)) return true;  // ターミナルコマンドエコー
    if (/^\^\s*$/.test(t)) return true;  // PowerShellの^
    if (t === 'good 👍' || t === 'bad 👎' || t === 'good' || t === 'bad') return true;

    return false;
}

function containsCjk(text) {
    return /[\u3040-\u30ff\u3400-\u9fff]/.test(String(text || ''));
}

function isProgressNarrationLine(line) {
    const t = String(line || '').trim().toLowerCase();
    if (!t) return false;
    if (/^(planning|developing|constructing|implementing|refining|finalizing|initiating|commencing|crafting|verifying|calculating|styling|building)\b/.test(t)) return true;
    if (/^(i('| a)m|i have|i've|i am|my aim is|i plan to|i'm currently|i'm focusing|i have begun|i just started|now,?\s*i('| a)m)\b/.test(t)) return true;
    if (t.startsWith('creating task and implementation plan')) return true;
    if (t.startsWith('creating index.html')) return true;
    if (t.startsWith('testing the app')) return true;
    return false;
}

function isTerminalNoiseLine(line) {
    const t = String(line || '').trim().toLowerCase();
    if (!t) return true;
    if (isUiChromeLine(t)) return true;
    if (t === 'edited') return true;
    if (/^[+-]\d+$/.test(t)) return true;
    if (/^\d+\s+files?\s+with\s+changes$/i.test(t)) return true;
    if (/^\d+\s+chars[驕ｯ・ｶ繝ｻ・｢繝ｻ繧托ｽｽ・ｷ].*$/i.test(t)) return true;
    if (/^[a-z]:\\.+$/i.test(t)) return true;
    return false;
}

function isFinalSummaryLine(line) {
    const s = String(line || '').trim();
    if (!s) return false;
    if (isStrongFinalSummaryLine(s)) return true;
    if (/(created|completed|directory|files?)/i.test(s)) return true;
    return false;
}

function isStrongFinalSummaryLine(line) {
    const s = String(line || '').trim();
    if (!s) return false;
    if (/(髫ｰ謔ｶ繝ｻ繝ｻ・ｮ陞｢・ｹ繝ｻ繝ｻ・ｹ・ｧ陟募ｨｯ陞ｺ驛｢譎｢・ｽ・ｯ驛｢譎｢・ｽ・ｼ驛｢・ｧ繝ｻ・ｯ驛｢・ｧ繝ｻ・ｹ驛｢譎擾ｽ｣・ｹ郢晢ｽｻ驛｢・ｧ繝ｻ・ｹ|髣比ｼ夲ｽｽ・･髣包ｽｳ闕ｵ譏ｴ繝ｻ驛｢譏ｴ繝ｻ邵ｺ繝ｻ・ｹ譎｢・ｽ・ｬ驛｢・ｧ繝ｻ・ｯ驛｢譎冗樟・主ｿｿ髣比ｼ夲ｽｽ・･髣包ｽｳ闕ｵ譏ｴ繝ｻ3驍ｵ・ｺ繝ｻ・､驍ｵ・ｺ繝ｻ・ｮ驛｢譎・ｽｼ譁撰ｼ憺Δ・ｧ繝ｻ・､驛｢譎｢・ｽ・ｫ|髣厄ｽｴ隲帛現繝ｻ驍ｵ・ｺ陷会ｽｱ遶擾ｽｪ驍ｵ・ｺ陷会ｽｱ隨ｳ繝ｻ髣厄ｽｴ隲帛現繝ｻ驍ｵ・ｺ隰疲ｻゑｽｽ・ｮ陟包ｽ｡繝ｻ・ｺ郢晢ｽｻ髣厄ｽｴ隲帛現繝ｻ驍ｵ・ｺ髴郁ｲｻ・ｽ讙趣ｽｸ・ｺ繝ｻ・ｾ驍ｵ・ｺ陷会ｽｱ隨ｳ繝ｻ髯橸ｽｳ陟包ｽ｡繝ｻ・ｺ郢晢ｽｻ繝ｻ・ｰ驍ｵ・ｺ繝ｻ・ｾ驍ｵ・ｺ陷会ｽｱ隨ｳ繝ｻ驍ｵ・ｺ鬯伜∞・ｽ・ｩ繝ｻ・ｦ驍ｵ・ｺ陷会ｽｱ繝ｻ・･驍ｵ・ｺ繝ｻ・ｰ驍ｵ・ｺ髴郁ｲｻ・ｼ譯埼Δ・ｧ繝ｻ・ｫ驛｢・ｧ繝ｻ・ｹ驛｢・ｧ繝ｻ・ｿ驛｢譎・ｽｧ・ｭ邵ｺ繝ｻ・ｹ・ｧ繝ｻ・ｺ|鬮ｫ・ｱ繝ｻ・ｿ髫ｰ・ｨ繝ｻ・ｴ)/i.test(s)) return true;
    if (/^(the app has been created|i created the following files|created the following files)/i.test(s)) return true;
    return false;
}

function scoreParagraphForFinalSummary(paragraph) {
    const p = String(paragraph || '').trim();
    if (!p) return -1000;
    let score = meaningfulBodyScore(p);
    if (isProgressNarrationLine(p)) score -= 1200;
    if (!containsCjk(p) && /^(planning|developing|constructing|implementing|refining|finalizing|initiating|commencing|crafting|verifying|calculating|styling|building)\b/i.test(p)) score -= 900;
    if (/^(i('| a)m|i have|i've|i am|my aim is|i plan to|i'm currently|i'm focusing)/i.test(p)) score -= 800;
    if (/(index\.html|style\.css|script\.js|\.html|\.css|\.js)/i.test(p)) score += 120;
    if (/(髫ｰ謔ｶ繝ｻ繝ｻ・ｮ陞｢・ｹ繝ｻ繝ｻ・ｹ・ｧ陟募ｨｯ陞ｺ驛｢譎｢・ｽ・ｯ驛｢譎｢・ｽ・ｼ驛｢・ｧ繝ｻ・ｯ驛｢・ｧ繝ｻ・ｹ驛｢譎擾ｽ｣・ｹ郢晢ｽｻ驛｢・ｧ繝ｻ・ｹ|髣比ｼ夲ｽｽ・･髣包ｽｳ闕ｵ譏ｴ繝ｻ驛｢譏ｴ繝ｻ邵ｺ繝ｻ・ｹ譎｢・ｽ・ｬ驛｢・ｧ繝ｻ・ｯ驛｢譎冗樟・主ｿｿ髣比ｼ夲ｽｽ・･髣包ｽｳ闕ｵ譏ｴ繝ｻ3驍ｵ・ｺ繝ｻ・､驍ｵ・ｺ繝ｻ・ｮ驛｢譎・ｽｼ譁撰ｼ憺Δ・ｧ繝ｻ・､驛｢譎｢・ｽ・ｫ|髣厄ｽｴ隲帛現繝ｻ驍ｵ・ｺ陷会ｽｱ遶擾ｽｪ驍ｵ・ｺ陷会ｽｱ隨ｳ繝ｻ髣厄ｽｴ隲帛現繝ｻ驍ｵ・ｺ隰疲ｻゑｽｽ・ｮ陟包ｽ｡繝ｻ・ｺ郢晢ｽｻ髣厄ｽｴ隲帛現繝ｻ驍ｵ・ｺ髴郁ｲｻ・ｽ讙趣ｽｸ・ｺ繝ｻ・ｾ驍ｵ・ｺ陷会ｽｱ隨ｳ繝ｻ髯橸ｽｳ陟包ｽ｡繝ｻ・ｺ郢晢ｽｻ繝ｻ・ｰ驍ｵ・ｺ繝ｻ・ｾ驍ｵ・ｺ陷会ｽｱ隨ｳ繝ｻ驍ｵ・ｺ鬯伜∞・ｽ・ｩ繝ｻ・ｦ驍ｵ・ｺ陷会ｽｱ繝ｻ・･驍ｵ・ｺ繝ｻ・ｰ驍ｵ・ｺ髴郁ｲｻ・ｼ譯皇reated|completed)/i.test(p)) score += 900;
    if (containsCjk(p)) score += 220;
    if (/^(good|bad)$/im.test(p)) score -= 800;
    if (/info:\s*server is started/i.test(p)) score -= 1000;
    return score;
}

function cleanupNoiseLines(text) {
    // Pre-process: Aggressively remove known UI blocks that might span multiple lines
    let preprocessed = String(text || '').replace(/\r/g, '');

    // Remove blocks like "Diff Summary \n 1 file(s) \n Files Changed ... Assistant Message"
    preprocessed = preprocessed.replace(/diff\s+summary[\s\S]*?files\s+changed[\s\S]*?assistant\s+message/ig, '');

    // Remove "Ran command" blocks (includes the command output section)
    preprocessed = preprocessed.replace(/ran\s+command[\s\S]*?(?=exit\s+code\s+\d+)/ig, '');
    preprocessed = preprocessed.replace(/exit\s+code\s+\d+/ig, '');
    preprocessed = preprocessed.replace(/always\s+run\s*\^?/ig, '');

    // Remove file diff lines like "Edited![](/c:/...)antigravity_auto_press_run.js+33-14"
    preprocessed = preprocessed.replace(/(?:Edited\s*)?(?:!\[.*?\]\(.*?\)\s*)?[a-zA-Z0-9_\-.]+\.[a-zA-Z0-9]+\+\d+\s*-\d+/ig, '');

    // Remove "Reject allAccept all" and related buttons
    preprocessed = preprocessed.replace(/reject\s*all\s*accept\s*all/ig, '');

    // Remove Auto-Accept status lines
    preprocessed = preprocessed.replace(/^(情報:|info:)\s*auto-accept[^\n]*/gim, '');
    preprocessed = preprocessed.replace(/^auto-accept:[^\n]*/gim, '');

    const lines = preprocessed.split('\n');
    const out = [];
    for (const raw of lines) {
        const line = String(raw || '').replace(/\s+$/g, '');
        const t = line.trim();
        if (!t) {
            out.push('');
            continue;
        }
        if (isTerminalNoiseLine(t)) continue;
        out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractFinalAssistantSummary(text) {
    const cleaned = cleanupNoiseLines(text);
    if (!cleaned) return '';

    const lines = cleaned.split('\n').map(l => l.trimRight());
    const finalLineIndexes = [];
    const strongFinalLineIndexes = [];
    for (let i = 0; i < lines.length; i++) {
        const t = String(lines[i] || '').trim();
        if (!t) continue;
        if (isFinalSummaryLine(t)) finalLineIndexes.push(i);
        if (isStrongFinalSummaryLine(t)) strongFinalLineIndexes.push(i);
    }
    let pickedFinalIdx = -1;
    if (strongFinalLineIndexes.length > 0) {
        const lastStrong = strongFinalLineIndexes[strongFinalLineIndexes.length - 1];
        const windowStart = Math.max(0, lastStrong - 40);
        const firstStrongNearTail = strongFinalLineIndexes.find(i => i >= windowStart);
        pickedFinalIdx = Number.isInteger(firstStrongNearTail) ? firstStrongNearTail : lastStrong;
    } else if (finalLineIndexes.length > 0) {
        pickedFinalIdx = finalLineIndexes[finalLineIndexes.length - 1];
    }
    if (pickedFinalIdx >= 0) {
        let startIdx = Math.max(0, pickedFinalIdx - 6);
        for (let i = startIdx; i < pickedFinalIdx; i++) {
            const t = String(lines[i] || '').trim();
            if (!t) continue;
            if (isProgressNarrationLine(t)) {
                startIdx = i + 1;
            }
        }
        const tail = lines.slice(startIdx)
            .filter(line => !isProgressNarrationLine(line))
            .filter(line => !isTerminalNoiseLine(line))
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        if (tail) return tail;
    }

    const paragraphs = [];
    let current = [];
    for (const line of lines) {
        if (!line.trim()) {
            if (current.length > 0) {
                paragraphs.push(current.join('\n').trim());
                current = [];
            }
            continue;
        }
        current.push(line);
    }
    if (current.length > 0) paragraphs.push(current.join('\n').trim());
    if (paragraphs.length === 0) return '';

    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < paragraphs.length; i++) {
        const s = scoreParagraphForFinalSummary(paragraphs[i]) + Math.floor(i * 8);
        if (s >= bestScore) {
            bestScore = s;
            bestIdx = i;
        }
    }

    if (bestIdx < 0) return '';
    let start = bestIdx;
    for (let i = bestIdx; i >= Math.max(0, bestIdx - 2); i--) {
        if (isFinalSummaryLine(paragraphs[i])) {
            start = i;
        }
    }

    const selected = [];
    for (let i = start; i < paragraphs.length; i++) {
        const p = paragraphs[i];
        const sc = scoreParagraphForFinalSummary(p);
        if (selected.length > 0 && sc < -150) break;
        if (selected.length > 0 && isProgressNarrationLine(p)) break;
        if (sc < -400) continue;
        selected.push(p);
        if (selected.join('\n\n').length > 3500) break;
    }

    const joined = selected.join('\n\n').trim() || paragraphs[bestIdx];
    return cleanupNoiseLines(joined);
}

function detectPromptFromRawText(rawText) {
    const lines = String(rawText || '')
        .replace(/\r/g, '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
    if (lines.length === 0) return '';

    for (const line of lines.slice(0, 25)) {
        if (isTerminalNoiseLine(line)) continue;
        if (isProgressNarrationLine(line)) continue;
        if (isFinalSummaryLine(line)) continue;
        if (/^[a-z]:\\/.test(line)) continue;
        if (line.length < 8 || line.length > 300) continue;
        if (/\[run:\d+\]/i.test(line)) return line;
        if (/(please|create|build)/i.test(line)) return line;
    }
    return '';
}

function extractStructuredAssistantContent(rawText, promptText = '') {
    let text = String(rawText || '').replace(/\r/g, '');
    const prompt = String(promptText || '').trim();
    if (prompt && text.includes(prompt)) {
        const idx = text.lastIndexOf(prompt);
        if (idx >= 0) text = text.slice(idx + prompt.length);
    }

    const lines = text.split('\n').map(line => line.replace(/\s+$/g, ''));
    const bodyLines = [];
    const changes = [];
    const seenFiles = new Set();
    let filesWithChanges = null;
    let insertions = null;
    let deletions = null;
    let pendingPlus = null;
    let pendingMinus = null;

    const pushChange = (file, add, del) => {
        const normalizedFile = String(file || '').trim();
        if (!normalizedFile) return;
        const key = normalizedFile.toLowerCase();
        if (seenFiles.has(key)) return;
        seenFiles.add(key);
        changes.push({
            file: normalizedFile,
            insertions: Number(add) || 0,
            deletions: Number(del) || 0
        });
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = String(raw || '').trim();
        const lower = line.toLowerCase();
        if (!line) continue;

        const fileCountMatch = line.match(/^(\d+)\s+files?\s+with\s+changes$/i);
        if (fileCountMatch) {
            const count = Number(fileCountMatch[1]);
            filesWithChanges = count > 0 ? count : null;
            continue;
        }

        const bothMatch = line.match(/^(\d+)\s+insertions?\s*\(\+\)\s+(\d+)\s+deletions?\s*\(-\)$/i);
        if (bothMatch) {
            const ins = Number(bothMatch[1]);
            const del = Number(bothMatch[2]);
            insertions = ins > 0 ? ins : null;
            deletions = del > 0 ? del : null;
            continue;
        }
        const insMatch = line.match(/^(\d+)\s+insertions?\s*\(\+\)$/i);
        if (insMatch) {
            const ins = Number(insMatch[1]);
            insertions = ins > 0 ? ins : null;
            continue;
        }
        const delMatch = line.match(/^(\d+)\s+deletions?\s*\(-\)$/i);
        if (delMatch) {
            const del = Number(delMatch[1]);
            deletions = del > 0 ? del : null;
            continue;
        }

        let editedMatch = line.match(/^edited\b.*?([a-z0-9._-]+\.[a-z0-9]+)\s+\+(\d+)\s*-\s*(\d+)$/i);
        if (!editedMatch) {
            editedMatch = line.match(/^([a-z0-9._-]+\.[a-z0-9]+)\s+\+(\d+)\s*-\s*(\d+)$/i);
        }
        if (editedMatch) {
            pushChange(editedMatch[1], editedMatch[2], editedMatch[3]);
            continue;
        }

        if (/^\+\d+$/.test(line)) {
            pendingPlus = Number(line.slice(1));
            continue;
        }
        if (/^-\d+$/.test(line) && pendingPlus !== null) {
            pendingMinus = Number(line.slice(1));
            continue;
        }

        if (pendingPlus !== null && pendingMinus !== null) {
            const nameMatch = line.match(/^([a-z0-9._-]+\.[a-z0-9]+)$/i);
            const pathMatch = line.match(/[\\\/]([a-z0-9._-]+\.[a-z0-9]+)$/i);
            if (nameMatch || pathMatch) {
                const file = nameMatch ? nameMatch[1] : pathMatch[1];
                pushChange(file, pendingPlus, pendingMinus);
                pendingPlus = null;
                pendingMinus = null;
                continue;
            }
        }

        if (lower === 'edited') continue;
        if (isUiChromeLine(line)) continue;
        if (/^[a-z]:\\/.test(line)) continue;

        bodyLines.push(line);
    }

    const bodyText = bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return {
        bodyText,
        changes,
        filesWithChanges,
        insertions,
        deletions
    };
}

function buildChangeSection(structured) {
    const lines = [];
    const hasFileCount = Number.isInteger(structured?.filesWithChanges) && structured.filesWithChanges > 0;
    const hasInsertions = Number.isInteger(structured?.insertions) && structured.insertions > 0;
    const hasDeletions = Number.isInteger(structured?.deletions) && structured.deletions > 0;

    if (hasFileCount || hasInsertions || hasDeletions) {
        const summary = [];
        if (hasFileCount) summary.push(`${structured.filesWithChanges} file(s)`);
        if (hasInsertions) summary.push(`${structured.insertions} insertions (+)`);
        if (hasDeletions) summary.push(`${structured.deletions} deletions (-)`);
        if (summary.length > 0) lines.push(`### Diff Summary\n${summary.join(' / ')}`);
    }

    const nonZeroChanges = Array.isArray(structured?.changes)
        ? structured.changes.filter(ch => (Number(ch?.insertions) > 0 || Number(ch?.deletions) > 0))
        : [];
    if (nonZeroChanges.length > 0) {
        lines.push('### Files Changed');
        for (const ch of nonZeroChanges.slice(0, 30)) {
            lines.push(`- \`${ch.file}\` \`+${ch.insertions} -${ch.deletions}\``);
        }
    }

    return lines.join('\n').trim();
}

function structuredContentScore(structured) {
    if (!structured || typeof structured !== 'object') return 0;
    let score = 0;
    const changes = Array.isArray(structured.changes) ? structured.changes.length : 0;
    score += changes * 100;
    if (Number.isInteger(structured.filesWithChanges)) score += 30;
    if (Number.isInteger(structured.insertions)) score += 10;
    if (Number.isInteger(structured.deletions)) score += 10;
    if (String(structured.bodyText || '').trim()) score += 1;
    return score;
}

function meaningfulBodyScore(text) {
    const src = String(text || '').replace(/\r/g, '');
    if (!src.trim()) return 0;
    const lines = src.split('\n').map(l => l.trim()).filter(Boolean);
    let score = 0;
    for (const line of lines) {
        if (isUiChromeLine(line)) continue;
        if (/^[+-]\d+$/.test(line)) continue;
        if (/^(edited|review changes)$/i.test(line)) continue;
        const len = line.length;
        if (len < 4) continue;
        score += Math.min(len, 120);
        if (/[\p{L}\p{N}]/u.test(line)) score += 10;
    }
    return score;
}

function isLikelyCodeLine(line) {
    const s = String(line || '').trim();
    if (!s) return false;
    if (/^[+-]\d+$/.test(s)) return true;
    if (/[;{}]/.test(s)) return true;
    if (/^\s*<\/?[a-z][^>]*>\s*$/i.test(s)) return true;
    if (/^\s*(const|let|var|function|if|for|while|return|import|export|class)\b/.test(s)) return true;
    if (/^\s*[.#]?[\w-]+\s*:\s*[^:]+;?\s*$/.test(s)) return true;
    if (/^\s*--[\w-]+\s*:\s*.+;\s*$/.test(s)) return true;
    const symbolCount = (s.match(/[{};=<>\[\]()+*]/g) || []).length;
    if (symbolCount >= 5 && symbolCount > Math.floor(s.length * 0.2)) return true;
    return false;
}

function extractNarrativeBody(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const out = [];
    for (const raw of lines) {
        const line = String(raw || '').trim();
        if (!line) {
            out.push('');
            continue;
        }
        if (isUiChromeLine(line)) continue;
        if (/^[+-]\d+$/.test(line)) continue;
        if (/^edited$/i.test(line)) continue;
        if (isLikelyCodeLine(line)) continue;
        out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function selectFinalNarrativeSegment(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/g, ''));
    if (lines.length === 0) return '';
    const nonEmpty = lines.map((l, idx) => ({ line: l.trim(), idx })).filter(x => x.line.length > 0);
    if (nonEmpty.length === 0) return '';

    const answerLike = nonEmpty.filter(x =>
        /[.!?\u3002\uff01\uff1f]$/.test(x.line) ||
        /(created|completed|done|summary|result|files?|directory|implemented|updated)/i.test(x.line)
    );

    const targetIdx = answerLike.length > 0
        ? answerLike[answerLike.length - 1].idx
        : nonEmpty[nonEmpty.length - 1].idx;

    const start = Math.max(0, targetIdx - 30);
    const segment = lines.slice(start).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return segment;
}

function containsWorkbenchChrome(text) {
    const t = String(text || '').toLowerCase();
    if (!t) return false;
    const patterns = [
        'file\nedit\nselection\nview\ngo\nrun\nterminal\nhelp',
        'agent manager\nactive',
        'open agent manager',
        'ask anything, @ to mention, / for workflows',
        'git graph',
        'ln ',
        ' col ',
        '\ncrlf\n',
        '\nutf-8\n'
    ];
    return patterns.some(p => t.includes(p));
}

function isLowConfidenceResponse(response) {
    const raw = String(response?.markdown || response?.text || '');
    const sanitized = sanitizeAssistantMarkdown(raw, '');
    const narrative = extractNarrativeBody(sanitized);
    const narrativeScore = meaningfulBodyScore(narrative);
    const messageRoleCount = Number(response?.messageRoleCount || 0);
    const selector = String(response?.selector || '').toLowerCase();
    const lines = narrative
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);

    // Antigravity固有セレクタにマッチした場合は信頼度が高い（バイパス）
    const highConfidenceSelectors = [
        'antigravity-agent-side-panel',
        'text-ide-message-block-bot-color',
        'bg-ide-chat',
        'agq-chat-message',
        'message.ide'
    ];
    const isHighConfidenceSelector = highConfidenceSelectors.some(s => selector.includes(s));
    if (isHighConfidenceSelector && raw.trim()) return false;

    // CJK文字を含む短い応答（3行以内かつテキストありの場合）は信頼度高と判定
    const hasCjk = /[\u3040-\u30ff\u3400-\u9fff]/.test(raw);
    if (hasCjk && lines.length > 0 && lines.length <= 3) return false;

    const naturalLines = lines.filter(l =>
        /[.!?\u3002\uff01\uff1f]/.test(l) ||
        /[\u3040-\u30ff\u3400-\u9fff]/.test(l) ||
        /\b[a-z]{3,}\s+[a-z]{3,}\b/i.test(l)
    ).length;
    const pathLikeLines = lines.filter(l =>
        /^[a-z]:\\/i.test(l) ||
        l.includes('\\') ||
        /^\/[a-z0-9_./-]+/i.test(l) ||
        /\[[^\]]+\]/.test(l)
    ).length;
    const codeLikeLines = lines.filter(l => isLikelyCodeLine(l)).length;
    const progressLikeLines = lines.filter(l =>
        /^(i('| a)m|planning|developing|constructing|finalizing|analyzing)\b/i.test(l)
    ).length;
    const hasFinalSignal = lines.some(l =>
        /(created|completed|directory|files?|summary|result|implemented|updated)/i.test(l)
    );
    const hasChangeSignal =
        /(^|\n)\s*edited(?:\s+[+-]\d+\s+[+-]\d+)?\s*($|\n)/im.test(raw) ||
        /(^|\n)\s*[+-]\d+\s*($|\n)/m.test(raw) ||
        /\b\d+\s+insertions?\s*\(\+\)/i.test(raw) ||
        /\b\d+\s+deletions?\s*\(-\)/i.test(raw);
    const hasRunMarker = /\[run:\d+\]/i.test(raw);
    const signalBacked = hasChangeSignal || (hasRunMarker && hasFinalSignal);
    const startsWithChrome = lines.length > 0 && (
        /^agent manager$/i.test(lines[0]) ||
        /^file$/i.test(lines[0]) ||
        /^edit$/i.test(lines[0])
    );

    if (!raw.trim()) return true;
    if (startsWithChrome) return true;
    if (lines.length >= 8 && naturalLines < 2) return true;
    if (pathLikeLines >= 3 && naturalLines < 4) return true;
    if (codeLikeLines >= 2 && naturalLines < 5) return true;
    if (progressLikeLines >= 3 && !hasFinalSignal) return true;
    if (containsWorkbenchChrome(raw) && narrativeScore < 300 && !signalBacked) return true;
    if (messageRoleCount === 0 && (selector.includes('body') || selector === 'none') && narrativeScore < 500 && !signalBacked) return true;
    return false;
}

function splitForEmbed(text, limit = 3800) {
    const input = String(text || '').trim();
    if (!input) return [];

    const chunks = [];
    let rest = input;
    while (rest.length > limit) {
        let cut = rest.lastIndexOf('\n\n', limit);
        if (cut < Math.floor(limit * 0.6)) cut = rest.lastIndexOf('\n', limit);
        if (cut < Math.floor(limit * 0.6)) cut = rest.lastIndexOf(' ', limit);
        if (cut < 1) cut = limit;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks;
}

function clipText(text, max = 12000) {
    const s = String(text || '');
    if (s.length <= max) return s;
    return `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]`;
}

function buildRawResponseEnvelope(response, promptText = '', renderedContent = '') {
    const now = new Date().toISOString();
    return {
        capturedAt: now,
        prompt: String(promptText || ''),
        selector: String(response?.selector || ''),
        contextId: Number(response?.contextId || 0),
        messageRoleCount: Number(response?.messageRoleCount || 0),
        text: clipText(response?.text || ''),
        markdown: clipText(response?.markdown || ''),
        renderedContent: clipText(renderedContent || ''),
        images: Array.isArray(response?.images) ? response.images : [],
        domDebug: response?.domDebug || null
    };
}

function writeDomDebugHtmlFiles(payload, outPath) {
    const htmlFiles = [];
    const domDebug = payload?.domDebug && typeof payload.domDebug === 'object'
        ? payload.domDebug
        : null;
    if (!domDebug) return htmlFiles;

    const outDir = path.dirname(outPath);
    const baseName = path.basename(outPath, path.extname(outPath));
    const targets = [
        { key: 'nodeInnerHTML', suffix: 'node_inner.html' },
        { key: 'nodeOuterHTML', suffix: 'node_outer.html' }
    ];

    for (const target of targets) {
        const value = String(domDebug[target.key] || '');
        if (!value.trim()) continue;

        try {
            const htmlPath = path.join(outDir, `${baseName}_${target.suffix}`);
            fs.writeFileSync(htmlPath, value, 'utf8');
            const relPath = path.relative(process.cwd(), htmlPath).replace(/\\/g, '/');
            domDebug[`${target.key}HtmlFile`] = relPath || path.basename(htmlPath);
            domDebug[target.key] = `[saved to ${domDebug[`${target.key}HtmlFile`]}]`;
            htmlFiles.push(htmlPath);
        } catch (e) {
            logInteraction('ERROR', `[RAW_DUMP] ${target.key} html write failed: ${e?.message || String(e)}`);
        }
    }

    return htmlFiles;
}

function writeRawDumpFile(payload) {
    try {
        const outDir = path.join(process.cwd(), 'debug');
        fs.mkdirSync(outDir, { recursive: true });
        const fileName = RAW_DUMP_FILE
            ? path.basename(RAW_DUMP_FILE)
            : `raw_response_${Date.now()}.json`;
        const outPath = RAW_DUMP_FILE
            ? (path.isAbsolute(RAW_DUMP_FILE) ? RAW_DUMP_FILE : path.join(process.cwd(), RAW_DUMP_FILE))
            : path.join(outDir, fileName);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        const htmlFiles = writeDomDebugHtmlFiles(payload, outPath);
        fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
        return { outPath, htmlFiles };
    } catch (e) {
        logInteraction('ERROR', `[RAW_DUMP] write failed: ${e?.message || String(e)}`);
        return { outPath: '', htmlFiles: [] };
    }
}

async function emitRawDump(target, response, promptText = '', renderedContent = '') {
    if (!RAW_DUMP_MODE) return;

    const payload = buildRawResponseEnvelope(response, promptText, renderedContent);
    const { outPath, htmlFiles } = writeRawDumpFile(payload);
    if (!outPath) return;

    const preview = clipText(JSON.stringify({
        prompt: payload.prompt,
        selector: payload.selector,
        messageRoleCount: payload.messageRoleCount,
        domDebug: payload.domDebug
    }, null, 2), 1300);

    logInteraction('ACTION', `[RAW_DUMP] Saved: ${outPath}${htmlFiles.length > 0 ? ` (+${htmlFiles.length} html)` : ''}\n${preview}`);
    logInteraction('ACTION', '[RAW_DUMP] Discord upload removed; kept local files only.');
}

async function safeReplyTarget(target, payload, options = {}) {
    const preferReply = options.preferReply !== false;
    const attempts = [];
    const errors = [];

    if (preferReply && typeof target?.reply === 'function') {
        attempts.push({ name: 'target.reply', fn: () => target.reply(payload) });
    }
    if (typeof target?.followUp === 'function') {
        attempts.push({ name: 'target.followUp', fn: () => target.followUp(payload) });
    }
    if (typeof target?.channel?.send === 'function') {
        attempts.push({ name: 'target.channel.send', fn: () => target.channel.send(payload) });
    }
    if (typeof lastActiveChannel?.send === 'function') {
        attempts.push({ name: 'lastActiveChannel.send', fn: () => lastActiveChannel.send(payload) });
    }

    for (const attempt of attempts) {
        try {
            const result = await attempt.fn();
            return { ok: true, result, method: attempt.name };
        } catch (e) {
            errors.push(`${attempt.name}: ${e?.message || String(e)}`);
        }
    }

    throw new Error(`Reply failed via all methods. ${errors.join(' | ') || 'no method available'}`);
}

async function sendResponseEmbeds(originalMessage, response, promptText = '') {
    if (!response?.text) return false;

    const structuredFromText = extractStructuredAssistantContent(response.text, promptText);
    const structuredFromMarkdown = response.markdown
        ? extractStructuredAssistantContent(response.markdown, promptText)
        : null;
    const structured = structuredContentScore(structuredFromMarkdown) > structuredContentScore(structuredFromText)
        ? structuredFromMarkdown
        : structuredFromText;

    const autoPrompt = String(promptText || '').trim()
        || String(response?.prompt || '').trim()
        || detectPromptFromRawText(response.text || '')
        || detectPromptFromRawText(response.markdown || '');

    const cleanedMarkdown = sanitizeAssistantMarkdown(response.markdown || '', autoPrompt);
    const cleanedText = structured.bodyText || sanitizeAssistantResponse(response.text, autoPrompt);
    const narrativeMarkdown = extractFinalAssistantSummary(selectFinalNarrativeSegment(extractNarrativeBody(cleanedMarkdown)));
    const narrativeText = extractFinalAssistantSummary(selectFinalNarrativeSegment(extractNarrativeBody(cleanedText)));
    const markdownScore = meaningfulBodyScore(cleanedMarkdown);
    const textScore = meaningfulBodyScore(cleanedText);
    const narrativeMarkdownScore = meaningfulBodyScore(narrativeMarkdown);
    const narrativeTextScore = meaningfulBodyScore(narrativeText);

    let cleaned = '';
    if (narrativeMarkdownScore > 0 || narrativeTextScore > 0) {
        cleaned = narrativeMarkdownScore >= narrativeTextScore ? narrativeMarkdown : narrativeText;
    } else {
        cleaned = extractFinalAssistantSummary((markdownScore >= textScore ? cleanedMarkdown : cleanedText) || cleanedMarkdown || cleanedText);
    }
    if (!cleaned) {
        cleaned = extractFinalAssistantSummary(response.markdown || response.text || '');
    }
    cleaned = cleanupNoiseLines(cleaned);
    const changeSection = buildChangeSection(structured);
    const content = changeSection
        ? (cleaned ? `${changeSection}\n\n### Assistant Message\n${cleaned}` : changeSection)
        : (cleaned || String(response.markdown || response.text || '').trim());
    if (!content) return false;

    const preview = content
        .replace(/\r/g, '')
        .split('\n')
        .slice(0, 18)
        .join('\n')
        .slice(0, 1200);
    logInteraction(
        'ACTION',
        `[SEND_PREVIEW] markdownScore=${markdownScore}, textScore=${textScore}, narrativeMarkdownScore=${narrativeMarkdownScore}, narrativeTextScore=${narrativeTextScore}, prompt="${autoPrompt.slice(0, 140)}"\n${preview}`
    );

    await emitRawDump(originalMessage, response, autoPrompt, content);

    try {
        const chunks = splitForEmbed(content, 1900); // chunk for standard message limit

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const isLast = i === chunks.length - 1;

            await safeReplyTarget(
                originalMessage,
                { content: chunk },
                { preferReply: i === 0 } // Only reply to the specific message for the first chunk
            );
        }
        logInteraction('ACTION', `[DISCORD_RESPONSE] Sent ${chunks.length} message chunks to Discord.`);
    } catch (e) {
        logInteraction('ERROR', `[DISCORD_RESPONSE] Failed to send response: ${e?.message || String(e)}`);
        return false;
    }

    return true;
}

function createInteractionReplyBridge(interaction, promptText = '') {
    return {
        content: promptText,
        author: { id: interaction.user?.id || '' },
        followUp: async (payload) => interaction.followUp(payload),
        channel: {
            send: async (payload) => interaction.followUp(payload)
        },
        reply: async (payload) => {
            if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
            return interaction.reply(payload);
        },
        editReply: async (payload) => interaction.editReply(payload)
    };
}

function canSendChannel(channel) {
    return Boolean(channel && typeof channel.send === 'function');
}

async function resolveStartupTestDestination() {
    if (canSendChannel(lastActiveChannel)) {
        const ch = lastActiveChannel;
        return { channel: ch, label: `lastActiveChannel(${ch?.id || 'unknown'})` };
    }

    if (TEST_CHANNEL_ID) {
        try {
            const ch = await client.channels.fetch(TEST_CHANNEL_ID);
            if (canSendChannel(ch)) return { channel: ch, label: `DISCORD_TEST_CHANNEL_ID(${TEST_CHANNEL_ID})` };
            logInteraction('ERROR', `[TEST] DISCORD_TEST_CHANNEL_ID is not sendable: ${TEST_CHANNEL_ID}`);
        } catch (e) {
            logInteraction('ERROR', `[TEST] Failed to fetch DISCORD_TEST_CHANNEL_ID ${TEST_CHANNEL_ID}: ${e?.message || String(e)}`);
        }
    }

    if (ALLOWED_DISCORD_USER_IS_ID) {
        try {
            const user = await client.users.fetch(ALLOWED_DISCORD_USER);
            const dm = await user.createDM();
            if (canSendChannel(dm)) return { channel: dm, label: `DM:${ALLOWED_DISCORD_USER}` };
        } catch (e) {
            logInteraction('ERROR', `[TEST] Failed to open DM for allowed user ${ALLOWED_DISCORD_USER}: ${e?.message || String(e)}`);
        }
    }

    return null;
}

async function runStartupLastResponseTest() {
    logInteraction('ACTION', '[TEST] Startup auto-test: begin latest response extraction');

    const cdp = await ensureCDP();
    if (!cdp) {
        logInteraction('ERROR', '[TEST] CDP not found during startup test.');
        return false;
    }

    const destination = await resolveStartupTestDestination();
    if (!destination?.channel) {
        logInteraction(
            'ERROR',
            '[TEST] No destination channel found. Use --test-channel <channel_id> or set DISCORD_TEST_CHANNEL_ID.'
        );
        return false;
    }

    logInteraction('ACTION', `[TEST] Destination resolved: ${destination.label}`);

    let response = null;
    try {
        response = await getLastResponseAcrossTargets();
    } catch (e) {
        logInteraction('ERROR', `[TEST] getLastResponse failed: ${e?.message || String(e)}`);
        return false;
    }

    if (!response?.text) {
        logInteraction('ERROR', '[TEST] getLastResponse returned empty text.');
        try {
            await destination.channel.send({ content: '[TEST] Failed: latest response could not be extracted from current Antigravity chat.' });
        } catch (e) {
            logInteraction('ERROR', `[TEST] Failed to send extraction-failure message: ${e?.message || String(e)}`);
        }
        return false;
    }
    if (isLowConfidenceResponse(response)) {
        const lowConfidenceMsg = '[TEST] Failed: extracted content looked like IDE chrome, not chat response. Check active Antigravity window/layout.';
        logInteraction('ERROR', `${lowConfidenceMsg} (selector=${response.selector || 'n/a'}, messageRoleCount=${response.messageRoleCount || 0})`);
        try {
            await destination.channel.send({ content: lowConfidenceMsg });
        } catch (e) {
            logInteraction('ERROR', `[TEST] Failed to send low-confidence message: ${e?.message || String(e)}`);
        }
        return false;
    }

    const target = {
        content: '',
        reply: async (payload) => destination.channel.send(payload),
        followUp: async (payload) => destination.channel.send(payload),
        channel: { send: async (payload) => destination.channel.send(payload) }
    };

    const guessedPrompt = String(response?.prompt || '').trim()
        || detectPromptFromRawText(response?.text || '')
        || detectPromptFromRawText(response?.markdown || '');
    try {
        const preamble = guessedPrompt
            ? `[TEST] Extracted latest response from Antigravity. Prompt: ${guessedPrompt.slice(0, 300)}`
            : '[TEST] Extracted latest response from Antigravity.';
        await destination.channel.send({ content: preamble });
    } catch (e) {
        logInteraction('ERROR', `[TEST] Failed to send preamble message: ${e?.message || String(e)}`);
    }

    let sent = false;
    try {
        sent = await sendResponseEmbeds(target, response, guessedPrompt);
    } catch (e) {
        logInteraction('ERROR', `[TEST] sendResponseEmbeds failed: ${e?.message || String(e)}`);
    }

    if (!sent) {
        try {
            await destination.channel.send({ content: '[TEST] Failed: response extracted but local dump handling failed.' });
        } catch (e) {
            logInteraction('ERROR', `[TEST] Failed to send handling-failure message: ${e?.message || String(e)}`);
        }
        return false;
    }

    try {
        await destination.channel.send({ content: '[TEST] OK: latest response extracted and saved locally.' });
    } catch (e) {
        logInteraction('ERROR', `[TEST] Failed to send success message: ${e?.message || String(e)}`);
    }

    logInteraction('SUCCESS', '[TEST] Startup auto-test completed successfully.');
    return true;
}

// --- LOGGING ---
// --- LOGGING ---
const COLORS = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    gray: "\x1b[90m"
};

function setTitle(status) {
    process.stdout.write(String.fromCharCode(27) + "]0;Antigravity Bot: " + status + String.fromCharCode(7));
}

function shouldRelayLogToDiscord(type) {
    return DISCORD_ACTIVITY_LOG_ENABLED && DISCORD_ACTIVITY_LOG_TYPES.has(type);
}

function formatLogForDiscord(type, content) {
    const icons = {
        INJECT: '[IN]',
        NEWCHAT: '[NC]',
        APPROVAL: '[AP]',
        ACTION: '[AC]',
        ERROR: '[ER]',
        STOP: '[ST]',
        SUCCESS: '[OK]',
        UPLOAD: '[UP]',
        UPLOAD_ERROR: '[UE]',
        generating: '[GN]'
    };

    const icon = icons[type] || '[--]';
    const normalized = String(content || '').replace(/\s+/g, ' ').trim();
    const max = 1700;
    const body = normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
    return `${icon} [${type}] ${body}`;
}

async function relayLogToDiscord(type, content) {
    if (!lastActiveChannel) return;
    if (!shouldRelayLogToDiscord(type)) return;

    const message = formatLogForDiscord(type, content);
    const now = Date.now();
    const key = `${type}:${message}`;
    if (lastDiscordActivity.key === key && (now - lastDiscordActivity.at) < 3000) return;
    lastDiscordActivity = { key, at: now };

    try {
        await lastActiveChannel.send({ content: message });
    } catch (e) {
        console.error('[DISCORD_ACTIVITY_LOG_ERROR]', e.message);
    }
}

function logInteraction(type, content) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${type}] ${content}\n`;
    fs.appendFileSync(LOG_FILE, logEntry);

    let color = COLORS.reset;
    let icon = '';

    switch (type) {
        case 'INJECT':
        case 'SUCCESS':
            color = COLORS.green;
            icon = '[OK] ';
            break;
        case 'ERROR':
            color = COLORS.red;
            icon = '[ERR] ';
            break;
        case 'generating':
            color = COLORS.yellow;
            icon = '[GEN] ';
            break;
        case 'CDP':
            color = COLORS.cyan;
            icon = '[CDP] ';
            break;
        default:
            color = COLORS.reset;
    }

    console.log(`${color}[${type}] ${icon}${content}${COLORS.reset}`);

    if (type === 'CDP' && content.includes('Connected')) setTitle('Connected');
    if (type === 'CDP' && content.includes('disconnected')) setTitle('Disconnected');
    if (type === 'generating') setTitle('Generating...');
    if (type === 'SUCCESS' || (type === 'INJECT' && !content.includes('failed'))) setTitle('Connected');
    void relayLogToDiscord(type, content);
}

function downloadFile(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadFile(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

// --- CDP HELPERS ---
function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function discoverCDP() {
    const allTargets = [];
    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            console.log(`[CDP] Checking port ${port}, found ${list.length} targets.`);
            for (const t of list) {
                if (t.type === 'page' && t.webSocketDebuggerUrl) {
                    allTargets.push({ ...t, port });
                }
            }
        } catch (e) {
            console.log(`[CDP] Port ${port} check failed: ${e.message}`);
        }
    }

    if (allTargets.length === 0) throw new Error("CDP not found.");

    // If a target was explicitly selected, try to find it
    if (explicitTargetUrl) {
        const selected = allTargets.find(t => t.webSocketDebuggerUrl === explicitTargetUrl);
        if (selected) {
            console.log(`[CDP] Using explicitly selected target: ${selected.title}`);
            return { port: selected.port, url: selected.webSocketDebuggerUrl };
        }
    }

    // Priorities
    // 1. HIGHEST: Title starts with a real folder name (e.g. "workspace - Antigravity - ...") 
    //    Accept even if "Walkthrough" is in the title - it means a tab in that window, not a pure walkthrough window.
    let target = allTargets.find(t =>
        t.type === 'page' &&
        !t.title.toLowerCase().startsWith('walkthrough') &&   // pure walkthrough window
        !t.title.toLowerCase().startsWith('launchpad') &&     // launchpad window
        !t.url.includes('workbench-jetski-agent') &&
        (t.url.includes('workbench') || t.title.includes('Antigravity') || t.title.includes('Cascade')) &&
        (t.title.toLowerCase().includes('workspace') || t.title.toLowerCase().includes('project'))
    );

    // 2. Any project window that doesn't look like Launchpad or a pure walkthrough
    if (!target) {
        target = allTargets.find(t =>
            t.type === 'page' &&
            !t.title.toLowerCase().startsWith('walkthrough') &&
            !t.title.toLowerCase().startsWith('launchpad') &&
            !t.url.includes('workbench-jetski-agent') &&
            (t.url.includes('workbench') || t.title.includes('Antigravity') || t.title.includes('Cascade'))
        );
    }

    // 3. Fallback to any project-like target (still avoid launchpad)
    if (!target) {
        target = allTargets.find(t =>
            t.type === 'page' &&
            (t.url.includes('workbench') || t.title.includes('Antigravity') || t.title.includes('Cascade')) &&
            !t.url.includes('workbench-jetski-agent')
        );
    }

    if (target) {
        console.log(`[CDP] Connected to target: ${target.title} (${target.url})`);
        return { port: target.port, url: target.webSocketDebuggerUrl };
    }
    throw new Error("Suitable CDP target not found.");
}

async function listAllCDPTargets() {
    const allTargets = [];
    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            for (const t of list) {
                if (t.type === 'page' && t.webSocketDebuggerUrl) {
                    allTargets.push({ ...t, port });
                }
            }
        } catch (e) { }
    }
    return allTargets;
}

async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });
    const contexts = [];
    let idCounter = 1;
    const pending = new Map();

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.id !== undefined && pending.has(data.id)) {
                const { resolve, reject, timeoutId } = pending.get(data.id);
                clearTimeout(timeoutId);
                pending.delete(data.id);
                if (data.error) reject(data.error); else resolve(data.result);
            }
            if (data.method === 'Runtime.executionContextCreated') contexts.push(data.params.context);
            if (data.method === 'Runtime.executionContextDestroyed') {
                const idx = contexts.findIndex(c => c.id === data.params.executionContextId);
                if (idx !== -1) contexts.splice(idx, 1);
            }
        } catch (e) { }
    });

    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        const timeoutId = setTimeout(() => {
            if (pending.has(id)) { pending.delete(id); reject(new Error("Timeout")); }
        }, CDP_CALL_TIMEOUT);
        pending.set(id, { resolve, reject, timeoutId });
        ws.send(JSON.stringify({ id, method, params }));
    });

    ws.on('close', () => {
        logInteraction('CDP', 'WebSocket disconnected.');
        if (cdpConnection && cdpConnection.ws === ws) {
            cdpConnection = null;
        }
    });

    await call("Runtime.enable", {});
    await call("Runtime.disable", {}); // Toggle to force re-emission of events
    await call("Runtime.enable", {});
    await new Promise(r => setTimeout(r, 1000)); // Wait for context events
    console.log(`[CDP] Initialized with ${contexts.length} contexts.`);
    logInteraction('CDP', `Connected to target: ${url}`);
    return { ws, call, contexts };
}

async function ensureCDP() {
    if (cdpConnection && cdpConnection.ws.readyState === WebSocket.OPEN) return cdpConnection;
    try {
        const { url } = await discoverCDP();
        cdpConnection = await connectCDP(url);
        return cdpConnection;
    } catch (e) { return null; }
}

async function getLatestUserPrompt(cdp) {
    const EXP = `(() => {
        function getTargetDocs() {
            const docs = [];
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                if (!String(iframes[i].src || '').includes('cascade-panel')) continue;
                try {
                    if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument);
                } catch (e) {}
            }
            if (docs.length === 0) docs.push(document);
            return docs;
        }

        function isVisible(el) {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        function norm(v) {
            return String(v || '').replace(/\\r/g, '').replace(/[ \\t]+$/gm, '').trim();
        }

        function isNoiseLine(line) {
            const t = String(line || '').trim().toLowerCase();
            if (!t) return true;
            if (t === 'send' || t === 'model' || t === 'new') return true;
            if (t.startsWith('ask anything, @ to mention')) return true;
            if (t.startsWith('allow directory access to') || t.startsWith('allow file access to')) return true;
            if (t.startsWith('thought for ') || t === 'analyzed' || t.startsWith('analyzed ')) return true;
            return false;
        }

        const selectors = [
            '[data-message-role="user"]',
            '[data-testid*="user"]',
            '[class*="user-message"]',
            '[class*="message-user"]'
        ];

        const candidates = [];
        for (const doc of getTargetDocs()) {
            const seen = new Set();
            for (const sel of selectors) {
                for (const node of Array.from(doc.querySelectorAll(sel))) {
                    if (!node || seen.has(node)) continue;
                    seen.add(node);
                    if (!isVisible(node)) continue;
                    const txt = norm(node.innerText || node.textContent);
                    if (!txt || txt.length < 5 || txt.length > 600) continue;
                    if (isNoiseLine(txt)) continue;
                    candidates.push(txt);
                }
            }
        }

        if (candidates.length === 0) {
            const fallback = [];
            for (const doc of getTargetDocs()) {
                const bodyText = norm(doc?.body?.innerText || '');
                if (!bodyText) continue;
                const lines = bodyText.split('\\n').map(s => s.trim()).filter(Boolean);
                for (const line of lines) {
                    if (line.length < 8 || line.length > 300) continue;
                    if (isNoiseLine(line)) continue;
                    if (/(please|create|build|make|髣厄ｽｴ隲帛現繝ｻ驍ｵ・ｺ陷会ｽｱ遯ｶ・ｻ|髣厄ｽｴ隲帛ｲｩ螟｢驍ｵ・ｺ繝ｻ・ｦ|髣厄ｽｴ隲帛現繝ｻ驍ｵ・ｺ陷会ｽｱ遯ｶ・ｻ驍ｵ・ｺ闕ｳ蟯ｩ蜻ｳ驍ｵ・ｺ髴郁ｲｻ・ｼ譯埼蘭・ｴ隲帛ｲｩ螟｢驍ｵ・ｺ繝ｻ・ｦ驍ｵ・ｺ闕ｳ蟯ｩ蜻ｳ驍ｵ・ｺ髴郁ｲｻ・ｼ譯埼蘭・ｴ隲帛現繝ｻ驛｢・ｧ郢晢ｽｻ/i.test(line)) {
                        fallback.push(line);
                    }
                }
            }
            if (fallback.length > 0) return String(fallback[fallback.length - 1] || '');
            return '';
        }
        return String(candidates[candidates.length - 1] || '');
    })()`;

    let best = '';
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call('Runtime.evaluate', { expression: EXP, returnByValue: true, contextId: ctx.id });
            const value = String(res?.result?.value || '').trim();
            if (!value) continue;
            if (value.length >= best.length) best = value;
        } catch (e) { }
    }
    return best;
}

function scoreExtractedResponseCandidate(candidate) {
    const response = candidate?.response || {};
    const markdown = sanitizeAssistantMarkdown(response.markdown || response.text || '', '');
    const plain = sanitizeAssistantResponse(response.text || '', '');
    const narrative = extractNarrativeBody(markdown || plain);
    const responseScore = Math.max(
        meaningfulBodyScore(narrative),
        meaningfulBodyScore(markdown),
        meaningfulBodyScore(plain)
    );

    const title = String(candidate?.target?.title || '').toLowerCase();
    const url = String(candidate?.target?.url || '').toLowerCase();
    let targetScore = 0;
    if (title.startsWith('launchpad') || url.includes('workbench-jetski-agent')) targetScore += 350;
    if (title.includes('workspace') || title.includes('project')) targetScore += 120;

    return responseScore + targetScore;
}

async function getLastResponseAcrossTargets() {
    const targets = await listAllCDPTargets();
    if (!Array.isArray(targets) || targets.length === 0) return null;

    const uniq = [];
    const seen = new Set();
    for (const t of targets) {
        const wsUrl = String(t?.webSocketDebuggerUrl || '');
        if (!wsUrl || seen.has(wsUrl)) continue;
        seen.add(wsUrl);
        uniq.push(t);
    }

    const ordered = uniq.sort((a, b) => {
        const at = String(a?.title || '').toLowerCase();
        const bt = String(b?.title || '').toLowerCase();
        const au = String(a?.url || '').toLowerCase();
        const bu = String(b?.url || '').toLowerCase();
        const as = (at.startsWith('launchpad') || au.includes('workbench-jetski-agent')) ? 1 : 0;
        const bs = (bt.startsWith('launchpad') || bu.includes('workbench-jetski-agent')) ? 1 : 0;
        return bs - as;
    });

    const candidates = [];
    for (const target of ordered) {
        const wsUrl = String(target?.webSocketDebuggerUrl || '');
        if (!wsUrl) continue;
        let temp = null;
        try {
            temp = await connectCDP(wsUrl);
            const response = await getLastResponse(temp);
            if (!response?.text) continue;
            try {
                const prompt = await getLatestUserPrompt(temp);
                if (prompt) response.prompt = prompt;
            } catch (e) { }
            const candidate = { target, response };
            const score = scoreExtractedResponseCandidate(candidate);
            logInteraction('ACTION', `[TARGET_SCAN] title="${target.title}" score=${score}`);
            candidates.push({ ...candidate, score });
        } catch (e) {
            logInteraction('ERROR', `[TARGET_SCAN] failed for "${target?.title || wsUrl}": ${e?.message || String(e)}`);
        } finally {
            try { temp?.ws?.close(); } catch (e) { }
        }
    }

    if (candidates.length === 0) return null;

    const validCandidates = candidates.filter(c => !isLowConfidenceResponse(c.response));

    const launchpad = validCandidates
        .filter(c => {
            const title = String(c?.target?.title || '').toLowerCase();
            const url = String(c?.target?.url || '').toLowerCase();
            return title.startsWith('launchpad') || url.includes('workbench-jetski-agent');
        })
        .sort((a, b) => b.score - a.score);

    if (launchpad.length > 0) {
        logInteraction('ACTION', `[TARGET_SCAN] selecting Launchpad target: "${launchpad[0].target.title}" score=${launchpad[0].score}`);
        return launchpad[0].response || null;
    }

    if (validCandidates.length > 0) {
        const bestValid = validCandidates.sort((a, b) => b.score - a.score)[0];
        return bestValid?.response || null;
    }

    const best = candidates.sort((a, b) => b.score - a.score)[0];
    return best?.response || null;
}

async function ensureWatchDir() {
    if (process.env.WATCH_DIR !== undefined) {
        if (process.env.WATCH_DIR.trim() === '') {
            WORKSPACE_ROOT = null;
            return;
        }
        WORKSPACE_ROOT = process.env.WATCH_DIR;
        if (!fs.existsSync(WORKSPACE_ROOT) || !fs.statSync(WORKSPACE_ROOT).isDirectory()) {
            console.error(`Error: WATCH_DIR '${WORKSPACE_ROOT}' does not exist or is not a directory.`);
            process.exit(1);
        }
        return;
    }

    const rl = readline.createInterface({ input, output });
    console.log('\n--- Watch Directory Setup ---');

    while (true) {
        const answer = await new Promise(resolve => rl.question('Enter watch directory (blank to disable): ', resolve));
        const folderPath = (answer || '').trim();

        if (folderPath === '') {
            console.log('Watching is disabled.');
            WORKSPACE_ROOT = null;
            try {
                fs.appendFileSync('.env', '\nWATCH_DIR=');
            } catch (e) {
                console.warn('Warning: failed to save WATCH_DIR to .env:', e.message);
            }
            break;
        }

        if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
            WORKSPACE_ROOT = folderPath;
            try {
                fs.appendFileSync('.env', `\nWATCH_DIR=${folderPath}`);
                console.log(`Saved WATCH_DIR=${folderPath} to .env`);
            } catch (e) {
                console.warn('Warning: failed to save WATCH_DIR to .env:', e.message);
            }
            break;
        }

        console.log('Invalid path. Please enter an existing directory.');
    }

    rl.close();
}

// --- DOM SCRIPTS ---
async function injectMessage(cdp, text) {
    const safeText = JSON.stringify(text);
    const EXP = `(async () => {
        const SELECTORS = ${JSON.stringify(SELECTORS)};

        function getTargetDocs() {
            const docs = [];
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                if ((iframes[i].src || '').includes('cascade-panel')) {
                    try {
                        if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument);
                    } catch (e) {}
                }
            }
            docs.push(document);
            return docs;
        }

        function isVisible(el) {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            if (el.offsetParent === null && style.position !== 'fixed') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        function isSubmitButton(btn) {
            if (!btn || btn.disabled || !isVisible(btn)) return false;
            const svg = btn.querySelector('svg');
            if (svg) {
                const cls = (svg.getAttribute('class') || '') + ' ' + (btn.getAttribute('class') || '');
                if (SELECTORS.SUBMIT_BUTTON_SVG_CLASSES.some(c => cls.includes(c))) return true;
            }
            const txt = (btn.innerText || btn.getAttribute('aria-label') || '').trim().toLowerCase();
            return ['send', 'run', 'submit'].includes(txt);
        }

        function getSnapshot(doc, editor) {
            return {
                messageCount: doc.querySelectorAll('[data-message-role]').length,
                editorChars: ((editor && editor.innerText) || '').trim().length,
                cancelVisible: Boolean(doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]'))
            };
        }

        async function fillEditor(doc, editor, value) {
            editor.focus();

            // DOMのSelectionではなく、エディタ(Lexical)に全選択を通知するためのキーイベント
            const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
            const eventInit = { bubbles: true, cancelable: true, key: 'a', code: 'KeyA', keyCode: 65, which: 65 };
            if (isMac) eventInit.metaKey = true;
            else eventInit.ctrlKey = true;
            
            editor.dispatchEvent(new KeyboardEvent('keydown', eventInit));

            // エディタのReact状態（選択範囲）が更新されるまで待機
            await new Promise(r => setTimeout(r, 50));

            try {
                // クリップボードからの貼り付けをシミュレート
                // 全選択状態のため、完全に古いテキストを置き換える
                const dataTransfer = new DataTransfer();
                dataTransfer.setData('text/plain', value);
                dataTransfer.setData('text/html', value.replace(/\\n/g, '<br>'));
                
                const pasteEvent = new ClipboardEvent('paste', {
                    clipboardData: dataTransfer,
                    bubbles: true,
                    cancelable: true
                });
                
                editor.dispatchEvent(pasteEvent);
            } catch (e) {
                // フォールバック
                editor.innerText = value;
            }

            // エディタに変更を通知
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            editor.dispatchEvent(new Event('change', { bubbles: true }));
        }

        function pressEnter(editor) {
            const eventInit = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
            editor.dispatchEvent(new KeyboardEvent('keydown', eventInit));
            editor.dispatchEvent(new KeyboardEvent('keypress', eventInit));
            editor.dispatchEvent(new KeyboardEvent('keyup', eventInit));
        }

        async function trySubmit(doc, editor) {
            const before = getSnapshot(doc, editor);
            const buttons = Array.from(doc.querySelectorAll('button, [role="button"]'));
            const submit = buttons.find(isSubmitButton);
            let method = 'enter';

            if (submit) {
                submit.click();
                method = 'click';
            } else {
                pressEnter(editor);
            }

            for (let i = 0; i < 8; i++) {
                await new Promise(r => setTimeout(r, 300));
                const after = getSnapshot(doc, editor);
                const submitted =
                    after.cancelVisible ||
                    after.messageCount > before.messageCount ||
                    (before.editorChars > 0 && after.editorChars === 0);
                if (submitted) return { ok: true, method };
            }

            if (method !== 'enter') {
                pressEnter(editor);
                for (let i = 0; i < 6; i++) {
                    await new Promise(r => setTimeout(r, 300));
                    const after = getSnapshot(doc, editor);
                    const submitted =
                        after.cancelVisible ||
                        after.messageCount > before.messageCount ||
                        (before.editorChars > 0 && after.editorChars === 0);
                    if (submitted) return { ok: true, method: 'enter' };
                }
            }

            return { ok: false, error: 'submit_not_confirmed' };
        }

        const docs = getTargetDocs();
        for (const doc of docs) {
            const editors = Array.from(doc.querySelectorAll(SELECTORS.CHAT_INPUT)).filter(isVisible);
            const editor = editors.at(-1);
            if (!editor) continue;

            await fillEditor(doc, editor, ${safeText});
            await new Promise(r => setTimeout(r, 400));
            const result = await trySubmit(doc, editor);
            if (result.ok) return result;
        }

        return { ok: false, error: 'No editor or submission not confirmed in this context' };
    })()`;

    // Strategy: Prioritize context that looks like cascade-panel
    const targetContexts = cdp.contexts.filter(c =>
        (c.url && c.url.includes(SELECTORS.CONTEXT_URL_KEYWORD)) ||
        (c.name && c.name.includes('Extension')) // Fallback
    );

    // If no specific context found, try all
    const contextsToTry = targetContexts.length > 0 ? targetContexts : cdp.contexts;

    console.log(`Injecting message. Priority contexts: ${targetContexts.length}, Total: ${cdp.contexts.length}`);

    for (const ctx of contextsToTry) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            if (res.result?.value?.ok) {
                logInteraction('INJECT', `Sent: ${text} (${res.result.value.method || 'unknown'} / Context: ${ctx.id})`);
                return res.result.value;
            }
            if (res.result?.value?.error) {
                console.log(`[Injection Fail] Context ${ctx.id}: ${res.result.value.error}`);
            }
        } catch (e) {
            // console.log(`[Injection Error] Context ${ctx.id}: ${e.message}`);
        }
    }

    // Fallback: Try ALL contexts if priority ones failed
    if (targetContexts.length > 0) {
        const otherContexts = cdp.contexts.filter(c => !targetContexts.includes(c));
        for (const ctx of otherContexts) {
            try {
                const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
                if (res.result?.value?.ok) {
                    logInteraction('INJECT', `Sent: ${text} (${res.result.value.method || 'unknown'} / Fallback Context: ${ctx.id})`);
                    return res.result.value;
                }
            } catch (e) { }
        }
    }

    return { ok: false, error: `Injection failed. Tried ${cdp.contexts.length} contexts.` };
}

async function checkIsGenerating(cdp) {
    const EXP = `(() => {
        function findAgentFrame(win) {
             const iframes = document.querySelectorAll('iframe');
             for(let i=0; i<iframes.length; i++) {
                 if(iframes[i].src.includes('cascade-panel')) {
                     try { return iframes[i].contentDocument; } catch(e){}
                 }
             }
             return document;
        }

        const doc = findAgentFrame(window);
        
        const cancel = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) return true;

        return false;
    })()`;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
            if (res.result?.value === true) return true;
        } catch (e) { }
    }
    return false;
}

async function waitForGenerationStart(cdp, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            if (await checkIsGenerating(cdp)) return true;
        } catch (e) { }
        await new Promise(r => setTimeout(r, 400));
    }
    return false;
}

async function checkApprovalRequired(cdp) {
    const EXP = `(async () => {
        // 対象の iframe（cascade-panel 等）またはメインドキュメントを探す
        const docs = [];
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
            if (iframes[i].src.includes('cascade-panel')) {
                try { 
                    if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); 
                } catch(e) {}
            }
        }
        if (docs.length === 0) docs.push(document);

        // キーワード設定
        const TARGET_KEYWORDS = ['run', 'allow once'];
        const EXCLUDE_KEYWORDS = ['always', '常に'];

        for (const doc of docs) {
            const buttons = Array.from(doc.querySelectorAll('button, div[role="button"]'));
            if (buttons.length === 0) continue;

            for (const btn of buttons) {
                // DOM.getOuterHTML の代わりに簡易的に outerHTML を取得
                const html = (btn.outerHTML || '').toLowerCase();

                // HTMLタグを除去してテキストのみを抽出 (改行も含めて抽出してから正規化する)
                let text = html.replace(/<[^>]+>/g, ' ');
                text = text.replace(/&nbsp;/g, ' ').replace(/\\s+/g, ' ').trim();

                let isExcluded = false;
                for (const ex of EXCLUDE_KEYWORDS) {
                    if (text.includes(ex)) {
                        isExcluded = true;
                        break;
                    }
                }
                if (isExcluded) continue;

                let matchedKeyword = null;
                for (const kw of TARGET_KEYWORDS) {
                    const lowerKw = kw.toLowerCase();
                    if (text === lowerKw || text.startsWith(lowerKw + ' ')) {
                        matchedKeyword = kw;
                        break;
                    }
                }

                if (matchedKeyword) {
                    // 非表示ボタンの判定（簡易）
                    if (btn.offsetWidth === 0 || btn.offsetHeight === 0) continue;

                    // 文脈の取得（5階層上まで遡る）
                    let contextText = 'Action requires approval.';
                    let ancestor = btn.parentElement;
                    for (let i = 0; i < 5; i++) {
                        if (!ancestor || !ancestor.parentElement) break;
                        ancestor = ancestor.parentElement;
                    }

                    if (ancestor) {
                        let clean = (ancestor.outerHTML || '').replace(/<[^>]+>/g, ' ');
                        clean = clean.replace(/&nbsp;/g, ' ').replace(/[ \\t]+/g, ' ').replace(/\\n{2,}/g, '\\n').trim();
                        if (clean.length > 500) clean = clean.substring(0, 500) + '...';
                        if (clean) contextText = clean;
                    }

                    return { required: true, message: contextText };
                }
            }
        }
        return null;
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            if (res.result?.value?.required) return res.result.value;
        } catch (e) { }
    }
    return null;
}

async function clickApproval(cdp, allow) {
    const isAllowStr = allow ? 'true' : 'false';
    const EXP = `(async () => {
        const docs = [];
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
            if (iframes[i].src.includes('cascade-panel')) {
                try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e) {}
            }
        }
        if (docs.length === 0) docs.push(document);

        const isAllow = ${isAllowStr};
        const TARGET_KEYWORDS = ['run', 'allow once'];
        const EXCLUDE_KEYWORDS = ['always', '常に'];
        const CANCEL_KEYWORDS = ['cancel', 'reject', 'deny', 'ignore', 'キャンセル', '拒否', '無視', 'いいえ'];
        let log = [];
        let found = false;

        for (const doc of docs) {
            if (found) break;
            const buttons = Array.from(doc.querySelectorAll('button, [role="button"]'));
            if (buttons.length === 0) continue;

            for (const btn of buttons) {
                if (btn.offsetWidth === 0 || btn.offsetHeight === 0) continue;

                const html = (btn.outerHTML || '').toLowerCase();
                let text = html.replace(/<[^>]+>/g, ' ');
                text = text.replace(/&nbsp;/g, ' ').replace(/\\s+/g, ' ').trim();

                if (!isAllow) {
                    let isCancel = false;
                    for (const kw of CANCEL_KEYWORDS) {
                        const lowerKw = kw.toLowerCase();
                        if (text === lowerKw || text.startsWith(lowerKw + ' ')) {
                            isCancel = true;
                            break;
                        }
                    }
                    if (isCancel) {
                        btn.click();
                        log.push("CLICKING REJECT: " + text.substring(0, 30));
                        found = true;
                        break;
                    }
                } else {
                    let isExcluded = false;
                    for (const ex of EXCLUDE_KEYWORDS) {
                        if (text.includes(ex)) {
                            isExcluded = true;
                            break;
                        }
                    }
                    if (isExcluded) continue;

                    let matchedKeyword = null;
                    for (const kw of TARGET_KEYWORDS) {
                        const lowerKw = kw.toLowerCase();
                        if (text === lowerKw || text.startsWith(lowerKw + ' ')) {
                            matchedKeyword = kw;
                            break;
                        }
                    }

                    if (matchedKeyword) {
                        btn.click();
                        log.push("CLICKING APPROVE: " + text.substring(0, 30));
                        found = true;
                        break;
                    }
                }
            }
        }
        return { success: found, log: log };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const evalPromise = cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000));
            const res = await Promise.race([evalPromise, timeoutPromise]);
            if (res.result?.value?.success) {
                logInteraction('CLICK', `Approval / Rejection clicked: ${allow} (success)`);
                return res.result.value;
            }
        } catch (e) { }
    }
    logInteraction('CLICK', `Approval / Rejection clicked: ${allow} (failed)`);
    return { success: false };
}


async function getLastResponse(cdp) {
    // Note: This logic incorporates incremental scroll + pure text extraction (v12 architecture)
    const EXP = `(async () => {
        function getTargetDocs() {
            const docs = [document];
            try {
                const iframes = document.querySelectorAll('iframe');
                for (let i = 0; i < iframes.length; i++) {
                    try {
                        const src = String(iframes[i].src || '');
                        if (src.includes('cascade-panel')) {
                            const d = iframes[i].contentDocument;
                            if (d) docs.push(d);
                        }
                    } catch (e) {}
                }
            } catch (e) {}
            return docs;
        }

        async function processScrollExtraction() {
            const CHAR_LIMIT = 4000;
            const capturedBlocks = new Set();
            const results = [];
            let totalLength = 0;
            
            let isCollectingReply = false;
            let replyBuffer = [];
            let foundLatestUser = false;
            let domDebug = { loops: 0, blocksFiltered: 0, extractedLength: 0 };

            const scrollContainer = document.querySelector('.h-full.overflow-y-auto');
            if (scrollContainer) scrollContainer.scrollTop = 999999;
            await new Promise(r => setTimeout(r, 500));

            for (let step = 0; step < 15; step++) {
                domDebug.loops++;
                const msgContainer = document.querySelector('.relative.flex.flex-col.gap-y-3.px-4');
                if (!msgContainer) break;
                
                const blockResults = [];
                const blocks = Array.from(msgContainer.children);
                
                blocks.forEach(block => {
                    const blockId = (block.innerText || '').substring(0, 100);
                    if (!blockId) return;

                    let userText = "";
                    let cleanAiText = "";

                    // --- 1. User送信テキストの抽出 ---
                    const undoEl = block.querySelector('[data-tooltip-id*="undo"]') || block.querySelector('[title*="Undo"]');
                    if (undoEl) {
                    let userBubble = undoEl.closest('.bg-gray-500\\\\/15') || undoEl.closest('.whitespace-pre-wrap') || undoEl.parentElement;
                        while (userBubble && userBubble.parentElement && userBubble.innerText.length < 10 && userBubble.parentElement !== block) {
                            userBubble = userBubble.parentElement;
                        }
                        userText = userBubble ? userBubble.innerText.trim() : undoEl.parentElement.innerText.trim();
                    }

                    const hasGoodBad = !!block.querySelector('button') && block.innerText.includes('Good') && block.innerText.includes('Bad');

                    // --- 2. ノイズ要素を除外したDOMのクローンを作成 ---
                    const clone = block.cloneNode(true);

                    function replaceWithNewlines(container) {
                        if (!container || !container.parentNode) return;
                        const marker = document.createTextNode('\\n\\n');
                        container.parentNode.replaceChild(marker, container);
                    }

                    Array.from(clone.querySelectorAll('[data-tooltip-id*="undo"], [title*="Undo"]')).forEach(cu => {
                        let cuBubble = cu.closest('.bg-gray-500\\\\/15') || cu.closest('.whitespace-pre-wrap') || cu.parentElement;
                        if (cuBubble && cuBubble.parentNode) replaceWithNewlines(cuBubble);
                    });

                    Array.from(clone.querySelectorAll('*')).forEach(el => {
                        if (!el.parentNode) return;
                        const text = (el.innerText || '').trim();
                        if (!text) return;

                        const isThoughtHeader = /^Thought for/.test(text) && text.length < 30 || text === 'Thought Process';
                        const isLogHeader = ['Ran command', 'Ran background command', 'Ran terminal command', 'Analyzed', 'Running command', 'Always run', 'Exit code', 'Error during'].some(h => text.startsWith(h) && text.length < 30);
                        
                        if (isThoughtHeader) {
                            let container = el.closest('details') || el.closest('.border') || el.closest('.rounded') || el.parentElement;
                            if (container && container.parentNode && container.innerText.includes(text)) {
                                replaceWithNewlines(container);
                                domDebug.blocksFiltered++;
                            }
                        } else if (isLogHeader) {
                            let container = el.closest('.border') || el.closest('.bg-ide-bg') || el.closest('.rounded') || el.parentElement;
                            if (container && container.parentNode && container.innerText.includes(text)) {
                                replaceWithNewlines(container);
                                domDebug.blocksFiltered++;
                            }
                        }
                    });

                    Array.from(clone.querySelectorAll('style')).forEach(s => {
                        if (s.parentNode) s.parentNode.removeChild(s);
                    });

                    Array.from(clone.querySelectorAll('button')).forEach(btn => {
                        const btnText = (btn.innerText || '').trim();
                        if (btnText === 'Good' || btnText === 'Bad') {
                            let wrap = btn.closest('.flex');
                            if (wrap && wrap.parentNode) {
                                wrap.parentNode.removeChild(wrap);
                            } else if (btn.parentNode) {
                                btn.parentNode.removeChild(btn);
                            }
                        }
                    });

                    // --- 3. クリーンなテキストの取得 (Layout保持) ---
                    Object.assign(clone.style, { position: 'absolute', left: '-9999px', top: '0', opacity: '0', pointerEvents: 'none', width: '800px' });
                    document.body.appendChild(clone);
                    const rawText = clone.innerText;
                    document.body.removeChild(clone);

                    cleanAiText = rawText
                        .replace(/\\/\\*\\s*Copied from remark-github-blockquote-alert.*?[\\s\\S]*?padding:\\s*\\.\\drem\\s*1em\\s*\\}/gi, '') 
                        .replace(/Good\\s*Bad$/, '');
                        
                    cleanAiText = cleanAiText.replace(/\\n{3,}/g, '\\n\\n').trim();

                    blockResults.push({
                        id: blockId,
                        user: userText,
                        aiCleaned: cleanAiText,
                        hasGoodBad: hasGoodBad
                    });
                });

                // 下から上にパース
                for (let i = blockResults.length - 1; i >= 0; i--) {
                    const b = blockResults[i];
                    if (capturedBlocks.has(b.id)) continue;
                    capturedBlocks.add(b.id);

                    if (b.aiCleaned && b.hasGoodBad) {
                        results.unshift({ role: 'AI (返答)', content: b.aiCleaned });
                        totalLength += b.aiCleaned.length;
                    } else if (b.aiCleaned) {
                        results.unshift({ role: 'AI', content: b.aiCleaned });
                        totalLength += b.aiCleaned.length;
                    }
                    if (b.user) {
                        results.unshift({ role: 'User', content: b.user });
                        totalLength += b.user.length;
                    }

                    if (!foundLatestUser) {
                        if (b.hasGoodBad) isCollectingReply = true;
                        if (isCollectingReply && b.aiCleaned) replyBuffer.unshift(b.aiCleaned);
                        if (b.user) {
                            foundLatestUser = true;
                            isCollectingReply = false;
                        }
                    }
                    if (totalLength >= CHAR_LIMIT) break;
                }

                if (totalLength >= CHAR_LIMIT || foundLatestUser) break;

                if (scrollContainer) {
                    scrollContainer.scrollTop -= 1000;
                    await new Promise(r => setTimeout(r, 600));
                } else {
                    break;
                }
            }

            if (scrollContainer) scrollContainer.scrollTop = 999999;
            await new Promise(r => setTimeout(r, 200));

            let finalAns = replyBuffer.join('\\n\\n').trim();
            domDebug.extractedLength = finalAns.length;
            
            // Limit to Discord's safe 1900 chars
            if (finalAns.length > 1900) {
                finalAns = finalAns.slice(-1900);
            }

            if (!finalAns) return null;

            return {
                text: finalAns,
                markdown: finalAns,
                images: [],
                score: 250000,
                selector: 'v12-incremental-scroll-pure-extraction',
                messageRoleCount: 1,
                domDebug: domDebug
            };
        }

        // cascade-panelなども順番に試す
        const docs = getTargetDocs();
        const mainRes = await processScrollExtraction();
        if (mainRes) return mainRes;

        return null;
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            // Promise.race timeout for the evaluate call (increased to 30s to allow scrolling)
            const res = await Promise.race([
                cdp.call("Runtime.evaluate", { expression: EXP, awaitPromise: true, returnByValue: true, contextId: ctx.id }),
                new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 30000))
            ]);
            const v = res.result?.value;
            if (!v) continue;
            if (!String(v.text || '').trim()) continue;
            return {
                text: String(v.text).trim(),
                markdown: String(v.markdown || v.text).trim(),
                images: Array.isArray(v.images) ? v.images : [],
                score: Number(v.score || 0),
                selector: v.selector || 'unknown',
                messageRoleCount: Number(v.messageRoleCount || 0),
                domDebug: v.domDebug || null,
                contextId: ctx.id
            };
        } catch (e) {
            logInteraction('ERROR', `getLastResponse context ${ctx.id} failed: ${e.message}`);
        }
    }
    return null;
}

async function getScreenshot(cdp) {
    try {
        const result = await cdp.call("Page.captureScreenshot", { format: "png" });
        return Buffer.from(result.data, 'base64');
    } catch (e) { return null; }
}

async function stopGeneration(cdp) {
    const EXP = `(() => {
                function getTargetDoc() {
                    const iframes = document.querySelectorAll('iframe');
                    for (let i = 0; i < iframes.length; i++) {
                        if (iframes[i].src.includes('cascade-panel')) {
                            try { return iframes[i].contentDocument; } catch (e) { }
                        }
                    }
                    return document;
                }
                const doc = getTargetDoc();
                const cancel = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
                if (cancel && cancel.offsetParent !== null) {
                    cancel.click();
                    return { success: true };
                }
                const buttons = doc.querySelectorAll('button');
                for (const btn of buttons) {
                    const txt = (btn.innerText || '').trim().toLowerCase();
                    btn.click();
                    return { success: true };
                }
            }
        return { success: false, reason: 'Cancel button not found' };
        }) ()`;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
            if (res.result?.value?.success) {
                logInteraction('STOP', 'Generation stopped by user.');
                return true;
            }
        } catch (e) { }
    }
    return false;
}

function summarizeNewChatAttempt(a) {
    const parts = [
        `ctx = ${a.contextId ?? 'n/a'} `,
        `phase = ${a.phase ?? 'n/a'} `,
        `success = ${Boolean(a.success)} `,
        `reason = ${a.reason || 'n/a'} `,
        `doc = ${a.docSource || 'n/a'} `,
        `selector = ${a.method || a.selector || 'n/a'} `
    ];
    if (typeof a.changed === 'boolean') parts.push(`changed = ${a.changed} `);
    if (a.confirmClicked) parts.push(`confirm = "${a.confirmClicked}"`);
    return parts.join(', ');
}

async function startNewChat(cdp) {
    const EXP = `(async () => {
            function getTargetDoc() {
                const iframes = document.querySelectorAll('iframe');
                for (let i = 0; i < iframes.length; i++) {
                    if ((iframes[i].src || '').includes('cascade-panel')) {
                        try { return iframes[i].contentDocument; } catch (e) { }
                    }
                }
                return null;
            }

            function isVisible(el) {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
                if (el.offsetParent === null && style.position !== 'fixed') return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            }

            function getSnapshot(doc) {
                const editorCandidates = Array.from(doc.querySelectorAll('div[role="textbox"]:not(.xterm-helper-textarea)')).filter(isVisible);
                const editor = editorCandidates.at(-1);
                const titles = Array.from(doc.querySelectorAll('p.text-ide-sidebar-title-color')).map(el => (el.innerText || '').trim()).filter(Boolean);
                return {
                    messageCount: doc.querySelectorAll('[data-message-role]').length,
                    activeTitle: titles[0] || null,
                    editorChars: ((editor && editor.innerText) || '').trim().length
                };
            }

            const selectors = [
                '[data-tooltip-id="new-conversation-tooltip"]',
                '[data-tooltip-id*="new-chat"]',
                '[data-tooltip-id*="new_chat"]',
                '[aria-label*="New Chat"]',
                '[aria-label*="New Conversation"]'
            ];

            const docs = [{ source: 'document', doc: document }];
            const iframeDoc = getTargetDoc();
            if (iframeDoc) docs.push({ source: 'cascade_iframe', doc: iframeDoc });

            for (const item of docs) {
                const doc = item.doc;
                for (const sel of selectors) {
                    const btn = doc.querySelector(sel);
                    if (!btn) continue;
                    if (!isVisible(btn) || btn.disabled) {
                        return { success: false, reason: 'button_not_interactable', selector: sel, docSource: item.source };
                    }

                    const before = getSnapshot(doc);
                    const dispatch = (type, Cls) => {
                        try {
                            if (typeof Cls === 'function') {
                                btn.dispatchEvent(new Cls(type, { bubbles: true, cancelable: true, view: window, buttons: 1 }));
                            }
                        } catch (e) { }
                    };

                    dispatch('pointerdown', PointerEvent);
                    dispatch('mousedown', MouseEvent);
                    dispatch('pointerup', PointerEvent);
                    dispatch('mouseup', MouseEvent);
                    dispatch('click', MouseEvent);
                    try { btn.click(); } catch (e) { }
                    await new Promise(r => setTimeout(r, 700));

                    const confirmKeywords = ['start new', 'new chat', 'new conversation', 'discard', 'continue', 'ok', 'yes'];
                    let confirmClicked = null;
                    const modalButtons = Array.from(doc.querySelectorAll('button, [role="button"]')).filter(isVisible);
                    for (const b of modalButtons) {
                        const txt = ((b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase());
                        if (!txt) continue;
                        if (confirmKeywords.some(k => txt.includes(k))) {
                            try {
                                b.click();
                                confirmClicked = txt.slice(0, 80);
                                break;
                            } catch (e) { }
                        }
                    }

                    await new Promise(r => setTimeout(r, 1100));
                    const after = getSnapshot(doc);

                    const changed =
                        before.activeTitle !== after.activeTitle ||
                        (before.messageCount > 0 && after.messageCount === 0) ||
                        (before.editorChars > 0 && after.editorChars === 0);

                    const alreadyFresh = before.messageCount === 0 && before.editorChars === 0;
                    const success = changed || Boolean(confirmClicked) || alreadyFresh;

                    return {
                        success,
                        reason: success ? 'ok' : 'click_no_state_change',
                        method: sel,
                        selector: sel,
                        docSource: item.source,
                        changed,
                        confirmClicked,
                        before,
                        after
                    };
                }
            }

            return { success: false, reason: 'button_not_found' };
        })()`;

    const attempts = [];
    const primary = cdp.contexts.filter(c =>
        (c.url && c.url.includes(SELECTORS.CONTEXT_URL_KEYWORD)) ||
        (c.name && c.name.includes('Extension'))
    );
    const firstPass = primary.length > 0 ? primary : cdp.contexts;
    const secondPass = primary.length > 0 ? cdp.contexts.filter(c => !primary.includes(c)) : [];

    const tryContexts = async (contexts, phase) => {
        for (const ctx of contexts) {
            try {
                const res = await cdp.call('Runtime.evaluate', { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
                const value = res.result?.value || { success: false, reason: 'empty_result' };
                const attempt = {
                    ...value,
                    phase,
                    contextId: ctx.id,
                    contextName: ctx.name || '',
                    contextUrl: ctx.url || ''
                };
                attempts.push(attempt);
                console.log(`[NEWCHAT] ${summarizeNewChatAttempt(attempt)} `);
                if (attempt.success) {
                    logInteraction('NEWCHAT', `Success: ${summarizeNewChatAttempt(attempt)} `);
                    return attempt;
                }
            } catch (e) {
                const attempt = {
                    success: false,
                    reason: `evaluate_error:${e.message} `,
                    phase,
                    contextId: ctx.id,
                    contextName: ctx.name || '',
                    contextUrl: ctx.url || ''
                };
                attempts.push(attempt);
                console.log(`[NEWCHAT] ${summarizeNewChatAttempt(attempt)} `);
            }
        }
        return null;
    };

    const result1 = await tryContexts(firstPass, 'primary');
    if (result1) return result1;
    const result2 = await tryContexts(secondPass, 'fallback');
    if (result2) return result2;

    const tail = attempts.slice(-3).map(summarizeNewChatAttempt).join(' | ');
    logInteraction('NEWCHAT', `Failed after ${attempts.length} attempts.Recent: ${tail} `);
    return {
        success: false,
        reason: attempts[attempts.length - 1]?.reason || 'unknown',
        attempts
    };
}


async function getCurrentModel(cdp) {
    const EXP = `(() => {
            const docs = [document];
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch (e) { }
            }
            for (const doc of docs) {
                const buttons = Array.from(doc.querySelectorAll('button, div[role="button"]'));
                for (const btn of buttons) {
                    const txt = (btn.textContent || '').trim();
                    const lower = txt.toLowerCase();

                    // If the button has aria-expanded, it is highly likely the model selector or mode selector
                    if (btn.hasAttribute('aria-expanded')) {
                        if (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('model')) {
                            return txt;
                        }
                    }

                    // Sometimes it's just a button with text
                    if (txt.length > 3 && txt.length < 50 && (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt'))) {
                        // Make sure it looks like a selected model button (often has an SVG caret next to it)
                        if (btn.querySelector('svg')) {
                            return txt;
                        }
                    }
                }
            }
            return null;
        })()`;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return null;
}

async function getCurrentTitle(cdp) {
    const EXP = `(() => {
            const docs = [document];
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch (e) { }
            }
            for (const doc of docs) {
                const els = doc.querySelectorAll('p.text-ide-sidebar-title-color');
                for (const el of els) {
                    const txt = (el.innerText || '').trim();
                    if (txt.length > 1) return txt;
                }
            }
            return null;
        })()`;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return null;
}

async function getModelList(cdp) {
    const EXP = `(async () => {
            const docs = [document];
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch (e) { }
            }
            let targetDoc = null;
            for (const doc of docs) {
                const buttons = Array.from(doc.querySelectorAll('button, div[role="button"]'));
                for (const btn of buttons) {
                    const txt = (btn.textContent || '').trim();
                    const lower = txt.toLowerCase();
                    if (btn.hasAttribute('aria-expanded')) {
                        if (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('model')) {
                            btn.click();
                            targetDoc = doc;
                            break;
                        }
                    }
                    if (!targetDoc && txt.length > 3 && txt.length < 50 && (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt'))) {
                        if (btn.querySelector('svg')) {
                            btn.click();
                            targetDoc = doc;
                            break;
                        }
                    }
                }
                if (targetDoc) break;
            }
            if (!targetDoc) return JSON.stringify([]);
            await new Promise(r => setTimeout(r, 1000));

            let models = [];
            const options = Array.from(targetDoc.querySelectorAll('div.cursor-pointer'));
            for (const opt of options) {
                if (opt.className.includes('px-') || opt.className.includes('py-')) {
                    const txt = (opt.textContent || '').replace('New', '').trim();
                    if (txt.length > 3 && txt.length < 50 && (txt.toLowerCase().includes('claude') || txt.toLowerCase().includes('gemini') || txt.toLowerCase().includes('gpt') || txt.toLowerCase().includes('o1') || txt.toLowerCase().includes('o3'))) {
                        if (!models.includes(txt)) models.push(txt);
                    }
                }
            }

            const openBtn = targetDoc.querySelector('button[aria-expanded="true"], div[role="button"][aria-expanded="true"]');
            if (openBtn) openBtn.click();

            return JSON.stringify(models);
        })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            if (res.result?.value) {
                const models = JSON.parse(res.result.value);
                if (models.length > 0) return models;
            }
        } catch (e) { }
    }
    return [];
}

async function switchModel(cdp, targetName) {
    const SWITCH_EXP = `(async () => {
            const docs = [document];
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch (e) { }
            }
            let targetDoc = null;
            for (const doc of docs) {
                const buttons = Array.from(doc.querySelectorAll('button, div[role="button"]'));
                for (const btn of buttons) {
                    const txt = (btn.textContent || '').trim();
                    const lower = txt.toLowerCase();
                    if (btn.hasAttribute('aria-expanded')) {
                        if (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('model')) {
                            btn.click();
                            targetDoc = doc;
                            break;
                        }
                    }
                    if (!targetDoc && txt.length > 3 && txt.length < 50 && (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt'))) {
                        if (btn.querySelector('svg')) {
                            btn.click();
                            targetDoc = doc;
                            break;
                        }
                    }
                }
                if (targetDoc) break;
            }
            if (!targetDoc) return JSON.stringify({ success: false, reason: 'button not found' });
            await new Promise(r => setTimeout(r, 1000));

            const target = ${JSON.stringify(targetName)
        }.toLowerCase();
        const options = Array.from(targetDoc.querySelectorAll('div.cursor-pointer'));
        for (const opt of options) {
            if (opt.className.includes('px-') || opt.className.includes('py-')) {
                const txt = (opt.textContent || '').replace('New', '').trim();
                if (txt.toLowerCase().includes(target)) {
                    opt.click();
                    return JSON.stringify({ success: true, model: txt });
                }
            }
        }

        const openBtn = targetDoc.querySelector('button[aria-expanded="true"], div[role="button"][aria-expanded="true"]');
        if (openBtn) openBtn.click();
        return JSON.stringify({ success: false, reason: 'model not found in options list' });
    }) ()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: SWITCH_EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            if (res.result?.value) {
                const result = JSON.parse(res.result.value);
                if (result.success) {
                    logInteraction('MODEL', `Switched to: ${result.model} `);
                    return result;
                }
            }
        } catch (e) { }
    }
    return { success: false, reason: 'CDP error' };
}


async function getCurrentMode(cdp) {
    const EXP = `(() => {
        function getTargetDoc() {
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                if (iframes[i].src.includes('cascade-panel')) {
                    try { return iframes[i].contentDocument; } catch (e) { }
                }
            }
            return document;
        }
        const doc = getTargetDoc();
        const spans = doc.querySelectorAll('span.text-xs.select-none');
        for (const s of spans) {
            const txt = (s.innerText || '').trim();
            if (txt === 'Planning' || txt === 'Fast') return txt;
        }
        return null;
    })()`;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return null;
}

async function switchMode(cdp, targetMode) {
    const SWITCH_EXP = `(async () => {
        function getTargetDoc() {
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                if (iframes[i].src.includes('cascade-panel')) {
                    try { return iframes[i].contentDocument; } catch (e) { }
                }
            }
            return document;
        }
        const doc = getTargetDoc();
        const toggles = doc.querySelectorAll('div[role="button"][aria-haspopup="dialog"]');
        let clicked = false;
        for (const t of toggles) {
            const txt = (t.innerText || '').trim();
            if (txt === 'Planning' || txt === 'Fast') {
                t.querySelector('button').click();
                clicked = true;
                break;
            }
        }
        if (!clicked) return JSON.stringify({ success: false, reason: 'toggle not found' });
        await new Promise(r => setTimeout(r, 1000));
        const target = ${JSON.stringify(targetMode)
        };
    const dialogs = doc.querySelectorAll('div[role="dialog"]');
    for (const dialog of dialogs) {
        const txt = (dialog.innerText || '');
        if (txt.includes('Conversation mode') || txt.includes('Planning') && txt.includes('Fast')) {
            const divs = dialog.querySelectorAll('div.font-medium');
            for (const d of divs) {
                if (d.innerText.trim().toLowerCase() === target.toLowerCase()) {
                    d.click();
                    return JSON.stringify({ success: true, mode: d.innerText.trim() });
                }
            }
        }
    }
    return JSON.stringify({ success: false, reason: 'mode not found in dialog' });
}) ()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: SWITCH_EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            if (res.result?.value) {
                const result = JSON.parse(res.result.value);
                if (result.success) {
                    logInteraction('MODE', `Switched to: ${result.mode} `);
                    return result;
                }
            }
        } catch (e) { }
    }
    return { success: false, reason: 'CDP error' };
}

// --- FILE WATCHER ---
function setupFileWatcher() {
    if (!WORKSPACE_ROOT) {
        console.log('File watching is disabled.');
        return;
    }

    const watcher = chokidar.watch(WORKSPACE_ROOT, {
        ignored: [/node_modules/, /\.git/, /discord_interaction\.log$/],
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: true
    });

    watcher.on('all', async (event, filePath) => {
        if (!lastActiveChannel) return;

        try {
            if (event === 'unlink') {
                await lastActiveChannel.send(`** File Deleted:** \`${path.basename(filePath)}\``);
                return;
            }

            if (event === 'add' || event === 'change') {
                if (!fs.existsSync(filePath)) return;
                const stats = fs.statSync(filePath);
                if (stats.size > 8 * 1024 * 1024) return;

                const attachment = new AttachmentBuilder(filePath);
                const label = event === 'add' ? 'Created' : 'Updated';
                await lastActiveChannel.send({
                    content: `**File ${label}:** \`${path.basename(filePath)}\``,
                    files: [attachment]
                });
            }
        } catch (e) {
            console.error('File watcher send error:', e.message);
        }
    });
}

// --- MONITOR LOOP ---
let lastApprovalMessage = null; // Track the last sent approval text to avoid duplicates

async function monitorAIResponse(originalMessage, cdp) {
    if (isGenerating) return;
    isGenerating = true;
    let stableCount = 0;
    let generationStarted = false;
    lastApprovalMessage = null; // Reset for new command
    logInteraction('ACTION', 'Monitoring AI response.');

    await new Promise(r => setTimeout(r, 3000));

    const startTime = Date.now();
    const MONITOR_TIMEOUT = 30 * 60 * 1000; // 30 minutes

    const poll = async () => {
        try {
            if (Date.now() - startTime > MONITOR_TIMEOUT) {
                logInteraction('ERROR', 'AI response monitoring timed out after 30 minutes.');
                try {
                    await safeReplyTarget(
                        originalMessage,
                        { content: 'AI response monitoring timed out (30 minutes). The generation might still be in progress, but the bot has stopped waiting. Please check the session or retry with `!lr` later.' },
                        { preferReply: true }
                    );
                } catch (replyErr) {
                    logInteraction('ERROR', `Failed to send timeout notification to Discord: ${replyErr?.message || String(replyErr)}`);
                }
                isGenerating = false;
                return;
            }

            const approval = await checkApprovalRequired(cdp);
            if (approval) {
                // If we already sent THIS specific approval message, don't send it again
                if (lastApprovalMessage === approval.message) {
                    setTimeout(poll, POLLING_INTERVAL);
                    return;
                }

                // Wait for 3 seconds to ensure it's not a "flash" button (e.g. auto-accept)
                await new Promise(r => setTimeout(r, 3000));

                // Re-verify after delay
                const stillRequiresApproval = await checkApprovalRequired(cdp);
                if (!stillRequiresApproval) {
                    console.log("Approval button disappeared during grace period. Skipping Discord notification.");
                    setTimeout(poll, POLLING_INTERVAL);
                    return;
                }

                if (autoApproveMode) {
                    // Try auto-approve first so Discord test flow does not stall on modal prompts.
                    const autoApprovalResult = await clickApproval(cdp, true);
                    if (autoApprovalResult?.success) {
                        logInteraction('APPROVAL', `Auto-approved request: ${approval.message.substring(0, 50)}...`);
                        lastApprovalMessage = null;
                        setTimeout(poll, POLLING_INTERVAL);
                        return;
                    }
                }

                // Double check it's STILL the same message after the delay protection
                if (lastApprovalMessage === approval.message) {
                    setTimeout(poll, POLLING_INTERVAL);
                    return;
                }

                lastApprovalMessage = approval.message;

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('approve_action')
                        .setLabel('Approve')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('reject_action')
                        .setLabel('Reject')
                        .setStyle(ButtonStyle.Danger)
                );
                logInteraction('APPROVAL', `Request sent to Discord: ${approval.message.substring(0, 50)}...`);

                const reply = await originalMessage.reply({
                    content: `**Action Required:**\n${approval.message}`,
                    components: [row]
                });

                try {
                    const interaction = await reply.awaitMessageComponent({ filter: i => i.user.id === (originalMessage.author?.id || originalMessage.user?.id), time: 60000 });
                    const allow = interaction.customId === 'approve_action';
                    await interaction.deferUpdate();
                    const clickResult = await clickApproval(cdp, allow);
                    logInteraction('ACTION', `User ${allow ? 'Approved' : 'Rejected'} the request.`);

                    // Edit reply to show outcome
                    await reply.editReply({
                        content: `**Action ${allow ? 'Approved' : 'Rejected'}:**\n${approval.message}`,
                        components: []
                    });

                    // Wait for the button to disappear before resuming
                    for (let j = 0; j < 15; j++) {
                        if (!(await checkApprovalRequired(cdp))) break;
                        await new Promise(r => setTimeout(r, 500));
                    }

                    // Reset tracking and continue monitoring if AI is still replying or has more steps
                    lastApprovalMessage = null;
                    setTimeout(poll, POLLING_INTERVAL);
                } catch (e) {
                    console.error('[INTERACTION_ERROR]', e.message, e.stack);
                    lastApprovalMessage = null;
                    // Clean up components on timeout
                    try { await reply.edit({ components: [] }); } catch (err) { }
                    setTimeout(poll, POLLING_INTERVAL);
                }
                return;
            }

            const generating = await checkIsGenerating(cdp);
            if (generating && !generationStarted) {
                generationStarted = true;
                logInteraction('generating', 'AI response generation started.');
            }
            if (!generating) {
                stableCount++;
                if (stableCount >= 3) {
                    isGenerating = false;
                    logInteraction('SUCCESS', 'AI response generation completed.');
                    let response = null;
                    try {
                        response = await getLastResponse(cdp);
                    } catch (e) {
                        logInteraction('ERROR', `getLastResponse failed: ${e?.message || String(e)}`);
                    }
                    if (!response?.text) {
                        const debugStr = response?.domDebug ? JSON.stringify(response.domDebug) : 'no domDebug';
                        logInteraction('ERROR', `AI response generation completed, but extraction returned empty text. domDebug: ${debugStr}`);
                        try {
                            await safeReplyTarget(
                                originalMessage,
                                { content: 'AI response generation completed, but extracting the final response failed. Please retry.' },
                                { preferReply: true }
                            );
                        } catch (replyErr) {
                            logInteraction('ERROR', `Failed to send extraction error to Discord: ${replyErr?.message || String(replyErr)}`);
                        }
                        return;
                    }
                    if (isLowConfidenceResponse(response)) {
                        logInteraction('ERROR', `Low-confidence extraction in monitor flow (selector=${response.selector || 'n/a'}, messageRoleCount=${response.messageRoleCount || 0}).`);
                        try {
                            await safeReplyTarget(
                                originalMessage,
                                { content: 'AI response completed, but extraction looked like IDE chrome content. Please use `/last_response` after focusing the chat window.' },
                                { preferReply: true }
                            );
                        } catch (replyErr) {
                            logInteraction('ERROR', `Failed to send low-confidence warning to Discord: ${replyErr?.message || String(replyErr)}`);
                        }
                        return;
                    }

                    logInteraction(
                        'ACTION',
                        `Extracted AI response (${response.text.length} chars, markdown=${String(response.markdown || '').length} chars, selector=${response.selector || 'n/a'}, ctx=${response.contextId ?? 'n/a'})`
                    );

                    let sent = false;
                    try {
                        sent = await sendResponseEmbeds(originalMessage, response, originalMessage.content || '');
                    } catch (sendErr) {
                        logInteraction('ERROR', `sendResponseEmbeds failed: ${sendErr?.message || String(sendErr)}`);
                    }
                    if (!sent) {
                        logInteraction('ERROR', 'AI response was extracted, but local dump handling failed.');
                        try {
                            await safeReplyTarget(
                                originalMessage,
                                { content: 'AI response was extracted, but local dump handling failed.' },
                                { preferReply: true }
                            );
                        } catch (fallbackErr) {
                            logInteraction('ERROR', `Fallback failure message send failed: ${fallbackErr?.message || String(fallbackErr)}`);
                        }
                    }
                    return;
                }
            } else {
                stableCount = 0;
            }

            setTimeout(poll, POLLING_INTERVAL);
        } catch (e) {
            console.error("Poll error:", e);
            logInteraction('ERROR', `Poll error: ${e?.stack || e?.message || String(e)}`);
            isGenerating = false;
        }
    };

    setTimeout(poll, POLLING_INTERVAL);
}

// --- SLASH COMMANDS DEFINITION ---
const commands = [
    {
        name: 'screenshot',
        description: 'Capture screenshot from Antigravity',
    },
    {
        name: 'stop',
        description: 'Stop generation',
    },
    {
        name: 'newchat',
        description: 'Start a new chat',
        options: [
            {
                name: 'prompt',
                description: 'Prompt to send after creating a new chat',
                type: 3,
                required: false,
            }
        ]
    },
    {
        name: 'title',
        description: 'Show current chat title',
    },

    {
        name: 'last_response',
        description: 'Extract latest response and save local raw dump',
    },
    {
        name: 'model',
        description: 'List models or switch model',
        options: [
            {
                name: 'number',
                description: 'Model number to switch',
                type: 4,
                required: false,
            }
        ]
    },
    {
        name: 'mode',
        description: 'Show or switch mode (planning/fast)',
        options: [
            {
                name: 'target',
                description: 'Target mode (planning or fast)',
                type: 3,
                required: false,
                choices: [
                    { name: 'Planning', value: 'planning' },
                    { name: 'Fast', value: 'fast' }
                ]
            }
        ]
    },
    {
        name: 'auto',
        description: 'Enable or disable auto-approval mode',
        options: [
            {
                name: 'target',
                description: 'Target state (on or off)',
                type: 3,
                required: false,
                choices: [
                    { name: 'On', value: 'on' },
                    { name: 'Off', value: 'off' }
                ]
            }
        ]
    },
    {
        name: 'status',
        description: 'Check current mode and auto-approval status',
    },
    {
        name: 'help',
        description: 'Show available commands and usage instructions',
    },
    {
        name: 'list_windows',
        description: 'List available Antigravity windows',
    },
    {
        name: 'select_window',
        description: 'Select active window by number',
        options: [
            {
                name: 'number',
                description: 'Window number',
                type: 4,
                required: true,
            }
        ]
    }
];

// --- DISCORD EVENTS ---
client.on('error', error => {
    console.error('Discord client error:', error);
});

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    setupFileWatcher();

    const startupCdp = await ensureCDP();
    if (startupCdp) console.log('Auto-connected to Antigravity on startup.');
    else console.log('Could not auto-connect to Antigravity on startup.');

    try {
        console.log('Started refreshing application (/) commands.');
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Failed to reload application commands:', error);
    }

    if (RUN_STARTUP_TEST) {
        console.log('[TEST] Startup test mode enabled (--test).');
        if (!TEST_CHANNEL_ID && !ALLOWED_DISCORD_USER_IS_ID && !canSendChannel(lastActiveChannel)) {
            console.error('[TEST] Destination is not configured. Provide --test-channel <channel_id> (recommended).');
            if (EXIT_AFTER_STARTUP_TEST) {
                setTimeout(() => process.exit(1), 500);
            }
            return;
        }
        const ok = await runStartupLastResponseTest();
        if (EXIT_AFTER_STARTUP_TEST) {
            const exitCode = ok ? 0 : 1;
            console.log(`[TEST] Completed. Exiting with code ${exitCode}.`);
            setTimeout(() => process.exit(exitCode), 800);
        } else {
            console.log('[TEST] Completed. Keeping bot alive because --test-keepalive is enabled.');
        }
    }
});
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (!isAuthorizedDiscordUser(interaction.user)) {
        logInteraction('SECURITY', `Unauthorized access attempt from UserID: ${interaction.user.id} (${interaction.user.username})`);
        if (!interaction.replied && !interaction.deferred) {
            try {
                await interaction.reply({ content: 'Unauthorized.', flags: MessageFlags.Ephemeral });
            } catch (e) {
                if (e?.code !== 10062) {
                    console.error('Failed to send unauthorized reply:', e);
                }
            }
        }
        return;
    }

    try {
        lastActiveChannel = interaction.channel;
        const { commandName } = interaction;

        await interaction.deferReply();

        if (commandName === 'list_windows') {
            const targets = await listAllCDPTargets();
            if (targets.length === 0) {
                await interaction.editReply('No available windows found.');
                return;
            }

            const selected = explicitTargetUrl;
            const list = targets.map((t, i) => {
                const isSelected = selected === t.webSocketDebuggerUrl;
                return `${isSelected ? '>' : ' '} ${i + 1}. ${t.title} (port ${t.port})`;
            }).join('\n');

            await interaction.editReply(`Available windows:\n\n${list}\n\nUse /select_window number:<n> to select one.`);
            return;
        }

        if (commandName === 'select_window') {
            const num = interaction.options.getInteger('number');
            const targets = await listAllCDPTargets();

            if (num < 1 || num > targets.length) {
                await interaction.editReply(`Number must be between 1 and ${targets.length}.`);
                return;
            }

            const target = targets[num - 1];
            explicitTargetUrl = target.webSocketDebuggerUrl;

            if (cdpConnection) {
                cdpConnection.ws.close();
                cdpConnection = null;
            }

            const newCdp = await ensureCDP();
            if (newCdp) {
                await interaction.editReply(`Selected window: ${target.title}`);
                return;
            }
            await interaction.editReply(`Failed to connect to: ${target.title}`);
            return;
        }

        const cdp = await ensureCDP();
        if (!cdp) {
            await interaction.editReply('CDP not found. Is Antigravity running?');
            return;
        }

        if (commandName === 'screenshot') {
            const ss = await getScreenshot(cdp);
            if (ss) {
                await interaction.editReply({ files: [new AttachmentBuilder(ss, { name: 'ss.png' })] });
            } else {
                await interaction.editReply('Failed to capture screenshot.');
            }
            return;
        }

        if (commandName === 'stop') {
            const stopped = await stopGeneration(cdp);
            if (stopped) {
                isGenerating = false;
                await interaction.editReply('Generation stopped.');
            } else {
                await interaction.editReply('No active generation.');
            }
            return;
        }

        if (commandName === 'newchat') {
            const prompt = interaction.options.getString('prompt');
            const result = await startNewChat(cdp);
            if (!result.success) {
                const reason = result.reason || 'unknown';
                await interaction.editReply(`New chat did not complete. reason=${reason} (see discord_interaction.log)`);
                return;
            }

            isGenerating = false;
            await new Promise(r => setTimeout(r, 3000));

            if (prompt && prompt.trim()) {
                const promptText = prompt.trim();
                logInteraction('NEWCHAT', `Prompt provided (${promptText.length} chars). Sending after new chat.`);
                let injected = await injectMessage(cdp, promptText);
                let started = injected.ok ? await waitForGenerationStart(cdp, 9000) : false;

                if (!started) {
                    logInteraction('NEWCHAT', 'No generation detected after first send. Retrying once...');
                    await new Promise(r => setTimeout(r, 1000));
                    injected = await injectMessage(cdp, promptText);
                    started = injected.ok ? await waitForGenerationStart(cdp, 9000) : false;
                }

                if (injected.ok && started) {
                    await interaction.editReply(`New chat started and prompt was sent (${injected.method}).`);
                    logInteraction('ACTION', 'Start monitor for /newchat prompt flow.');
                    void monitorAIResponse(createInteractionReplyBridge(interaction, promptText), cdp);
                } else if (injected.ok && !started) {
                    logInteraction('ERROR', 'Prompt was injected, but generation did not start.');
                    await interaction.editReply('Prompt was injected, but generation did not start. Check the Antigravity input box and press Enter once.');
                } else {
                    logInteraction('ERROR', `Prompt send failed after new chat: ${injected.error || 'unknown'}`);
                    await interaction.editReply(`New chat started, but prompt send failed: ${injected.error || 'unknown'}`);
                }
            } else {
                logInteraction('NEWCHAT', 'No prompt provided. New chat only.');
                await interaction.editReply('New chat request completed.');
            }
            return;
        }

        if (commandName === 'title') {
            const title = await getCurrentTitle(cdp);
            await interaction.editReply(`Current chat title: ${title || 'unknown'}`);
            return;
        }



        if (commandName === 'last_response') {
            await interaction.editReply('Extracting latest response from current Antigravity chat...');
            let response = null;
            try {
                response = await getLastResponseAcrossTargets();
            } catch (e) {
                logInteraction('ERROR', `last_response extraction failed: ${e?.message || String(e)}`);
            }

            if (!response?.text) {
                await interaction.editReply('No response could be extracted from the current chat history.');
                return;
            }
            if (isLowConfidenceResponse(response)) {
                await interaction.editReply('Extraction failed: detected IDE chrome content instead of chat history. Check active Antigravity window.');
                return;
            }

            let sent = false;
            try {
                sent = await sendResponseEmbeds(createInteractionReplyBridge(interaction, ''), response, '');
            } catch (e) {
                logInteraction('ERROR', `last_response sendResponseEmbeds failed: ${e?.message || String(e)}`);
            }

            if (sent) {
                await interaction.editReply('Latest response extracted and saved locally.');
            } else {
                await interaction.editReply('Response extraction succeeded, but local dump handling failed.');
            }
            return;
        }

        if (commandName === 'model') {
            const num = interaction.options.getInteger('number');

            if (num === null) {
                const current = await getCurrentModel(cdp);
                const models = await getModelList(cdp);
                if (models.length === 0) {
                    await interaction.editReply('Could not read model list.');
                    return;
                }
                const list = models.map((m, i) => `${m === current ? '>' : ' '} ${i + 1}. ${m}`).join('\n');
                await interaction.editReply(`Current model: ${current || 'unknown'}\n\n${list}\n\nUse /model number:<n> to switch.`);
                return;
            }

            if (num < 1) {
                await interaction.editReply('Number must be >= 1.');
                return;
            }
            const models = await getModelList(cdp);
            if (num > models.length) {
                await interaction.editReply(`Number must be between 1 and ${models.length}.`);
                return;
            }
            const result = await switchModel(cdp, models[num - 1]);
            if (result.success) {
                await interaction.editReply(`Switched model to ${result.model}.`);
            } else {
                await interaction.editReply(`Failed to switch model: ${result.reason}`);
            }
            return;
        }

        if (commandName === 'mode') {
            const target = interaction.options.getString('target');

            if (!target) {
                const mode = await getCurrentMode(cdp);
                await interaction.editReply(`Current mode: ${mode || 'unknown'}\n\nUse /mode target:<planning|fast> to switch.`);
                return;
            }

            const result = await switchMode(cdp, target);
            if (result.success) {
                await interaction.editReply(`Switched mode to ${result.mode}.`);
            } else {
                await interaction.editReply(`Failed to switch mode: ${result.reason}`);
            }
            return;
        }

        if (commandName === 'auto') {
            const target = interaction.options.getString('target');

            if (!target) {
                await interaction.editReply(`Auto-approval mode is currently **${autoApproveMode ? 'ON' : 'OFF'}**.`);
                return;
            }

            autoApproveMode = (target === 'on');
            await interaction.editReply(`Auto-approval mode has been turned **${autoApproveMode ? 'ON' : 'OFF'}**.`);
            return;
        }

        if (commandName === 'status') {
            const mode = await getCurrentMode(cdp);
            const modeStr = mode || 'unknown';
            const autoStr = autoApproveMode ? 'ON' : 'OFF';
            await interaction.editReply(`**Antigravity Status**\n- Mode: \`${modeStr}\`\n- Auto-approval: \`${autoStr}\``);
            return;
        }

        if (commandName === 'help') {
            const helpText = `
**Antigravity Discord Bot Commands**

**/status**
Check the current Antigravity mode (planning/fast) and whether auto-approval is ON or OFF.

**/auto [target]**
Manage auto-approval mode for \`Run\` and \`Allow Once\` actions.
- \`/auto\` (no target): Shows current ON/OFF state.
- \`/auto target:On\`: Enables auto-approval.
- \`/auto target:Off\`: Disables auto-approval.

**/model [num]**
Switch the AI model (e.g., GPT-4, Claude 3).
- \`/model\`: Lists available models.
- \`/model num:1\`: Selects model #1 from the list.

**/mode [target]**
Switch the agent's operating mode.
- \`/mode\` (no target): Shows current mode.
- \`/mode target:planning\`: Switches to Planning mode (waits for approval).
- \`/mode target:fast\`: Switches to Fast mode (acts immediately).

**/list_windows** & **/select_window [number]**
Manage which VSCode/IDE window to connect to via CDP.
`;
            await interaction.editReply(helpText.trim());
            return;
        }
    } catch (error) {
        console.error('Interaction Error:', error);
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: `Error: ${error.message}` });
            } else {
                await interaction.reply({ content: `Error: ${error.message}`, flags: MessageFlags.Ephemeral });
            }
        } catch (innerError) {
            console.error('Failed to send error reply:', innerError);
        }
    }
});
client.on('messageCreate', async message => {
    if (!isAuthorizedDiscordUser(message.author)) return;
    if (message.author.bot) return;

    // Ignore old slash commands that people might manually type
    if (message.content.startsWith('/')) return;
    lastActiveChannel = message.channel;
    let messageText = message.content || '';

    const messageCommand = String(messageText || '').trim().toLowerCase();



    if (messageCommand === '!last_response' || messageCommand === '!lastresponse' || messageCommand === '!lr') {
        const cdp = await ensureCDP();
        if (!cdp) {
            await message.reply('CDP not found. Is Antigravity running?');
            return;
        }

        let response = null;
        try {
            response = await getLastResponseAcrossTargets();
        } catch (e) {
            logInteraction('ERROR', `message last_response extraction failed: ${e?.message || String(e)}`);
        }

        if (!response?.text) {
            await message.reply('No response could be extracted from current chat history.');
            return;
        }
        if (isLowConfidenceResponse(response)) {
            await message.reply('Extraction failed: detected IDE chrome content instead of chat history. Check active Antigravity window.');
            return;
        }

        let sent = false;
        try {
            sent = await sendResponseEmbeds(message, response, '');
        } catch (e) {
            logInteraction('ERROR', `message last_response sendResponseEmbeds failed: ${e?.message || String(e)}`);
        }
        if (!sent) {
            await message.reply('Response extraction succeeded, but local dump handling failed.');
        }
        return;
    }

    if (message.attachments.size > 0) {
        const uploadDir = path.join(WORKSPACE_ROOT, 'discord_uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

        const downloadedFiles = [];
        for (const [, attachment] of message.attachments) {
            try {
                const fileName = `${Date.now()}_${path.basename(attachment.name)}`;
                const filePath = path.join(uploadDir, fileName);
                const fileData = await downloadFile(attachment.url);
                fs.writeFileSync(filePath, fileData);
                downloadedFiles.push({ name: attachment.name, path: filePath });
                logInteraction('UPLOAD', `Downloaded: ${attachment.name} -> ${filePath}`);
            } catch (e) {
                logInteraction('UPLOAD_ERROR', `Failed to download ${attachment.name}: ${e.message}`);
            }
        }

        if (downloadedFiles.length > 0) {
            const fileInfo = downloadedFiles.map(f => `[attachment: ${f.name}] saved at ${f.path}`).join('\n');
            messageText = messageText ? `${messageText}\n\n${fileInfo}` : fileInfo;
            // attachment received
        }
    }


    if (!messageText) return;
    const cdp = await ensureCDP();
    if (!cdp) return;

    const res = await injectMessage(cdp, messageText);
    if (res.ok) {
        // message accepted
        try {
            await message.react('✅');
        } catch (e) {
            console.error('Failed to react to message:', e);
        }
        monitorAIResponse(message, cdp);
    } else {
        // message rejected
        if (res.error) message.reply(`Error: ${res.error}`);
    }
});

// Main Execution
(async () => {
    try {
        if (!ALLOWED_DISCORD_USER) {
            throw new Error('DISCORD_ALLOWED_USER_ID is missing in .env');
        }
        if (!ALLOWED_DISCORD_USER_IS_ID) {
            console.warn('[CONFIG] DISCORD_ALLOWED_USER_ID is not numeric. Username fallback is active; Discord user ID is recommended.');
        }
        await ensureWatchDir();
        console.log(`Watching directory: ${WORKSPACE_ROOT || '(disabled)'}`);
        if (RUN_STARTUP_TEST) {
            console.log('[TEST] --test detected. Startup auto-test will run after login.');
            if (TEST_CHANNEL_ID) {
                console.log(`[TEST] Using DISCORD_TEST_CHANNEL_ID=${TEST_CHANNEL_ID}`);
            } else {
                console.log('[TEST] No test channel configured. Set --test-channel <channel_id> or DISCORD_TEST_CHANNEL_ID.');
            }
        }
        client.login(process.env.DISCORD_BOT_TOKEN);
    } catch (e) {
        console.error('Fatal Error:', e);
        process.exit(1);
    }
})();

