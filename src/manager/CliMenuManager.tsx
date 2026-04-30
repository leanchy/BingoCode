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
// 新增：通用 UI 元素与顶部工具栏
import { TopBar, BottomBar, Panel, Hint, Kbd, SecondaryMenu } from '../manager/CliMenuUi.tsx';
import { WelcomeV2 } from '../components/LogoV2/WelcomeV2.tsx';
import { TopToolbar } from '../manager/TopToolbar.tsx';

// 主题切换（Hook）
import { useTheme } from '../components/design-system/ThemeProvider.js';
// Markdown 渲染（纯函数，不依赖 AppStateProvider context）
import { applyMarkdown } from '../utils/markdown.js';
import { Ansi } from '../ink/Ansi.js';

// 配置相关（仅使用可用接口）
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.ts';

// markedSessions 存到 ~/.claude-cli/ 固定目录，不受 cwd 影响
const MARKED_FILE = path.join(os.homedir(), '.claude-cli', 'markedSessions.json');

/**
 * 判断是否处于"官方"模式（没有激活任何自定义 provider）。
 * 逻辑与 ConversationService.shouldMarkManagedOAuth() 保持一致。
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
    return true; // 读不到 settings.json → 按官方模式处理
  }
}

/**
 * 构造子进程的 spawn env。
 * 官方模式下注入 CLAUDE_CODE_ENTRYPOINT=claude-desktop + CLAUDE_CODE_OAUTH_TOKEN，
 * 使新建/恢复的 bingocode 窗口能直接走 OAuth，不显示"未登录"。
 */
async function buildSpawnEnv(): Promise<NodeJS.ProcessEnv> {
  const base = { ...process.env };
  if (!isOfficialMode()) return base;

  // 官方模式：标记为 managed-OAuth，并注入 OAuth token
  base.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop';
  try {
    const { hahaOAuthService } = await import('../server/services/hahaOAuthService.js');
    const token = await hahaOAuthService.ensureFreshAccessToken();
    if (token) {
      base.CLAUDE_CODE_OAUTH_TOKEN = token;
    } else {
      // 没有有效 token 时不注入，让 CLI 走正常登录流程
      delete base.CLAUDE_CODE_OAUTH_TOKEN;
    }
  } catch {
    delete base.CLAUDE_CODE_OAUTH_TOKEN;
  }
  return base;
}

// 顶部高度：首页适配 LogoV2 + Toolbar，其它页面更紧凑
const TOP_H_HOME = Number(process.env.CLI_TOP_H_HOME || 9);
const TOP_H_COMPACT = Number(process.env.CLI_TOP_H_COMPACT || 6);
// 底栏高度
const BOTTOM_H = Number(process.env.CLI_BOTTOM_H || 3);

const i18nMap = {
  zh: {
    menu: {
      newSession: '新建会话',
      history: '历史会话',
      provider: 'API配置',
      settings: '设置',
      about: '关于',
      exit: '退出',
    },
    about: 'Bingo CLI 终端 - 版本信息与产品说明',
    mark: '→ 标记会话',
    unmark: '→ 取消标记',
    tipsSimple: 'L 语言 | ESC 返回 | ←→ 菜单 | ↩ 进入 | ? 帮助',
    noData: '暂无数据',
    emptyHistory: '这里还空空的，不如先新建一个会话？',
    deleting: '确认删除本会话？（不可恢复）',
    historyHint: '回车查看详情 · j 下一页 · k 回第一页 · q 返回',
    helpTitle: '快捷键速查',
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
    mark: '→ Mark Session',
    unmark: '→ Unmark Session',
    tipsSimple: 'L Lang | ESC Back | ←→ Menu | ↩ Enter | ? Help',
    noData: 'No data',
    emptyHistory: 'Nothing here yet. Start a new session?',
    deleting: 'Delete this session? (Irreversible)',
    historyHint: 'Enter to open · j next · k first · q back',
    helpTitle: 'Shortcuts',
  }
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
    console.error('[saveMarkedSessionIds] 写入失败:', err);
  }
}

// 消息条目（与后端 MessageEntry 对齐）
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

