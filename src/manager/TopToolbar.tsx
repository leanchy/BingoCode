//@C:M ID=M.UI.TopToolbar;K=M;V=1.3;P=top toolbar;D=CLI;M=cli;S=ui
import React, { memo, useMemo } from 'react';
import { Box, Text } from 'ink';
import { Chip } from './CliMenuUi.tsx';
import { useTheme } from '../components/design-system/ThemeProvider.js';
import { getGlobalConfig } from '../utils/config.ts';
import type { ClawdPose } from '../components/LogoV2/Clawd.tsx';
import { Clawd } from '../components/LogoV2/Clawd.tsx';
import { AnimatedClawd } from '../components/LogoV2/AnimatedClawd.tsx';

type Props = {
  ready: boolean;
  page: string | null;
  animEnabled: boolean;
  tipsEnabled: boolean;
  ip?: string;
};

//@C:F ID=F.UI.TopToolbar;K=F;V=1.4;P=toolbar;D=CLI;M=cli;S=ui;In=Props;Out=JSX.Element
export const TopToolbar: React.FC<Props> = memo(({ ready, page, animEnabled, tipsEnabled, ip }) => {
  const [theme] = useTheme();

  const { version } = useMemo(() => {
    try {
      const cfg = getGlobalConfig();
      return { version: (cfg as any)?.version ?? '' };
    } catch {
      return { version: '' };
    }
  }, []);

  const themeLabel = String(theme || (ready ? (getGlobalConfig()?.theme ?? 'system') : '…'));
  const uiChipValue = `Anim ${animEnabled ? 'On' : 'Off'} · Tips ${tipsEnabled ? 'On' : 'Off'}`;
  const uiTone = (String(theme) === 'dark') ? 'accent' : (String(theme) === 'highContrast' ? 'warning' : 'info');

  const clawdPose: ClawdPose = useMemo(() => {
    if (!ready) return 'default';
    if (page === null) return animEnabled ? 'arms-up' : 'default';
    return tipsEnabled ? 'look-left' : 'look-right';
  }, [ready, page, animEnabled, tipsEnabled]);

  // ── Compact mode (page !== null): single line, no logo ──────────────
  if (page !== null) {
    return (
      <Box flexDirection="row" alignItems="center">
        <Text bold>Bingo Code</Text>
        <Box marginLeft={1}>
          <Chip label="Theme" value={themeLabel} tone="accent" />
        </Box>
        <Chip label="UI" value={uiChipValue} tone={uiTone as any} />
        {ip ? (
          <Text color="green" dimColor> · IP: {ip}</Text>
        ) : (
          <Text color="yellow" dimColor> · {ready ? 'Server ready' : 'Starting…'}</Text>
        )}
      </Box>
    );
  }

  // ── Home mode (page === null): Clawd left + 3-row right column ───────
  return (
    <Box flexDirection="row" alignItems="flex-start">
      {/* Left: Clawd sprite */}
      <Box marginRight={2}>
        {animEnabled ? <AnimatedClawd /> : <Clawd pose={clawdPose} />}
      </Box>

      {/* Right: 3 rows */}
      <Box flexDirection="column">
        {/* Row 1: brand + version + chips */}
        <Box flexDirection="row" alignItems="center">
          <Text bold>Welcome to Bingo Code</Text>
          {version ? <Text dimColor> v{version}</Text> : null}
          <Box marginLeft={1}>
            <Chip label="Theme" value={themeLabel} tone="accent" />
          </Box>
          <Chip label="UI" value={uiChipValue} tone={uiTone as any} />
        </Box>

        {/* Row 2: IP / server status */}
        <Box>
          {ip ? (
            <Text color="green" dimColor>IP: {ip}</Text>
          ) : (
            <Text color="yellow" dimColor>{ready ? 'Server ready' : 'Starting server…'}</Text>
          )}
        </Box>

        {/* Row 3: keyboard shortcuts */}
        <Box>
          <Text dimColor>N New · R Resume · P Provider · G Theme · ? Help</Text>
        </Box>
      </Box>
    </Box>
  );
});

export default TopToolbar;
