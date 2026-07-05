//@C:M ID=M.CM.CliMenuManager;K=M;V=1.5;P=module;D=CLI;M=cli;S=main
import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import SelectInput from 'ink-select-input';
import ProviderPanel from '../cli/ProviderPanel.tsx';
import { LogoV2 } from '../components/LogoV2/LogoV2.tsx';
import { CondensedLogo } from '../components/LogoV2/CondensedLogo.tsx';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ensureSingletonLocalServer } from '../server/ensureSingletonLocalServer.ts';
// New: Common UI elements and top toolbar
import { TopBar, BottomBar, Panel, Hint, Kbd, SecondaryMenu, StateDisplay, ScrollBar, truncate, safePadEnd } from '../manager/CliMenuUi.tsx';
import { WelcomeV2 } from '../components/LogoV2/WelcomeV2.tsx';
import { TopToolbar } from '../manager/TopToolbar.tsx';

// Theme switching (Hook)
import { useTheme } from '../components/design-system/ThemeProvider.js';
// Markdown rendering (Pure function, no AppStateProvider context dependency)
import { applyMarkdown } from '../utils/markdown.js';
import { Ansi } from '../ink/Ansi.js';

// Config related (using available interfaces)
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.ts';
import { writeJsonAtomic } from '../utils/json.js';

// markedSessions stored in ~/.claude-cli/ fixed directory, regardless of cwd
const MARKED_FILE = path.join(os.homedir(), '.claude-cli', 'markedSessions.json');

/**
 * Get the path to ~/.claude/bingo/settings.json (offline persistence for language
 * and auto-mode settings, same file used by provider service). This ensures
 * these settings survive across full restarts.
 */
function getBingoSettingsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'bingo', 'settings.json');
}

function getGlobalClaudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

function getClaudeSettingsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'settings.json');
}

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Determine if in "official" mode (no custom provider active).
 * Logic matches ConversationService.shouldMarkManagedOAuth().
 */
function isOfficialMode(): boolean {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const settingsPath = path.join(configDir, 'bingo', 'settings.json');
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as { env?: Record<string, string> };
    const env = parsed.env ?? {};
    const hasProviderEnv = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']
      .some(key => typeof env[key] === 'string' && env[key]!.trim().length > 0);
    return !hasProviderEnv;
  } catch {
    return true; // Cannot read settings.json -> Treat as official mode
  }
}

/**
 * Build spawn env for child process.
 * In official mode, inject CLAUDE_CODE_ENTRYPOINT=claude-desktop + CLAUDE_CODE_OAUTH_TOKEN,
 * so new/resumed bingocode windows can use OAuth directly.
 */
async function buildSpawnEnv(): Promise<NodeJS.ProcessEnv> {
  const base = { ...process.env };
  if (!isOfficialMode()) return base;

  // Official mode: mark as managed-OAuth and inject OAuth token
  base.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop';
  try {
    const { hahaOAuthService } = await import('../server/services/hahaOAuthService.js');
    const token = await hahaOAuthService.ensureFreshAccessToken();
    if (token) {
      base.CLAUDE_CODE_OAUTH_TOKEN = token;
    } else {
      // No valid token -> don't inject, use normal login flow
      delete base.CLAUDE_CODE_OAUTH_TOKEN;
    }
  } catch {
    delete base.CLAUDE_CODE_OAUTH_TOKEN;
  }
  return base;
}

// Top height: Home = Clawd(3 rows) + border(2) = 5; Compact = 1 row + border(2) = 3
const TOP_H_HOME = Number(process.env.CLI_TOP_H_HOME || 5);
const TOP_H_COMPACT = Number(process.env.CLI_TOP_H_COMPACT || 3);
// Bottom bar height
const BOTTOM_H = Number(process.env.CLI_BOTTOM_H || 3);

const LANG_OPTIONS = [
  { label: 'English', value: 'en' as const },
  { label: '中文',    value: 'zh' as const },
  { label: '日本語',  value: 'ja' as const },
];

const i18nMap = {
  zh: {
    menu: {
      newSession: '新建会话',
      history: '会话历史',
      provider: 'API 配置',
      settings: '设置',
      about: '关于',
      exit: '退出',
    },
    about: 'Bingo CLI 终端 - 版本信息与关于',
    aboutContent: [
      'Bingo 是一款 AI 助手终端客户端。',
      '1. API 配置：按 "P" 或选择「API 配置」来设置你的密钥。',
      '2. 模型槽：在 Provider 面板中配置各模型。',
      '3. 后台服务：Bingo 会运行一个本地服务器来管理会话。',
      '4. 开始聊天：在任意终端中运行 `bingocode` 或 `claude`。',
    ].join('\n'),
    aboutFooter: '作者: leanchy (leanchy07@outlook.com)  ·  github.com/leanchy/claude-code-bingo',
    mark: '→ 标记会话',
    unmark: '→ 取消标记',
    tipsSimple: 'L 语言 | ESC 返回 | ←→ 菜单 | ↩ 确认 | ? 帮助',
    noData: '暂无数据',
    emptyHistory: '还没有会话，要新建一个吗？',
    deleting: '确定删除此会话？（不可恢复）',
    historyHint: '↩ 打开 · j 下一页 · k 首页 · q 返回',
    helpTitle: '快捷键',
    // Settings page
    settingsTitle: '设置',
    langLabel: '语言',
    langPickerTitle: '选择语言',
    settingsHint: '↑/k ↓/j 滚动 · ↩ 切换 · ESC 返回',
    langOptions: LANG_OPTIONS,
    autoModeLabel: 'Auto Mode',
    autoModeOn: '已开启',
    autoModeOff: '已关闭',
    bypassPermsLabel: 'Bypass',
    bypassPermsOn: '已开启',
    bypassPermsOff: '已关闭',
  },
  en: {
    menu: {
      newSession: 'New Session',
      history: 'Session History',
      provider: 'API Config',
      settings: 'Settings',
      about: 'About',
      exit: 'Exit',
    },
    about: 'Bingo CLI Terminal - Version Info & About',
    aboutContent: [
      'Bingo is an AI assistant terminal client.',
      '1. API Config: Press "P" or select "API Config" to set up your keys.',
      '2. Model Slots: Configure specific models in the Provider panel.',
      '3. Background Service: Bingo runs a local server to manage sessions.',
      '4. Start Chat: Run `bingocode` or `claude` in any terminal to start.',
    ].join('\n'),
    aboutFooter: 'Author: leanchy (leanchy07@outlook.com)  ·  github.com/leanchy/claude-code-bingo',
    mark: '→ Mark Session',
    unmark: '→ Unmark Session',
    tipsSimple: 'L Lang | ESC Back | ←→ Menu | ↩ Enter | ? Help',
    noData: 'No data',
    emptyHistory: 'Nothing here yet. Start a new session?',
    deleting: 'Delete this session? (Irreversible)',
    historyHint: 'Enter to open · j next · k first · q back',
    helpTitle: 'Shortcuts',
    // Settings page
    settingsTitle: 'Settings',
    langLabel: 'Language',
    langPickerTitle: 'Select Language',
    settingsHint: '↑/k ↓/j scroll · ↩ toggle · ESC back',
    langOptions: LANG_OPTIONS,
    autoModeLabel: 'Auto Mode',
    autoModeOn: 'Enabled',
    autoModeOff: 'Disabled',
    bypassPermsLabel: 'Bypass',
    bypassPermsOn: 'Enabled',
    bypassPermsOff: 'Disabled',
  },
  ja: {
    menu: {
      newSession: '新規セッション',
      history: 'セッション履歴',
      provider: 'API設定',
      settings: '設定',
      about: 'について',
      exit: '終了',
    },
    about: 'Bingo CLI ターミナル - バージョン情報',
    aboutContent: [
      'BingoはAIアシスタントのターミナルクライアントです。',
      '1. API設定: "P"キーまたは「API設定」を選択してキーを設定。',
      '2. モデルスロット: Providerパネルで各モデルを設定。',
      '3. バックグラウンドサービス: セッション管理用ローカルサーバーを起動。',
      '4. チャット開始: 任意のターミナルで `bingocode` または `claude` を実行。',
    ].join('\n'),
    aboutFooter: '作者: leanchy (leanchy07@outlook.com)  ·  github.com/leanchy/claude-code-bingo',
    mark: '→ セッションをマーク',
    unmark: '→ マークを解除',
    tipsSimple: 'L 言語 | ESC 戻る | ←→ メニュー | ↩ 決定 | ? ヘルプ',
    noData: 'データなし',
    emptyHistory: 'まだセッションがありません。新規作成しますか？',
    deleting: 'このセッションを削除しますか？（元に戻せません）',
    historyHint: '↩ 開く · j 次へ · k 最初へ · q 戻る',
    helpTitle: 'ショートカット',
    // Settings page
    settingsTitle: '設定',
    langLabel: '言語',
    langPickerTitle: '言語を選択',
    settingsHint: '↑/k ↓/j スクロール · ↩ 切替 · ESC 戻る',
    langOptions: LANG_OPTIONS,
    autoModeLabel: 'Auto Mode',
    autoModeOn: '有効',
    autoModeOff: '無効',
    bypassPermsLabel: 'Bypass',
    bypassPermsOn: '有効',
    bypassPermsOff: '無効',
  },
};