/** 从 MessageEntry.content 提取纯文本 */
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

//@C:F ID=F.CM.CliMenuManager;K=F;V=1.5;P=CLI 主菜单;D=CLI;M=cli;S=main;In=;Out=JSX.Element
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

  // 动态视口（默认优先使用环境变量，否则使用当前终端宽度并留一点余量）
  const VIEW_W = Number(process.env.CLI_VIEW_W || Math.min(terminalSize.columns, 96));
  const VIEW_H = Number(process.env.CLI_VIEW_H || terminalSize.rows);

  const [apiUrl, setApiUrl] = useState<string | null>(process.env.BASE_API_URL || null);
  const [stopIfLast, setStopIfLast] = useState<null | (() => Promise<void>)>(null);
  const [bootErr, setBootErr] = useState<string | null>(null);
  const { exit } = useApp();

  // 主题（全局 Hook）
  const [theme, setTheme] = useTheme();

  // 语言
  const [lang, setLang] = useState<Lang>('zh');
  const t = i18nMap[lang].menu;

  // 顶部时间
  const [nowStr, setNowStr] = useState<string>(new Date().toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false }));
  useEffect(() => {
    const id = setInterval(() => setNowStr(new Date().toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })), 1000);
    return () => clearInterval(id);
  }, [lang]);

  // 主菜单
  const [page, setPage] = useState<MenuKey | null>(null);
  const menuItems = useMemo(() => menuKeys.map(key => ({ label: t[key], value: key })), [t]);
  const [navIndex, setNavIndex] = useState(0);

  // 新建会话
  const [newSessionId, setNewSessionId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // 历史
  const [loadingHist, setLoadingHist] = useState(false);
  const [historyList, setHistoryList] = useState<any[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState<boolean>(false);
  const [histErr, setHistErr] = useState<string | null>(null);
  const [historyMenuStage, setHistoryMenuStage] = useState<'list'|'window'|'deleteConfirm'>('list');
  const [selectedHistory, setSelectedHistory] = useState<any|null>(null);

  // 历史-消息内容
  const [sessionMessages, setSessionMessages] = useState<MessageEntry[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [msgsErr, setMsgsErr] = useState<string | null>(null);
  const [msgsPage, setMsgsPage] = useState(0); // 0=最新页（底部），1=向上翻一页

  // 标记持久化
  const [markedSessionIds, setMarkedSessionIds] = useState<Set<string>>(new Set());

  // 设置页滚动偏移
  const [settingsOffset, setSettingsOffset] = useState(0);
  const [settingData, setSettingData] = useState<any>(null);
  const [loadingSetting, setLoadingSetting] = useState(false);
  const [setErr, setSetErr] = useState<string | null>(null);

  // 顶部工具栏状态
  const [animEnabled, setAnimEnabled] = useState(true);
  const [tipsEnabled, setTipsEnabled] = useState(true);

  // 帮助覆盖层
  const [showHelp, setShowHelp] = useState(false);

  // 快速恢复标志（R）
  const [quickResumeRequested, setQuickResumeRequested] = useState(false);

  // 计算视口
  const TOP_H = page === null ? TOP_H_HOME : TOP_H_COMPACT;
  const MID_H = Math.max(5, VIEW_H - TOP_H - BOTTOM_H);
  const MSGS_PAGE_SIZE = Math.max(1, MID_H - 2);
  const [expandMsgs, setExpandMsgs] = useState(false);
  // 配置就绪探测（用于避免 Logo 早期读取）
  const [configReady, setConfigReady] = useState(false);

  // 启动/复用本地唯一服务，并注入 apiUrl（含重试机制）
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (apiUrl) return;
      const entry = path.resolve(import.meta.dir, '../server/index.ts');
      const MAX_RETRIES = 3;
      const RETRY_DELAYS = [0, 2000, 5000]; // 首次无延迟，第2次2秒，第3次5秒
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (!mounted) return;
        if (attempt > 0) {
          setBootErr(`第 ${attempt} 次启动失败，${RETRY_DELAYS[attempt] / 1000}秒后重试...`);
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
        }
        if (!mounted) return;
        try {
          const handle = await ensureSingletonLocalServer({ serverEntry: entry });
          if (!mounted) { await handle.stopIfLast(); return; }
          setApiUrl(handle.baseUrl);
          setStopIfLast(() => handle.stopIfLast);
          setBootErr(null);
          return; // 成功，退出重试
        } catch (e: any) {
          if (attempt === MAX_RETRIES - 1) {
            setBootErr(e.message || '本地服务启动失败');
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

  // 初始化标记
  useEffect(() => {
    setMarkedSessionIds(loadMarkedSessionIds());
  }, []);

  // 页面切换复位
  useEffect(() => {
    if (page === 'newSession') {
      setNewSessionId(null);
      setCreating(false);
      setCreateErr(null);
    }
    if (page !== 'settings') {
      setSettingsOffset(0);
    }
    // 关闭帮助覆盖层
    setShowHelp(false);
  }, [page]);

  // 历史页进入复位
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

  // 创建会话
  const onCreateSession = async () => {
    setCreating(true); setCreateErr(null);
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
      const spawnArgs = isWin ? ['/c', 'start', 'cmd', '/k', 'bingocode'] : ['-c', `${binName}`];
      const spawnEnv = await buildSpawnEnv();
      spawn(spawnCmd, spawnArgs, {
        cwd: process.env.CALLER_DIR || process.cwd(),
        env: spawnEnv,
        detached: true,
        stdio: 'ignore'
      }).unref();
      setNewSessionId('CLI已启动: ' + binName);
    } catch(e: any) {
      setCreateErr(e.message || '新建失败');
    } finally {
      setCreating(false);
    }
  };

  // 历史分页加载
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
          setHistErr(e.message || '获取历史失败');
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
          if (!cancelled) setMsgsErr(e.message || '消息加载失败');
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

  // 设置页数据
  useEffect(() => {
    if (page === 'settings') {
      setLoadingSetting(true); setSetErr(null);
      (async () => {
        try {
          const data = (await import('../utils/settings/settings')).default;
          setSettingData(data);
        } catch(e: any) {
          setSetErr(e.message||'获取设置失败');
        } finally { setLoadingSetting(false); }
      })();
    } else {
      setSettingData(null);
      setLoadingSetting(false);
      setSetErr(null);
    }
  }, [page]);

  // 键盘交互
  useInput((input, key) => {
    // 语言切换
    if (input === 'l' || input === 'L') {
      setLang(l => (l === 'zh' ? 'en' : 'zh'));
      return;
    }

    // 主题切换（G）
    if ((input === 'g' || input === 'G')) {
      const order = ['light', 'dark', 'highContrast'] as const;
      const curr = String(theme || 'light');
      const idx = Math.max(0, order.indexOf(curr as any));
      const next = order[(idx + 1) % order.length];
      setTheme(next as any);
      try {
        const cfg = getGlobalConfig();
        cfg.theme = next as any;
        saveGlobalConfig(cfg);
      } catch {}
      return;
    }

    // 顶部动画开关（O）
    if (input === 'o' || input === 'O') {
      setAnimEnabled(v => !v);
      return;
    }
    // 顶部 Tips 开关（T）
    if (input === 't' || input === 'T') {
      setTipsEnabled(v => !v);
      return;
    }

    // 帮助覆盖层（?）
    if (input === '?') {
      setShowHelp(v => !v);
      return;
    }

    // ESC 返回主页面或关闭帮助
    if (key.escape) {
      if (showHelp) { setShowHelp(false); return; }
      if (page === 'provider') return; // provider 内部处理
      setPage(null);
      setHistoryMenuStage('list');
      setSelectedHistory(null);
      setHistoryCursor(null);
      setSessionMessages([]);
      setMsgsPage(0);
      setSettingsOffset(0);
      return;
    }

    // 快速入口：N 新建、R 恢复、P Provider
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

    // 主菜单左右移动
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

    // 历史页快捷键
    if (!showHelp && page === 'history') {
      if (historyMenuStage === 'list') {
        if (input === 'q') {
          setPage(null);
          setHistoryMenuStage('list');
          setSelectedHistory(null);
          setHistoryCursor(null);
          return;
        }
        if (input === 'j' && historyHasMore) {
          setHistoryCursor(historyList[historyList.length - 1]?.id || null);
          return;
        }
        if (input === 'k') {
          setHistoryCursor(null);
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
        // 消息滚动：↑/k 向上翻页，↓/j 向下翻页
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

    // 设置页滚动
    if (!showHelp && page === 'settings' && settingData && typeof settingData === 'object') {
      const total = Object.keys(settingData).length;
      const visible = Math.max(1, MID_H - 1);
      if (key.downArrow || input === 'j') {
        setSettingsOffset(o => Math.min(Math.max(0, total - visible), o + 1));
      }
      if (key.upArrow || input === 'k') {
        setSettingsOffset(o => Math.max(0, o - 1));
      }
    }
  }, [menuItems, page, historyMenuStage, historyList, historyHasMore, navIndex, sessionMessages, settingData, MID_H, MSGS_PAGE_SIZE, showHelp, theme]);

  function clampTextLines(text: string, maxWidth: number, maxLines: number) {
    const lines = String(text ?? '').split(/\r?\n/);
    const out: string[] = [];
    let used = 0;
    for (let i = 0; i < lines.length; i++) {
      if (out.length >= maxLines) break;
      const raw = lines[i];
      if (raw.length <= maxWidth) {
        out.push(raw);
      } else {
        out.push(ellipsis(raw, maxWidth));
      }
    }
    return out.join('\n');
  }

  // 新增：历史列表格式化（单行定宽 + 省略）
  function ellipsis(str: string, max: number) {
    const s = String(str ?? '');
    if (max <= 0) return '';
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)) + '…';
  }
  function makeHistoryLabel(item: any, width: number, isMarked: boolean) {
    const star = isMarked ? '★ ' : '';
    const ts = String(item.createdAt || '').slice(0, 16).replace('T',' ');
    const cnt = String(item.messageCount ?? 0).padStart(3, ' ');
    // 预留：前缀(星标+时间) + 双空格 + 末尾计数 + 单空格
    const reserved = star.length + ts.length + 2 + 1 + cnt.length;
    const titleMax = Math.max(8, width - reserved);
    const title = ellipsis(String(item.title || ''), titleMax).padEnd(titleMax, ' ');
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
    for (const item of historyList) {
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
      ...groupToItems(today, '—— 今天 ——'),
      ...groupToItems(week, '—— 本周 ——'),
      ...groupToItems(earlier, '—— 更早 ——'),
    ];
    return items;
  }, [historyList, markedSessionIds]);

  // 标记切换
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


  // 刷新历史
  const refreshHistoryList = () => {
    setLoadingHist(true); setHistErr(null);
    let url = apiUrl + '/api/sessions';
    axios.get(url).then(res => {
      const pageData = res.data;
      setHistoryList(pageData?.sessions || []);
      setHistoryCursor(pageData?.first_id || null);
      setHistoryHasMore(!!pageData?.has_more);
    }).catch(e => {
      setHistErr(e.message || '获取历史失败');
    }).finally(() => setLoadingHist(false));
  };

  // 删除会话
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

  // 二级菜单（底栏右侧）
  const secondaryMenu: SecondaryMenu = useMemo(() => {
    if (page === 'history' && historyMenuStage === 'window' && selectedHistory) {
      const isMarked = markedSessionIds.has(selectedHistory.id);
      const markLabel = isMarked ? i18nMap[lang].unmark : i18nMap[lang].mark;
      return {
        title: lang === 'zh' ? '会话操作' : 'Session Actions',
        items: [
          { label: markLabel, value: '__toggle_mark' },
          { label: '→ 继续会话聊天', value: '__continue' },
          { label: '→ 删除会话聊天', value: '__delete' },
          { label: '← 返回历史列表', value: '__back' },
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
        title: lang === 'zh' ? '删除确认' : 'Confirm Delete',
        items: [
          { label: lang === 'zh' ? '是，确认删除' : 'Yes, delete', value: '__confirm_delete' },
          { label: lang === 'zh' ? '否，返回详情' : 'No, back', value: '__cancel_delete' },
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

  // 帮助覆盖层
  function renderHelpOverlay() {
    return (
      <Box width={VIEW_W} height={MID_H} flexDirection="column">
        <Text color="magenta">{i18nMap[lang].helpTitle}</Text>
        <Text> </Text>
        <Text color="cyan">N</Text><Text>  新建会话 / New Session</Text>
        <Text color="cyan">R</Text><Text>  快速恢复最近会话 / Quick Resume</Text>
        <Text color="cyan">P</Text><Text>  打开 Provider 管理 / Open Provider</Text>
        <Text color="cyan">G</Text><Text>  切换主题（light/dark/highContrast）</Text>
        <Text color="cyan">L</Text><Text>  中英切换 / Toggle Language</Text>
        <Text color="cyan">O</Text><Text>  切换顶部动画开关（显示用）</Text>
        <Text color="cyan">T</Text><Text>  切换顶部 Tips 开关（显示用）</Text>
        <Text color="cyan">?</Text><Text>  打开/关闭此帮助</Text>
        <Text> </Text>
        <Hint>{lang==='zh' ? 'ESC 关闭 · 在任意页面可用' : 'ESC to close · Works anywhere'}</Hint>
      </Box>
    );
  }

  // 中心内容渲染
  function renderCenter() {
    if (showHelp) return renderHelpOverlay();

    // 首页：默认显示欢迎页图像，水平居中（WelcomeV2 固定 58 字符宽）
    if (page === null) {
      // 首页 Panel 无边框无 padding，内容区宽 = VIEW_W = 96
      // WelcomeV2 宽 58，左偏移 = floor((96 - 58) / 2) = 19
      const WELCOME_W = 58;
      const leftPad = Math.max(0, Math.floor((VIEW_W - WELCOME_W) / 2));
      return (
        <Box flexDirection="column" width={VIEW_W} height={MID_H}>
          <Box flexDirection="row" width={VIEW_W} flexGrow={1}>
            <Box width={leftPad} flexShrink={0} />
            <WelcomeV2 />
          </Box>
          {!apiUrl && !bootErr && (
            <Text color="yellow">⏳ 服务启动中...</Text>
          )}
          {bootErr && (
            <Text color="red">服务启动失败: {bootErr}</Text>
          )}
        </Box>
      );
    }

    // 新建
    if (page === 'newSession') {
      return (
        <Box flexDirection="column" width={VIEW_W} height={MID_H}>
          {creating && <Text color="yellow">新建中...</Text>}
          {createErr && <Text color="red">新建失败: {createErr}</Text>}
          {newSessionId && <Text color="green">新建会话: {newSessionId}</Text>}
          {!creating && !createErr && !newSessionId && <Text dimColor>已进入新建会话页，等待创建结果...</Text>}
        </Box>
      );
    }

    // 历史
    if (page === 'history') {
      if (histErr) return <Box width={VIEW_W} height={MID_H}><Text color="red">{histErr}</Text></Box>;
      if (historyMenuStage === 'deleteConfirm' && selectedHistory) {
        const halfH = Math.floor(MID_H / 2);
        const items = [
          { label: lang === 'zh' ? '是，确认删除' : 'Yes, delete', value: '__confirm_delete' },
          { label: lang === 'zh' ? '否，返回详情' : 'No, back', value: '__cancel_delete' },
        ];
        return (
          <Box width={VIEW_W} height={MID_H} flexDirection="column">
            <Box height={halfH} flexDirection="column">
              <Text color="red">{i18nMap[lang].deleting}</Text>
              <Text>id: {selectedHistory.id}</Text>
              <Text>标题: {selectedHistory.title}</Text>
              <Text>创建时间: {selectedHistory.createdAt}</Text>
            </Box>
            <Box height={MID_H - halfH} flexDirection="column" borderStyle="round" borderColor="red" paddingLeft={1} paddingRight={1}>
              <Text>{lang === 'zh' ? '删除确认' : 'Confirm Delete'}</Text>
              <SelectInput
                items={items}
                onSelect={(item) => handleHistoryMenuAction(String(item.value))}
              />
              <Hint>↩ 执行 · q 返回</Hint>
            </Box>
          </Box>
        );
      }
      if (!historyList.length && loadingHist) {
        return <Box width={VIEW_W} height={MID_H}><Text color="yellow">加载中...</Text></Box>;
      }
      if (!historyList.length) {
        return <Box width={VIEW_W} height={MID_H}><Text dimColor>{i18nMap[lang].emptyHistory}</Text></Box>;
      }

      if (historyMenuStage === 'window' && selectedHistory) {
        const isMarked = markedSessionIds.has(selectedHistory.id);

        // ── 信息栏高度固定 3 行（标题 + 元信息 + 提示） ──
        const INFO_H = 3;
        const MSGS_H = Math.max(3, MID_H - INFO_H);

        // ── 过滤出可展示的消息（user / assistant / system，跳过 tool_use / tool_result） ──
        const displayMsgs = sessionMessages.filter(
          m => m.type === 'user' || m.type === 'assistant' || m.type === 'system'
        );

        // ── 分页：每页 MSGS_PAGE_SIZE 条消息 ──
        const totalPages = Math.max(1, Math.ceil(displayMsgs.length / MSGS_PAGE_SIZE));
        const safePage = Math.min(msgsPage, totalPages - 1);
        const pageStart = safePage * MSGS_PAGE_SIZE;
        const pageMsgs = displayMsgs.slice(pageStart, pageStart + MSGS_PAGE_SIZE);

        return (
          <Box width={VIEW_W} height={MID_H} flexDirection="column">
            {/* ── 顶部信息栏 ── */}
            <Box height={INFO_H} flexDirection="column">
              <Text color={isMarked ? 'yellow' : 'cyan'}>
                {isMarked ? '★ ' : ''}{selectedHistory.title || 'Untitled'}
                <Text dimColor>  {selectedHistory.createdAt?.slice(0, 16).replace('T', ' ') || ''} · {displayMsgs.length} msgs</Text>
              </Text>
              <Hint>
                j/↓ 下翻 · k/↑ 上翻 · m 标记 · c 继续 · d 删除 · q 返回
                {displayMsgs.length > MSGS_PAGE_SIZE ? `  [${safePage + 1}/${totalPages}]` : ''}
              </Hint>
            </Box>

            {/* ── 消息区 ── */}
            <Box height={MSGS_H} flexDirection="column">
              {loadingMsgs && <Text color="yellow">加载消息中...</Text>}
              {msgsErr && <Text color="red">错误: {msgsErr}</Text>}
              {!loadingMsgs && !msgsErr && displayMsgs.length === 0 && (
                <Text dimColor>无消息记录</Text>
              )}
              {pageMsgs.map((msg) => {
                const text = extractTextFromContent(msg.content);
                if (!text.trim()) return null;
                const isUser = msg.type === 'user';
                const isSystem = msg.type === 'system';
                const roleLabel = isUser ? '👤 You' : isSystem ? '⚙ System' : '🤖 Assistant';
                const roleColor = isUser ? 'green' : isSystem ? 'gray' : 'cyan';
                return (
                  <Box key={msg.id} flexDirection="column" marginBottom={1}>
                    <Text color={roleColor} bold>{roleLabel}</Text>
                    {isUser ? (
                      <Text>{text}</Text>
                    ) : (
                      <Ansi>{applyMarkdown(text, theme)}</Ansi>
                    )}
                  </Box>
                );
              })}
            </Box>
          </Box>
        );
      }


      // 历史列表
      return (
        <Box width={VIEW_W} height={MID_H} flexDirection="column">
          <SelectInput
            key={`${historyCursor ?? 'first'}:${groupedHistoryItems.length}`}
            items={groupedHistoryItems}
            onSelect={item => {
              if (String(item.value).startsWith('__group_')) return; // 忽略分组标题选择
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
                <Text color={isGroup ? 'gray' : (color ? color : (isSelected ? 'cyan' : undefined))}>
                  {label}
                </Text>
              )
            }}
          />
          <Hint>{i18nMap[lang].historyHint}</Hint>
        </Box>
      );
    }

    // Provider
    if (page === 'provider') {
      if (!apiUrl) {
        return (
          <Box width={VIEW_W} height={MID_H} flexDirection="column">
            <Text color="yellow">{bootErr ? `服务启动失败: ${bootErr}` : '⏳ 服务启动中，请稍候...'}</Text>
            <Text dimColor>ESC 返回主菜单</Text>
          </Box>
        );
      }
      return (
        <Box width={VIEW_W} height={MID_H} flexDirection="column">
          <ProviderPanel apiUrl={apiUrl} onBack={() => setPage(null)} />
        </Box>
      );
    }

    // 设置
    if (page === 'settings') {
      if (loadingSetting) return <Box width={VIEW_W} height={MID_H}><Text color="yellow">加载设置中...</Text></Box>;
      if (setErr) return <Box width={VIEW_W} height={MID_H}><Text color="red">{setErr}</Text></Box>;
      if (!settingData || typeof settingData !== 'object') return <Box width={VIEW_W} height={MID_H}><Text dimColor>暂无设置项</Text></Box>;
      const entries = Object.entries(settingData);
      const visible = Math.max(1, MID_H - 1);
      const start = Math.min(settingsOffset, Math.max(0, entries.length - visible));
      const sliced = entries.slice(start, start + visible);
      return (
        <Box width={VIEW_W} height={MID_H} flexDirection="column">
          {sliced.map(([k, v]) => <Text key={k}>{k}: {typeof v === 'object' ? JSON.stringify(v) : String(v)}</Text>)}
          <Hint>
            {lang==='zh' ? '↑/k 与 ↓/j 滚动' : '↑/k and ↓/j to scroll'} · {start+1}-{Math.min(start+visible, entries.length)}/{entries.length}
          </Hint>
        </Box>
      );
    }

    // 关于
    if (page === 'about') {
      return (
        <Box width={VIEW_W} height={MID_H} flexDirection="column">
          <Text>{i18nMap[lang].about}</Text>
          <Hint>
            {lang==='zh' ? 'API 地址' : 'API Base'}: {apiUrl}
          </Hint>
        </Box>
      );
    }

    // 退出
    if (page === 'exit') {
      exit();
      return <Box width={VIEW_W} height={MID_H}><Text>退出...</Text></Box>;
    }

    return <Box width={VIEW_W} height={MID_H} />;
  }

  // 退出逻辑
  if (terminalSize.columns < 60 || terminalSize.rows < 15) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text color="red">终端窗口太小！ / Terminal too small!</Text>
        <Text>当前 / Current: {terminalSize.columns}x{terminalSize.rows}</Text>
        <Text>请调节窗口大小以继续... / Please resize to continue...</Text>
      </Box>
    );
  }

  // 根渲染：上-中-下三段
  return (
    <Box flexDirection="column" width={VIEW_W}>
      {/* 顶部欢迎/Logo区 + 工具栏 */}
      <TopBar
        ready={configReady}
        page={page}
        width={VIEW_W}
        height={TOP_H}
        homeLogo={<LogoV2 />}
        compactLogo={<CondensedLogo />}
        ip={apiUrl ? apiUrl.replace(/^https?:\/\//, '') : undefined}
        toolbar={
          <TopToolbar
            ready={configReady}
            page={page}
            animEnabled={animEnabled}
            tipsEnabled={tipsEnabled}
          />
        }
      />

      {/* 中心业务区（固定高度，内部处理分页/滚动）
          首页：无边框无 margin，WelcomeV2 直接撑满，避免 border 额外占行导致超出;
          其它页面：single border + marginY */}
      {page === null ? (
        <Panel width={VIEW_W} height={MID_H} noBorder paddingX={0} paddingY={0} marginY={0}>
          {renderCenter()}
        </Panel>
      ) : (
        <Panel width={VIEW_W} height={MID_H} borderStyle="single" paddingX={1} paddingY={0} marginY={1}>
          {renderCenter()}
        </Panel>
      )}

      {/* 底部菜单与二级菜单 */}
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