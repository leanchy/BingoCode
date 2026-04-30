//@C:M ID=M.UI.TopToolbar;K=M;V=1.2;P=top toolbar;D=CLI;M=cli;S=ui
import React, { memo, useMemo } from 'react';
import { Box } from 'ink';
import { Chip, ChipRow } from './CliMenuUi.tsx';
import { useTheme } from '../components/design-system/ThemeProvider.js';
import { getGlobalConfig, getCurrentProjectConfig, isPathTrusted, checkHasTrustDialogAccepted } from '../utils/config.ts';
import { getCwd } from '../utils/cwd.js';
// 更新：按新接口分别导入
import type { ClawdPose } from '../components/LogoV2/Clawd.tsx';
import { Clawd } from '../components/LogoV2/Clawd.tsx';
import { AnimatedClawd } from '../components/LogoV2/AnimatedClawd.tsx';

type Props = {
  ready: boolean;
  page: string | null;
  animEnabled: boolean;
  tipsEnabled: boolean;
};

function basename(p: string) {
  if (!p) return '';
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}
function ellipsisPath(p: string, keep = 2) {
  if (!p) return '';
  const parts = p.split(/[/\\]/).filter(Boolean);
  if (parts.length <= keep) return p;
  return '…/' + parts.slice(-keep).join('/');
}

//@C:F ID=F.UI.TopToolbar;K=F;V=1.2;P=toolbar;D=CLI;M=cli;S=ui;In=Props;Out=JSX.Element
export const TopToolbar: React.FC<Props> = memo(({ ready, page, animEnabled, tipsEnabled }) => {
  const [theme] = useTheme();

  // 仅在 ready 时读取配置与信任状态
  const { cwd, trustAccepted, trustedPath, projectName } = useMemo(() => {
    if (!ready) {
      return { cwd: '', trustAccepted: undefined as undefined|boolean, trustedPath: undefined as undefined|boolean, projectName: '' };
    }
    const _cwd = getCwd();
    const _trustAccepted = checkHasTrustDialogAccepted();
    const _trustedPath = isPathTrusted(_cwd);
    let _projectName = '';
    try {
      const prj = getCurrentProjectConfig();
      _projectName = (prj && (prj.name || prj.projectName || prj.id)) || basename(_cwd);
    } catch {
      _projectName = basename(_cwd);
    }
    return { cwd: _cwd, trustAccepted: _trustAccepted, trustedPath: _trustedPath, projectName: _projectName };
  }, [ready]);

  const compact = page !== null;
  const cwdShort = useMemo(() => ellipsisPath(cwd, compact ? 2 : 3), [cwd, compact]);

  // 主题名（仅在 ready 时访问全局配置）
  const themeLabel = String(theme || (ready ? (getGlobalConfig()?.theme ?? 'system') : '…'));

  // 静态小精灵姿态
  const clawdPose: ClawdPose = useMemo(() => {
    if (!ready) return 'default';
    if (page === null) return animEnabled ? 'arms-up' : 'default';
    return tipsEnabled ? 'look-left' : 'look-right';
  }, [ready, page, animEnabled, tipsEnabled]);

  const uiTone = (String(theme) === 'dark') ? 'accent' : (String(theme) === 'highContrast' ? 'warning' : 'info');

  return (
    <Box flexDirection="column" minHeight={3}>
      <ChipRow>
        {/* 左侧：小精灵 + 核心状态 */}
        <Box>
          <Box marginRight={2}>
            {animEnabled ? <AnimatedClawd /> : <Clawd pose={clawdPose} />}
          </Box>

          <Chip label="Theme" value={themeLabel} tone="accent" />
          <Chip label="Project" value={projectName || '—'} tone="info" />
          <Chip label="CWD" value={cwdShort || '—'} tone="subtle" />
          {trustedPath === undefined || trustAccepted === undefined ? (
            <Chip label="Trust" value="…" tone="subtle" />
          ) : trustedPath && trustAccepted ? (
            <Chip label="Trust" value="✅ Trusted" tone="success" />
          ) : (
            <Chip label="Trust" value="🔒 Untrusted" tone="warning" />
          )}
        </Box>

        {/* 右侧：UI 状态合并显示 */}
        <Box>
          <Chip
            label="UI"
            value={`Anim ${animEnabled ? 'On' : 'Off'} · Tips ${tipsEnabled ? 'On' : 'Off'}`}
            tone={uiTone as any}
          />
        </Box>
      </ChipRow>

      {!compact && (
        <ChipRow>
          <Box>
            <Chip label="Shortcuts" value="N New · R Resume · P Provider · G Theme · ? Help" tone="subtle" />
          </Box>
        </ChipRow>
      )}
    </Box>
  );
});

export default TopToolbar;