const menuKeys = [
  'newSession', 'history', 'provider', 'settings', 'about', 'exit'
] as const;
type MenuKey = typeof menuKeys[number];
type Lang = keyof typeof i18nMap;

//@C:F ID=F.CM.loadMarkedSessionIds;K=F;V=1.0;P=load marked ids;D=CLI;M=cli;S=init;In=;Out=Set<string>
function loadMarkedSessionIds(): Set<string> {
  try {
    const arr = JSON.parse(fs.readFileSync(MARKED_FILE, 'utf-8'));
    return new Set(typeof arr === 'object' && Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

//@C:F ID=F.CM.saveMarkedSessionIds;K=F;V=1.1;P=save marked ids;D=CLI;M=cli;S=persist;In=Set<string>;Out=void
function saveMarkedSessionIds(set: Set<string>) {
  try {
    const dir = path.dirname(MARKED_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(MARKED_FILE, JSON.stringify([...set]), 'utf-8');
  } catch (err) {
    console.error('[saveMarkedSessionIds] Save failed:', err);
  }
}

// Message Entry (Aligned with backend MessageEntry)
type MessageEntry = {
  id: string;
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
  content: unknown; // string 或 ContentBlock[]
  timestamp: string;
  model?: string;
  parentUuid?: string;
  parentToolUseId?: string;
  isSidechain?: boolean;
};

  /** Extract plain text from MessageEntry.content */
function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        if (block.type === 'tool_use') return `[Tool: ${block.name || 'unknown'}]`;
        if (block.type === 'tool_result') {
          if (typeof block.content === 'string') return block.content;
          if (Array.isArray(block.content)) {
            return block.content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('\n');
          }
          return '[Tool Result]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content ?? '');
}

//@C:F ID=F.CM.CliMenuManager;K=F;V=1.5;P=CLI Main Menu;D=CLI;M=cli;S=main;In=;Out=JSX.Element
export const CliMenuManager: React.FC = () => {
  const { stdout } = useStdout();
  const [terminalSize, setTerminalSize] = useState({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24
  });

  useEffect(() => {
    const onResize = () => {
      setTerminalSize({
        columns: stdout?.columns || 80,
        rows: stdout?.rows || 24
      });
    };
    stdout?.on('resize', onResize);
    return () => { stdout?.off('resize', onResize); };
  }, [stdout]);

  // Dynamic viewport
  const VIEW_W = Number(process.env.CLI_VIEW_W || Math.min(terminalSize.columns, 96));
  const VIEW_H = Number(process.env.CLI_VIEW_H || terminalSize.rows);

  const [apiUrl, setApiUrl] = useState<string | null>(process.env.BASE_API_URL || null);
  const [stopIfLast, setStopIfLast] = useState<null | (() => Promise<void>)>(null);
  const [bootErr, setBootErr] = useState<string | null>(null);
  const { exit } = useApp();

  // Theme (Global Hook)
  const [theme, setTheme] = useTheme();

  // Language
  const [lang, setLang] = useState<Lang>('en');

  // Config ready probe (avoid Logo early read)
  const [configReady, setConfigReady] = useState(false);

  // Load settings from bingo/settings.json at startup
  // (bypasses configReady to avoid stale lock issues)
  useEffect(() => {
    try {
      const bSettings = readJsonFile(getBingoSettingsPath());
      const bingoLang = bSettings.language as string | undefined;
      if (bingoLang && (bingoLang === 'en' || bingoLang === 'zh' || bingoLang === 'ja')) {
        setLang(bingoLang as Lang);
      }
      if (typeof bSettings.autoModeEnabled === 'boolean') {
        setAutoModeEnabled(bSettings.autoModeEnabled);
      }
      if (typeof bSettings.bypassPermsEnabled === 'boolean') {
        setBypassPermsEnabled(bSettings.bypassPermsEnabled);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (configReady) {
      try {
        const cfg = getGlobalConfig();
        if (typeof cfg.uiAnimEnabled === 'boolean') setAnimEnabled(cfg.uiAnimEnabled);
        if (typeof cfg.uiTipsEnabled === 'boolean') setTipsEnabled(cfg.uiTipsEnabled);
      } catch {}
    }
  }, [configReady]);

  const t = i18nMap[lang].menu;

  // Top time
  const [nowStr, setNowStr] = useState<string>(new Date().toLocaleString('en-US', { hour12: false }));
  useEffect(() => {
    const id = setInterval(() => setNowStr(new Date().toLocaleString('en-US', { hour12: false })), 1000);
    return () => clearInterval(id);
  }, []);

  // Main Menu
  const [page, setPage] = useState<MenuKey | null>(null);
  const menuItems = useMemo(() => menuKeys.map(key => ({ label: t[key], value: key })), [t]);
  const [navIndex, setNavIndex] = useState(0);

  // New Session
  const [newSessionId, setNewSessionId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // History
  const [loadingHist, setLoadingHist] = useState(false);
  const [historyList, setHistoryList] = useState<any[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState<boolean>(false);
  const [histErr, setHistErr] = useState<string | null>(null);
  const [historyMenuStage, setHistoryMenuStage] = useState<'list'|'window'|'deleteConfirm'>('list');
  const [selectedHistory, setSelectedHistory] = useState<any|null>(null);

  // History Messages
  const [sessionMessages, setSessionMessages] = useState<MessageEntry[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [msgsErr, setMsgsErr] = useState<string | null>(null);
  const [msgsPage, setMsgsPage] = useState(0);

  // Mark Persistence
  const [markedSessionIds, setMarkedSessionIds] = useState<Set<string>>(new Set());

  // Settings page scroll offset
  const [settingsOffset, setSettingsOffset] = useState(0);
  const [settingData, setSettingData] = useState<any>(null);
  const [loadingSetting, setLoadingSetting] = useState(false);
  const [setErr, setSetErr] = useState<string | null>(null);
  const [settingsStage, setSettingsStage] = useState<'list' | 'langPicker'>('list');
  const [settingsCursor, setSettingsCursor] = useState(0);
  const [autoModeEnabled, setAutoModeEnabled] = useState(false);
  const [bypassPermsEnabled, setBypassPermsEnabled] = useState(false);

  // Top toolbar state
  const [animEnabled, setAnimEnabled] = useState(true);
  const [tipsEnabled, setTipsEnabled] = useState(true);

  // Help overlay
  const [showHelp, setShowHelp] = useState(false);

  // Keyboard navigation for lists
  const [listOffset, setListOffset] = useState(0);

  // Quick Resume (R)
  const [quickResumeRequested, setQuickResumeRequested] = useState(false);

  // Compute viewport
  const TOP_H = page === null ? TOP_H_HOME : TOP_H_COMPACT;
  const MID_H = Math.max(5, VIEW_H - TOP_H - BOTTOM_H - (page === null ? 0 : 2));
  const MSGS_PAGE_SIZE = Math.max(1, MID_H - 2);
  const [expandMsgs, setExpandMsgs] = useState(false);

  // Boot/Reuse singleton local server (with retry)
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (apiUrl) return;
      const entry = path.resolve(import.meta.dir, '../server/index.ts');
      const MAX_RETRIES = 3;
      const RETRY_DELAYS = [0, 2000, 5000]; // 0s, 2s, 5s
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (!mounted) return;
          if (attempt > 0) {
            setBootErr(`Attempt ${attempt} failed, retrying in ${RETRY_DELAYS[attempt] / 1000}s...`);
            await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
          }
          if (!mounted) return;
          try {
            const handle = await ensureSingletonLocalServer({ serverEntry: entry });
            if (!mounted) { await handle.stopIfLast(); return; }
            setApiUrl(handle.baseUrl);
            setStopIfLast(() => handle.stopIfLast);
            setBootErr(null);
            return; // Success, exit retry
          } catch (e: any) {
            if (attempt === MAX_RETRIES - 1) {
              setBootErr(e.message || 'Local server failed to start');
            }
          }
      }
    })();
    return () => { mounted = false; if (stopIfLast) stopIfLast(); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const probe = () => {
      try {
        getGlobalConfig();
        if (!cancelled) setConfigReady(true);
      } catch {
        if (!cancelled) setTimeout(probe, 60);
      }
    };
    probe();
    return () => { cancelled = true; };
  }, []);

  // Init marks
  useEffect(() => {
    setMarkedSessionIds(loadMarkedSessionIds());
  }, []);

  // Page switch reset
  useEffect(() => {
    if (page === 'newSession') {
      setNewSessionId(null);
      setCreating(false);
      setCreateErr(null);
    }
    if (page !== 'settings') {
      setSettingsOffset(0);
      setSettingsStage('list');
      setSettingsCursor(0);
    }
    // Close help overlay
    setShowHelp(false);
  }, [page]);

  // History page entry reset
  useEffect(() => {
    if (page === 'history') {
      setHistoryMenuStage('list');
      setSelectedHistory(null);
      setHistoryCursor(null);
      setSessionMessages([]);
      setMsgsErr(null);
      setMsgsPage(0);
      setExpandMsgs(false);
    }
  }, [page]);

  // Create Session
  const onCreateSession = async () => {
    setCreating(true); setCreateErr(null);
    try {
      const fsReq = require('fs');
      const pathReq = require('path');
      const { spawn } = require('child_process');
      // Use import.meta.dir for pkg root
      const pkgPath = pathReq.resolve(import.meta.dir, '../../package.json');
      const pkgJson = JSON.parse(fsReq.readFileSync(pkgPath, 'utf-8'));
      const bins = pkgJson.bin || {};
      const isWin = process.platform === 'win32';
      const binName = isWin
        ? (bins['claude-haha'] ? 'claude-haha' : (bins['claude'] ? 'claude' : Object.keys(bins)[0]))
        : (bins['claude-linux'] ? 'claude-linux' : (bins['claude'] ? 'claude' : Object.keys(bins)[0]));
      const spawnCmd = isWin ? 'cmd' : 'sh';
      // Windows calls global bingocode directly
      const spawnArgs = isWin ? ['/c', 'start', 'cmd', '/k', 'bingocode'] : ['-c', `${binName}`];
      const spawnEnv = await buildSpawnEnv();
      spawn(spawnCmd, spawnArgs, {
        cwd: process.env.CALLER_DIR || process.cwd(),
        env: spawnEnv,
        detached: true,
        stdio: 'ignore'
      }).unref();
      setNewSessionId('Started: ' + binName);
    } catch(e: any) {
      setCreateErr(e.message || 'Failed to create');
    } finally {
      setCreating(false);
    }
  };

  // Paged loading for history
  useEffect(() => {
    if (page === 'history' && historyMenuStage === 'list') {
      setLoadingHist(true); setHistErr(null);
      (async () => {
        try {
          let url = apiUrl + '/api/sessions';
          if (historyCursor) url += `?cursor=${historyCursor}`;
          const res = await axios.get(url);
          const pageData = res.data;
          setHistoryList(pageData?.sessions || []);
          if (historyCursor === null) {
            setHistoryCursor(pageData?.first_id || null);
          }
          setHistoryHasMore(!!pageData?.has_more);
        } catch (e: any) {
          setHistErr(e.message || 'Failed to fetch history');
        } finally {
          setLoadingHist(false);
        }
      })();
    }
    if (page !== 'history') {
      setLoadingHist(false);
      setHistErr(null);
      setHistoryList([]);
    }
  }, [page, historyCursor, historyMenuStage, apiUrl]);

  // 快速恢复：当按下 R 并已加载历史列表后，自动进入第一个会话窗口
  useEffect(() => {
    if (page === 'history' && historyMenuStage === 'list' && quickResumeRequested && historyList.length) {
      const session = historyList[0];
      if (session) {
        setSelectedHistory(session);
        setHistoryMenuStage('window');
        setQuickResumeRequested(false);
      }
    }
  }, [page, historyMenuStage, quickResumeRequested, historyList]);

  // 会话消息获取
  useEffect(() => {
    if (page === 'history' && historyMenuStage === 'window' && selectedHistory && apiUrl) {
      let cancelled = false;
      setLoadingMsgs(true);
      setMsgsErr(null);
      setSessionMessages([]);
      setMsgsPage(0);
      (async () => {
        try {
          const resp = await axios.get(`${apiUrl}/api/sessions/${selectedHistory.id}/messages`);
          if (!cancelled) {
            const msgs: MessageEntry[] = resp.data?.messages ?? [];
            setSessionMessages(msgs);
          }
        } catch (e: any) {
          if (!cancelled) setMsgsErr(e.message || 'Failed to load messages');
        } finally {
          if (!cancelled) setLoadingMsgs(false);
        }
      })();
      return () => { cancelled = true; };
    } else {
      setSessionMessages([]);
      setLoadingMsgs(false);
      setMsgsErr(null);
    }
  }, [page, historyMenuStage, selectedHistory, apiUrl]);

  // Settings data
  useEffect(() => {
    if (page === 'settings') {
      setLoadingSetting(true); setSetErr(null);
      (async () => {
        try {
          const data = (await import('../utils/settings/settings')).default;
          setSettingData(data);
        } catch(e: any) {
          setSetErr(e.message||'Failed to load settings');
        } finally { setLoadingSetting(false); }
      })();
    } else {
      setSettingData(null);
      setLoadingSetting(false);
      setSetErr(null);
    }
  }, [page]);

  // Keyboard interactions
  useInput((input, key) => {
    // Language toggle (en → zh → ja → en)
    if (input === 'l' || input === 'L') {
      const langOrder: Lang[] = ['en', 'zh', 'ja'];
      const nextLang = langOrder[(langOrder.indexOf(lang) + 1) % langOrder.length];
      setLang(nextLang);
      try { writeJsonAtomic(getBingoSettingsPath(), { language: nextLang }); } catch {}
      return;
    }

    // Theme toggle (G)
    if ((input === 'g' || input === 'G')) {
      const order = ['light', 'dark', 'highContrast'] as const;
      const curr = String(theme || 'light');
      const idx = Math.max(0, order.indexOf(curr as any));
      const next = order[(idx + 1) % order.length];
      setTheme(next as any);
      try { saveGlobalConfig(current => ({ ...current, theme: next as any })); } catch {}
      return;
    }

    // Top animation toggle (O)
    if (input === 'o' || input === 'O') {
      setAnimEnabled(v => {
        const next = !v;
        try { saveGlobalConfig(current => ({ ...current, uiAnimEnabled: next })); } catch {}
        return next;
      });
      return;
    }
    // Top Tips toggle (T)
    if (input === 't' || input === 'T') {
      setTipsEnabled(v => {
        const next = !v;
        try { saveGlobalConfig(current => ({ ...current, uiTipsEnabled: next })); } catch {}
        return next;
      });
      return;
    }

    // Help overlay (?)
    if (input === '?') {
      setShowHelp(v => !v);
      return;
    }

    // ESC to back or close help
    if (key.escape) {
      if (showHelp) { setShowHelp(false); return; }
      if (page === 'provider') return; // Handled internally
      // Settings: langPicker → back to list; list → back to main menu
      if (page === 'settings') {
        if (settingsStage === 'langPicker') { setSettingsStage('list'); return; }
      }
      setPage(null);
      setHistoryMenuStage('list');
      setSelectedHistory(null);
      setHistoryCursor(null);
      setSessionMessages([]);
      setMsgsPage(0);
      setSettingsOffset(0);
      return;
    }

    // Quick entries: N New, R Resume, P Provider
    if (input === 'n' || input === 'N') {
      setPage('newSession');
      onCreateSession();
      return;
    }
    if (input === 'r' || input === 'R') {
      setPage('history');
      setQuickResumeRequested(true);
      return;
    }
    if (input === 'p' || input === 'P') {
      setPage('provider');
      return;
    }

    // Main menu navigation
    if (!showHelp && key.leftArrow && page === null) {
      setNavIndex(i => (i - 1 + menuItems.length) % menuItems.length);
      return;
    }
    if (!showHelp && key.rightArrow && page === null) {
      setNavIndex(i => (i + 1) % menuItems.length);
      return;
    }
    if (!showHelp && key.return && page === null) {
      const keyVal = menuItems[navIndex].value as MenuKey;
      setPage(keyVal);
      if (keyVal === 'newSession') onCreateSession();
      if (keyVal === 'exit') exit();
      return;
    }

    // History shortcuts
    if (!showHelp && page === 'history') {
      if (historyMenuStage === 'list') {
        const HIST_VISIBLE = MID_H - 2;
        if (key.downArrow || input === 'j' || input === '\u001b[B') {
          // Internal SelectInput handles cursor, we just need to track offset for ScrollBar
          setListOffset(o => Math.min(o + 1, Math.max(0, groupedHistoryItems.length - HIST_VISIBLE)));
        }
        if (key.upArrow || input === 'k' || input === '\u001b[A') {
          setListOffset(o => Math.max(0, o - 1));
        }
        if (input === 'q') {
          setPage(null);
          setHistoryMenuStage('list');
          setSelectedHistory(null);
          setHistoryCursor(null);
          setListOffset(0);
          return;
        }
        if (input === 'j' && historyHasMore) {
          setHistoryCursor(historyList[historyList.length - 1]?.id || null);
          setListOffset(0);
          return;
        }
        if (input === 'k') {
          setHistoryCursor(null);
          setListOffset(0);
          return;
        }
      } else if (historyMenuStage === 'window') {
        if ((input === 'm' || input === 'M') && selectedHistory) {
          handleHistoryMenuAction('__toggle_mark');
          return;
        }
        if ((input === 'c' || input === 'C') && selectedHistory) {
          handleHistoryMenuAction('__continue');
          return;
        }
        if ((input === 'd' || input === 'D') && selectedHistory) {
          handleHistoryMenuAction('__delete');
          return;
        }
        if (input === 'q') {
          handleHistoryMenuAction('__back');
          return;
        }
        // Message scrolling
        if (key.upArrow || input === 'k') {
          setMsgsPage(p => Math.max(0, p - 1));
          return;
        }
        if (key.downArrow || input === 'j') {
          setMsgsPage(p => p + 1);
          return;
        }

      } else if (historyMenuStage === 'deleteConfirm') {
        if (input === 'q') {
          handleHistoryMenuAction('__cancel_delete');
          return;
        }
      }
    }

    // Settings interactions
    if (!showHelp && page === 'settings') {
      if (settingsStage === 'list') {
        // +1 for the fixed Language row prepended before settingData entries
        const totalRows = 3 + (settingData && typeof settingData === 'object' ? Object.keys(settingData).length : 0);
        const visible = Math.max(1, MID_H - 2);
        if (key.downArrow || input === 'j') {
          setSettingsCursor(c => Math.min(totalRows - 1, c + 1));
          setSettingsOffset(o => Math.min(Math.max(0, totalRows - visible), o + 1));
        }
        if (key.upArrow || input === 'k') {
          setSettingsCursor(c => Math.max(0, c - 1));
          setSettingsOffset(o => Math.max(0, o - 1));
        }
        if (key.return) {
          // Row 0 is the interactive Language row
          if (settingsCursor === 0) {
            setSettingsStage('langPicker');
          } else if (settingsCursor === 1) {
            // Row 1: toggle Auto Mode
            setAutoModeEnabled(prev => {
              const next = !prev;
              try {
                writeJsonAtomic(getBingoSettingsPath(), { autoModeEnabled: next });
                const gcfg = readJsonFile(getGlobalClaudeConfigPath());
                gcfg.autoModeConfig = next
                  ? { enabled: 'enabled', allowModels: ['*'] }
                  : { enabled: 'disabled' };
                writeJsonAtomic(getGlobalClaudeConfigPath(), gcfg);
              } catch {
                return prev; // write failed — keep old state
              }
              return next;
            });
          } else if (settingsCursor === 2) {
            // Row 2: toggle Bypass Permissions
            setBypassPermsEnabled(prev => {
              const next = !prev;
              try {
                writeJsonAtomic(getBingoSettingsPath(), { bypassPermsEnabled: next });
                const safeSettings = next
                  ? { permissions: { defaultMode: 'bypassPermissions', skipDangerousModePermissionPrompt: true } }
                  : { permissions: { defaultMode: 'default' } };
                writeJsonAtomic(getClaudeSettingsPath(), safeSettings);
              } catch {
                return prev; // write failed — keep old state
              }
              return next;
            });
          }
        }
      }
      // langPicker stage: ESC handled above; selection via SelectInput onSelect
    }
  }, [menuItems, page, historyMenuStage, historyList, historyHasMore, navIndex, sessionMessages, settingData, MID_H, MSGS_PAGE_SIZE, showHelp, theme, settingsStage, settingsCursor, autoModeEnabled, bypassPermsEnabled]);

  function cleanText(text: string): string {
    return String(text ?? '').replace(/[\n\r]+/g, ' ').replace(/\u001b\[[0-9;]*m/g, '').trim();
  }

  function clampTextLines(text: string, maxWidth: number, maxLines: number) {
    const cleaned = cleanText(text);
    const out: string[] = [];
    if (cleaned.length <= maxWidth) {
      out.push(cleaned);
    } else {
      out.push(cleaned.slice(0, maxWidth - 1) + '…');
    }
    return out.join('\n');
  }

  function makeHistoryLabel(item: any, width: number, isMarked: boolean) {
    const star = isMarked ? '★ ' : '';
    const ts = String(item.createdAt || '').slice(0, 16).replace('T', ' ');
    const cnt = String(item.messageCount ?? 0).padStart(3, ' ');
    // Reserved width for: prefix(star+time) + spacer(2) + suffix(1+cnt)
    // Star is width 2, ts is width 16, spacer is 2, cnt is 3, padding is 1. Total = 24
    const reserved = 24;
    const titleMax = Math.max(8, width - reserved);
    const title = safePadEnd(truncate(String(item.title || ''), titleMax), titleMax);
    return `${star}${ts}  ${title} ${cnt}`;
  }

  // 新增：会话恢复（供快捷键和右侧菜单复用）
  // workDir: 会话原始工作目录，用于跨文件夹恢复（确保新进程能找到 session 文件）
  async function resumeSession(sessionId: string, workDir?: string | null) {
    try {
      const fsReq = require('fs');
      const pathReq = require('path');
      const { spawn } = require('child_process');
      // 用 import.meta.dir 定位包根，避免 process.cwd() 指向用户目录
      const pkgPath = pathReq.resolve(import.meta.dir, '../../package.json');
      const pkgJson = JSON.parse(fsReq.readFileSync(pkgPath, 'utf-8'));
      const bins = pkgJson.bin || {};
      const isWin = process.platform === 'win32';
      const binName = isWin
        ? (bins['claude-haha'] ? 'claude-haha' : (bins['claude'] ? 'claude' : Object.keys(bins)[0]))
        : (bins['claude-linux'] ? 'claude-linux' : (bins['claude'] ? 'claude' : Object.keys(bins)[0]));
      const spawnCmd = isWin ? 'cmd' : 'sh';
      // Windows 直接调全局 bingocode 命令，不用 bun 前缀
      const spawnArgs = isWin
        ? ['/c', 'start', 'cmd', '/k', `bingocode --resume ${sessionId}`]
        : ['-c', `${binName} --resume ${sessionId}`];
      const spawnEnv = await buildSpawnEnv();
      spawn(spawnCmd, spawnArgs, {
        cwd: workDir || process.env.CALLER_DIR || process.cwd(),
        env: spawnEnv,
        detached: true,
        stdio: 'ignore'
      }).unref();
    } catch {}
  }


	  // 历史分组展示
	  const groupedHistoryItems = useMemo(() => {
	    if (!historyList || !Array.isArray(historyList)) return [];
	    const now = new Date();
	    const today: any[] = [];
	    const week: any[] = [];
	    const earlier: any[] = [];
	    const marked: any[] = [];

	    for (const item of historyList) {
	      if (markedSessionIds.has(item.id)) {
	        marked.push(item);
	        continue;
	      }
	      const dt = new Date(item.createdAt);
	      const isToday =
	        dt.getFullYear() === now.getFullYear() &&
	        dt.getMonth() === now.getMonth() &&
	        dt.getDate() === now.getDate();
	      const weekStart = new Date(now);
	      weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
	      weekStart.setHours(0, 0, 0, 0);
	      if (isToday) today.push(item);
	      else if (dt >= weekStart) week.push(item);
	      else earlier.push(item);
	    }
	    function groupToItems(group: any[], groupTitle: string) {
	      if (group.length === 0) return [];
	      return [
	        { label: groupTitle, value: `__group_${groupTitle}`, isGroup: true },
	        ...group.map(item => {
	          const isMarked = markedSessionIds.has(item.id);
	          return {
	            label: makeHistoryLabel(item, Math.max(20, VIEW_W - 8), isMarked),
	            value: item.id,
	            color: isMarked ? 'yellow' : undefined,
	          };
	        })
	      ];
	    }
	    const items = [
	      ...groupToItems(marked, '—— Marked ——'),
	      ...groupToItems(today, '—— Today ——'),
	      ...groupToItems(week, '—— This Week ——'),
	      ...groupToItems(earlier, '—— Earlier ——'),
	    ];
	    return items;
	  }, [historyList, markedSessionIds]);

  // Toggle Mark
  const toggleMarkSession = (sessionId: string) => {
    setMarkedSessionIds(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      saveMarkedSessionIds(next);
      return next;
    });
  };

  const handleHistoryMenuAction = (action: string) => {
    if (action === '__back') {
      setHistoryMenuStage('list');
      setSelectedHistory(null);
      setMsgsPage(0);
      return;
    }
    if (!selectedHistory) return;

    switch (action) {
      case '__toggle_mark':
        toggleMarkSession(selectedHistory.id);
        break;
      case '__continue':
        resumeSession(selectedHistory.id, selectedHistory.workDir);
        break;
      case '__delete':
        setHistoryMenuStage('deleteConfirm');
        break;
      case '__confirm_delete':
        handleDeleteSession(selectedHistory.id);
        break;
      case '__cancel_delete':
        setHistoryMenuStage('window');
        break;
    }
  };


  // Refresh history
  const refreshHistoryList = () => {
    setLoadingHist(true); setHistErr(null);
    let url = apiUrl + '/api/sessions';
    axios.get(url).then(res => {
      const pageData = res.data;
      setHistoryList(pageData?.sessions || []);
      setHistoryCursor(pageData?.first_id || null);
      setHistoryHasMore(!!pageData?.has_more);
    }).catch(e => {
      setHistErr(e.message || 'Failed to fetch history');
    }).finally(() => setLoadingHist(false));
  };

  // Delete Session
  const handleDeleteSession = (sessionId: string) => {
    const url = apiUrl.replace(/\/+$/, '') + '/api/sessions/' + sessionId;
    axios.delete(url)
      .catch(e => {})
      .finally(() => {
        setHistoryMenuStage('list');
        setSelectedHistory(null);
        setHistoryCursor(null);
        refreshHistoryList();
      });
  };

  // Secondary menu (bottom bar right)
  const secondaryMenu: SecondaryMenu = useMemo(() => {
    if (page === 'history' && historyMenuStage === 'window' && selectedHistory) {
      const isMarked = markedSessionIds.has(selectedHistory.id);
      const markLabel = isMarked ? i18nMap[lang].unmark : i18nMap[lang].mark;
      return {
        title: 'Session Actions',
        items: [
          { label: markLabel, value: '__toggle_mark' },
          { label: '→ Continue session', value: '__continue' },
          { label: '→ Delete session', value: '__delete' },
          { label: '← Back to list', value: '__back' },
        ],
        onSelect: (item: any) => {
          if (item.value === '__back') {
            setHistoryMenuStage('list');
            setSelectedHistory(null);
            setMsgsPage(0);
          } else if (item.value === '__continue') {
            resumeSession(selectedHistory.id, selectedHistory.workDir);
          } else if (item.value === '__delete') {
            setHistoryMenuStage('deleteConfirm');
          } else if (item.value === '__toggle_mark') {
            toggleMarkSession(selectedHistory.id);
          }
        }
      };
    }

    if (page === 'history' && historyMenuStage === 'deleteConfirm' && selectedHistory) {
      return {
        title: 'Confirm Delete',
        items: [
          { label: 'Yes, delete', value: '__confirm_delete' },
          { label: 'No, back', value: '__cancel_delete' },
        ],
        onSelect: (item: any) => {
          if (item.value === '__cancel_delete') {
            setHistoryMenuStage('window');
          } else if (item.value === '__confirm_delete') {
            handleDeleteSession(selectedHistory.id);
          }
        }
      };
    }
    return null;
  }, [page, historyMenuStage, selectedHistory, markedSessionIds, lang]);

  // Help Overlay
  function renderHelpOverlay() {
    return (
      <Box width={VIEW_W} height={MID_H} flexDirection="column">
        <Text color="magenta">{i18nMap[lang].helpTitle}</Text>
        <Text> </Text>
        <Text color="cyan">N</Text><Text>  New Session</Text>
        <Text color="cyan">R</Text><Text>  Quick Resume</Text>
        <Text color="cyan">P</Text><Text>  Open Provider Config</Text>
        <Text color="cyan">G</Text><Text>  Toggle Theme (light/dark/highContrast)</Text>
        <Text color="cyan">L</Text><Text>  Toggle Language (en → zh → ja)</Text>
        <Text color="cyan">O</Text><Text>  Toggle Top Animation</Text>
        <Text color="cyan">T</Text><Text>  Toggle Top Tips</Text>
        <Text color="cyan">?</Text><Text>  Toggle Help</Text>
        <Text> </Text>
        <Hint>ESC to close · Works anywhere</Hint>
      </Box>
    );
  }

  // Center Content
  function renderCenter() {
    if (showHelp) return renderHelpOverlay();

    // Home: WelcomeV2 (58 cols wide)
    if (page === null) {
      const WELCOME_W = 58;
      const leftPad = Math.max(0, Math.floor((VIEW_W - WELCOME_W) / 2));
      return (
        <Box flexDirection="column" width={VIEW_W} height={MID_H}>
          <Box flexDirection="row" width={VIEW_W} flexGrow={1}>
            <Box width={leftPad} flexShrink={0} />
            <WelcomeV2 />
          </Box>
          {!apiUrl && !bootErr && (
            <StateDisplay type="loading" message="Starting server..." />
          )}
          {bootErr && (
            <StateDisplay type="error" message={`Server boot failed: ${bootErr}`} />
          )}
        </Box>
      );
    }

    // New Session
    if (page === 'newSession') {
      return (
        <Box flexDirection="column" width={VIEW_W} height={MID_H}>
          {creating && <StateDisplay type="loading" message="Creating..." />}
          {createErr && <StateDisplay type="error" message={`Failed to create: ${createErr}`} />}
          {newSessionId && <Box alignItems="center" justifyContent="center" flexGrow={1}><Text color="green">New Session: {newSessionId}</Text></Box>}
          {!creating && !createErr && !newSessionId && <StateDisplay type="empty" message="Entered new session page, waiting for result..." />}
        </Box>
      );
    }

    // History
    if (page === 'history') {
      if (histErr) return <StateDisplay type="error" message={histErr} onRetry={refreshHistoryList} />;
      if (historyMenuStage === 'deleteConfirm' && selectedHistory) {
        const halfH = Math.floor(MID_H / 2);
        const items = [
          { label: 'Yes, Delete', value: '__confirm_delete' },
          { label: 'No, Back', value: '__cancel_delete' },
        ];
        return (
          <Box width={VIEW_W} height={MID_H} flexDirection="column">
            <Box height={halfH} flexDirection="column" paddingX={1} paddingTop={1}>
              <Text color="red" bold>Confirm Delete?</Text>
              <Text>Title: {selectedHistory.title || 'Untitled'}</Text>
              <Text dimColor>Time: {selectedHistory.createdAt?.replace('T',' ')}</Text>
              <Text dimColor>ID: {selectedHistory.id}</Text>
            </Box>
            <Panel height={MID_H - halfH} borderStyle="round" borderColor="red" paddingX={1}>
              <SelectInput
                items={items}
                onSelect={(item) => handleHistoryMenuAction(String(item.value))}
              />
              <Hint>Enter Confirm · q Cancel</Hint>
            </Panel>
          </Box>
        );
      }
      if (!historyList.length && loadingHist) {
        return <StateDisplay type="loading" message="Loading..." />;
      }
      if (!historyList.length) {
        return <StateDisplay type="empty" message={i18nMap[lang].emptyHistory} />;
      }

      const ACTIONS_H = 7; // Actions title(1) + 4 items + hint(1) + padding(1)
      const LIST_H = Math.max(2, MID_H - ACTIONS_H - 1);

      if (historyMenuStage === 'window' && selectedHistory) {
        // Detailed View with Split
        const isMarked = markedSessionIds.has(selectedHistory.id);
        const displayMsgs = sessionMessages.filter(
          m => m.type === 'user' || m.type === 'assistant' || m.type === 'system'
        );
        const totalPages = Math.max(1, Math.ceil(displayMsgs.length / MSGS_PAGE_SIZE));
        const safePage = Math.min(msgsPage, totalPages - 1);
        const pageStart = safePage * MSGS_PAGE_SIZE;
        const pageMsgs = displayMsgs.slice(pageStart, pageStart + MSGS_PAGE_SIZE);

        return (
          <Box width={VIEW_W} height={MID_H} flexDirection="column">
            {/* Upper Pane: Preview */}
            <Box height={LIST_H} flexDirection="column" paddingX={1} overflow="hidden">
              <Box justifyContent="space-between" marginBottom={0}>
                <Text color={isMarked ? 'yellow' : 'cyan'} bold>
                  {isMarked ? '★ ' : ''}{truncate(selectedHistory.title || 'Untitled', VIEW_W - 24)}
                </Text>
                <Text dimColor>{selectedHistory.createdAt?.slice(0,16).replace('T',' ')}</Text>
              </Box>

              <Box flexDirection="column" flexGrow={1} overflow="hidden">
                {loadingMsgs && <StateDisplay type="loading" message="Loading messages..." />}
                {msgsErr && <StateDisplay type="error" message={msgsErr} />}
                {!loadingMsgs && pageMsgs.length === 0 && <StateDisplay type="empty" message="No messages" />}
                {pageMsgs.map((msg) => {
                  const text = extractTextFromContent(msg.content);
                  const roleLabel = msg.type === 'user' ? 'You' : 'Bot';
                  const roleColor = msg.type === 'user' ? 'green' : 'cyan';
                  return (
                    <Box key={msg.id} marginBottom={0} flexDirection="column" height={1} overflow="hidden">
                      <Text color={roleColor} bold>{roleLabel}: <Text color="white" bold={false}>{clampTextLines(text, VIEW_W - 10, 1)}</Text></Text>
                    </Box>
                  );
                })}
              </Box>
              {totalPages > 1 && (
                <Box justifyContent="center" height={1}>
                  <Hint>Page {safePage + 1}/{totalPages} (↑↓ to scroll)</Hint>
                </Box>
              )}
            </Box>

            <Box height={1} marginBottom={0}><Text dimColor>{'─'.repeat(VIEW_W - 4)}</Text></Box>

            {/* Lower Pane: Actions */}
            <Box height={ACTIONS_H} paddingX={1} flexDirection="column" overflow="hidden">
               <Text color="magenta" bold>Actions</Text>
               <Box marginTop={0} height={ACTIONS_H - 2} overflow="hidden">
                 <SelectInput
                   items={secondaryMenu?.items || []}
                   onSelect={secondaryMenu?.onSelect}
                 />
               </Box>
               <Hint>ESC Back · ↑↓ Select Action · Q/M/C Shortcut</Hint>
            </Box>
          </Box>
        );
      }

	    // History List View (Default)
	    // MID_H - 1 (hint bar at top) - 1 (scrollbar safety) = MID_H - 2 visible items
	    const HIST_VISIBLE = MID_H - 2;
	    const start = Math.min(listOffset, Math.max(0, groupedHistoryItems.length - HIST_VISIBLE));
	    const slicedItems = groupedHistoryItems.slice(start, start + HIST_VISIBLE);

	    return (
	      <Box width={VIEW_W} height={MID_H} flexDirection="column">
	        {/* Hint bar — fixed 1 row at top, never overlaps list */}
	        <Box height={1} paddingX={1}>
	          <Hint>{i18nMap[lang].historyHint}</Hint>
	        </Box>
	        {/* List area — takes the rest of the height */}
	        <Box flexDirection="row" flexGrow={1} position="relative">
	          <Box flexDirection="column" flexGrow={1} paddingX={1}>
	            <SelectInput
	              key={`${historyCursor ?? 'first'}:${slicedItems.length}:${start}`}
	              items={slicedItems}
	              onSelect={item => {
	                if (String(item.value).startsWith('__group_')) return;
	                const session = historyList.find(h => h.id === item.value);
	                if (session) {
	                  setSelectedHistory(session);
	                  setHistoryMenuStage('window');
	                }
	              }}
	              itemComponent={({ isSelected, label }) => {
	                const it = groupedHistoryItems.find(i => i.label === label);
	                const isGroup = it?.isGroup;
	                const color = it?.color;
	                return (
	                  <Box height={1} overflow="hidden">
	                    <Text wrap="truncate" color={isGroup ? 'gray' : (color ? color : (isSelected ? 'cyan' : undefined))}>
	                      {isSelected ? '> ' : '  '}{label}
	                    </Text>
	                  </Box>
	                )
	              }}
	            />
	          </Box>
	          <ScrollBar total={groupedHistoryItems.length} offset={start} height={MID_H - 3} />
	        </Box>
	      </Box>
	    );
	  }

    // Provider
    if (page === 'provider') {
      if (!apiUrl) {
        return (
          <Box width={VIEW_W} height={MID_H} flexDirection="column">
            <StateDisplay
              type={bootErr ? "error" : "loading"}
              message={bootErr ? `Server boot failed: ${bootErr}` : 'Starting server, please wait...'}
              onRetry={() => process.exit(1)} // Or another way to trigger reboot
            />
            <Text dimColor alignSelf="center">ESC for main menu</Text>
          </Box>
        );
      }
      return (
        <Box width={VIEW_W} height={MID_H} flexDirection="column">
          <ProviderPanel apiUrl={apiUrl} height={MID_H} onBack={() => setPage(null)} />
        </Box>
      );
    }

    // Settings
    if (page === 'settings') {
      if (loadingSetting) return <StateDisplay type="loading" message="Loading settings..." />;
      if (setErr) return <StateDisplay type="error" message={setErr} />;

      const tS = i18nMap[lang];
      const currentLangLabel = LANG_OPTIONS.find(o => o.value === lang)?.label ?? lang;

      // --- langPicker sub-menu ---
      if (settingsStage === 'langPicker') {
        return (
          <Box width={VIEW_W} height={MID_H} flexDirection="column">
            <Box paddingX={1} marginBottom={1}>
              <Text color="magenta" bold>{tS.langPickerTitle}</Text>
            </Box>
            <Box paddingX={2} flexGrow={1} flexDirection="column">
              <SelectInput
                items={tS.langOptions}
                initialIndex={tS.langOptions.findIndex(o => o.value === lang)}
                onSelect={(item: { label: string; value: Lang }) => {
                  setLang(item.value);
                  try { writeJsonAtomic(getBingoSettingsPath(), { language: item.value }); } catch {}
                  setSettingsStage('list');
                }}
              />
            </Box>
            <Box paddingX={1}>
              <Hint>↩ confirm · ESC back</Hint>
            </Box>
          </Box>
        );
      }

      // --- settings list ---
      type SettingRow = { key: string; label: string; value: string; interactive: boolean };
      const fixedRows: SettingRow[] = [
        { key: '__lang', label: tS.langLabel, value: currentLangLabel, interactive: true },
        { key: '__autoMode', label: tS.autoModeLabel, value: autoModeEnabled ? tS.autoModeOn : tS.autoModeOff, interactive: true },
        { key: '__bypassPerms', label: tS.bypassPermsLabel, value: bypassPermsEnabled ? tS.bypassPermsOn : tS.bypassPermsOff, interactive: true },
      ];
      const dataEntries = settingData && typeof settingData === 'object' ? Object.entries(settingData) : [];
      const dataRows: SettingRow[] = dataEntries.map(([k, v]) => ({
        key: k,
        label: k,
        value: typeof v === 'object' ? JSON.stringify(v) : String(v),
        interactive: false,
      }));
      const allRows: SettingRow[] = [...fixedRows, ...dataRows];
      const visible = Math.max(1, MID_H - 2);
      const start = Math.min(settingsOffset, Math.max(0, allRows.length - visible));
      const sliced = allRows.slice(start, start + visible);

      return (
        <Box width={VIEW_W} height={MID_H} flexDirection="column">
          <Box flexDirection="row" position="relative" flexGrow={1}>
            <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
              {sliced.map((row, idx) => {
                const absIdx = start + idx;
                const isCursor = absIdx === settingsCursor;
                const prefix = isCursor ? '>' : ' ';
                const labelColor = isCursor ? 'cyan' : (row.interactive ? 'white' : 'gray');
                const valueColor = row.interactive ? 'green' : undefined;
                return (
                  <Box key={row.key} height={1}>
                    <Text color={labelColor}>
                      {prefix} {row.label}:{'  '}
                      <Text color={valueColor ?? (isCursor ? 'white' : 'gray')}>
                        {row.value}
                        {row.interactive ? '  ↩' : ''}
                      </Text>
                    </Text>
                  </Box>
                );
              })}
            </Box>
            <ScrollBar total={allRows.length} offset={start} height={visible - 1} />
          </Box>
          <Box paddingX={1}>
            <Hint>{tS.settingsHint}  ·  {start + 1}-{Math.min(start + visible, allRows.length)}/{allRows.length}</Hint>
          </Box>
        </Box>
      );
    }

    // About
    if (page === 'about') {
      return (
        <Box width={VIEW_W} height={MID_H} flexDirection="column">
          <Text color="cyan" bold>{i18nMap[lang].about}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>{(i18nMap[lang] as any).aboutContent}</Text>
          </Box>
          <Box marginTop={1}>
            <Hint>
              API Base: {apiUrl}
            </Hint>
          </Box>
          <Box marginTop={1}>
            <Text color="gray">{(i18nMap[lang] as any).aboutFooter}</Text>
          </Box>
        </Box>
      );
    }

    // Exit
    if (page === 'exit') {
      exit();
      return <Box width={VIEW_W} height={MID_H}><Text>Exiting...</Text></Box>;
    }

    return <Box width={VIEW_W} height={MID_H} />;
  }

  // Exit logic
  if (terminalSize.columns < 60 || terminalSize.rows < 15) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text color="red">Terminal too small!</Text>
        <Text>Current: {terminalSize.columns}x{terminalSize.rows}</Text>
        <Text>Please resize to continue...</Text>
      </Box>
    );
  }

  // Root Render
  return (
    <Box flexDirection="column" width={VIEW_W}>
      {/* Top Welcome / Logo Area + Toolbar */}
      <TopBar
        ready={configReady}
        page={page}
        width={VIEW_W}
        height={TOP_H}
        toolbar={
          <TopToolbar
            ready={configReady}
            page={page}
            animEnabled={animEnabled}
            tipsEnabled={tipsEnabled}
            ip={apiUrl ? apiUrl.replace(/^https?:\/\//, '') : undefined}
          />
        }
      />

      {/* Center Center Area */}
      {page === null ? (
        <Panel width={VIEW_W} height={MID_H} noBorder paddingX={0} paddingY={0} marginY={0}>
          {renderCenter()}
        </Panel>
      ) : (
        <Panel width={VIEW_W} height={MID_H} borderStyle="single" paddingX={1} paddingY={0} marginY={1}>
          {renderCenter()}
        </Panel>
      )}

      {/* Bottom Menu & Secondary Menu */}
      <BottomBar
        width={VIEW_W}
        height={BOTTOM_H}
        menuItems={menuItems}
        page={page}
        navIndex={navIndex}
        tips={i18nMap[lang].tipsSimple}
        secondaryMenu={
          page === 'history' && (historyMenuStage === 'window' || historyMenuStage === 'deleteConfirm')
            ? null
            : secondaryMenu
        }
      />
    </Box>
  );
};

export default CliMenuManager;