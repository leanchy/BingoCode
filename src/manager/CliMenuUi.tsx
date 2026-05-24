import React, { memo } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';

// Utils
const repeatChar = (ch: string, n: number) => ch.repeat(Math.max(0, n));
// Truncate by terminal display width
const charDisplayWidth = (c: string) => c.charCodeAt(0) > 127 ? 2 : 1;
const displayWidth = (s: string) => [...s].reduce((acc, c) => acc + charDisplayWidth(c), 0);
export const truncate = (s: string, maxCols: number) => {
  let cols = 0;
  let out = '';
  for (const c of s) {
    const w = charDisplayWidth(c);
    if (cols + w > maxCols - 1) return out + '…';
    out += c;
    cols += w;
  }
  return out;
};

/**
 * Padds a string to a target width, accounting for CJK characters.
 */
export const safePadEnd = (s: string, targetWidth: number, fillChar = ' ') => {
  const currentWidth = displayWidth(s);
  if (currentWidth >= targetWidth) return s;
  return s + fillChar.repeat(targetWidth - currentWidth);
};

// Kbd (keep compact visual)
export const Kbd: React.FC<{ children: React.ReactNode }> = memo(({ children }) => (
  <Text color="black" backgroundColor="white">{String(children)}</Text>
));

// Hint (default dim)
export const Hint: React.FC<{ children: React.ReactNode; dim?: boolean }> = memo(({ children, dim = true }) => (
  <Text dimColor={dim}>{children}</Text>
));

// Title (keep configurable color)
export const Title: React.FC<{ children: React.ReactNode; color?: string }> = memo(({ children, color = 'magenta' }) => (
  <Text color={color}>{children}</Text>
));

// Divider (avoid fixed length overflow)
export const Divider: React.FC<{ width?: number; pad?: boolean }> = memo(({ width = 80, pad = false }) => {
  const actualWidth = Math.max(10, width - (pad ? 2 : 0));
  const line = '─'.repeat(actualWidth);
  return <Text dimColor>{pad ? ` ${line} ` : line}</Text>;
});

// Panel (flexbox-based layout, supports title slot/min-max width)
export const Panel: React.FC<{
  width?: number;
  height?: number;
  minWidth?: number;
  maxWidth?: number;
  borderStyle?: 'round' | 'single' | 'double' | 'bold' | 'classic' | undefined;
  borderColor?: string;
  noBorder?: boolean;
  paddingX?: number;
  paddingY?: number;
  marginY?: number;
  title?: React.ReactNode;
  children: React.ReactNode;
}> = memo(({
  width,
  height,
  minWidth,
  maxWidth,
  borderStyle,
  borderColor = 'gray',
  noBorder = false,
  paddingX = 1,
  paddingY = 0,
  marginY = 0,
  title,
  children
}) => {
  const props: any = {
    paddingX,
    paddingY,
    marginY,
    flexDirection: 'column',
  };
  // Render border only if borderStyle is defined and noBorder is false
  if (!noBorder && borderStyle !== undefined) {
    props.borderStyle = borderStyle;
    props.borderColor = borderColor;
  }
  if (typeof width === 'number') props.width = width;
  if (typeof height === 'number') props.height = height;
  if (typeof minWidth === 'number') props.minWidth = minWidth;
  if (typeof maxWidth === 'number') props.maxWidth = maxWidth;

  return (
    <Box {...props}>
      {title ? <Box marginBottom={1} justifyContent="center">{title}</Box> : null}
      <Box flexDirection="column" flexGrow={1}>{children}</Box>
    </Box>
  );
});

// StateDisplay (Standardized loading/error/empty state)
export const StateDisplay: React.FC<{
  type: 'loading' | 'error' | 'empty';
  message?: string;
  onRetry?: () => void;
}> = memo(({ type, message, onRetry }) => {
  const configs = {
    loading: { icon: '⏳', color: 'yellow', defaultMsg: 'Loading...' },
    error: { icon: '❌', color: 'red', defaultMsg: 'Error occurred' },
    empty: { icon: '📭', color: 'gray', defaultMsg: 'No data' },
  };
  const { icon, color, defaultMsg } = configs[type];
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Text color={color}>{icon} {message || defaultMsg}</Text>
      {type === 'error' && onRetry && (
        <Box marginTop={1}>
          <Text dimColor>Press </Text>
          <Kbd>R</Kbd>
          <Text dimColor> to retry</Text>
        </Box>
      )}
    </Box>
  );
});

// ScrollBar (Simple ASCII scrollbar)
export const ScrollBar: React.FC<{
  total: number;
  offset: number;
  height: number;
}> = memo(({ total, offset, height }) => {
  if (total <= height) return null;
  const progress = offset / (total - height);
  const thumbPos = Math.floor(progress * (height - 1));

  const bar = Array.from({ length: height }, (_, i) => (i === thumbPos ? '█' : '┃'));

  return (
    <Box flexDirection="column" position="absolute" right={0}>
      {bar.map((char, i) => (
        <Text key={i} dimColor>{char}</Text>
      ))}
    </Box>
  );
});

// Fallback top (compact)
export const FallbackTop = memo(({ ip }: { ip?: string }) => (
  <Box flexDirection="column">
    <Text>Welcome Bingo Code</Text>
    {ip ? (
      <Text color="green">IP:{ip}</Text>
    ) : (
      <>
        <Text color="yellow">Server is starting, please do not close.</Text>
        <Text dimColor>Initializing config...</Text>
      </>
    )}
  </Box>
));

// Types
export type SecondaryMenuItem = { label: string; value: string };
export type SecondaryMenu = {
  title: string;
  items: SecondaryMenuItem[];
  onSelect: (item: SecondaryMenuItem) => void;
} | null;

// BottomBar (Compact menu display, right side hints truncated, secondary menu width limited)
export const BottomBar: React.FC<{
  width: number;
  height?: number;
  menuItems: { label: string; value: string }[];
  page: string | null;
  navIndex: number;
  tips: string;
  secondaryMenu: SecondaryMenu;
}> = memo(({ width, height = 3, menuItems, page, navIndex, tips, secondaryMenu }) => {
  // Calculate left menu actual display width
  const leftActual = menuItems.reduce((acc, it) => acc + 1 + 1 + displayWidth(it.label) + 2, 0);
  // Panel paddingX=1, Box width=width-2. Left box is natural width, right needs precise limit.
  // Leave 4 characters for padding and separator buffer.
  const rightSpace = Math.max(10, width - 4 - leftActual - 2);
  return (
    <Panel width={width} height={height} borderStyle="round" paddingX={1} paddingY={0}>
      <Box width={width - 4} justifyContent="space-between" alignItems="center">
        <Box flexShrink={1}>
          {menuItems.map((it, idx) => {
            const isActive = page === it.value;
            const isCursor = page === null && navIndex === idx;
            const prefix = isActive ? '●' : isCursor ? '›' : ' ';
            const color = isActive ? 'green' : isCursor ? 'cyan' : undefined;
            return (
              <Box key={it.value} marginRight={2}>
                <Text color={color}>{prefix} {it.label}</Text>
              </Box>
            );
          })}
        </Box>

        <Box width={rightSpace} flexShrink={0} justifyContent="flex-end">
          {secondaryMenu ? (
            <Box flexDirection="column" alignItems="flex-end">
              <Text color="magenta">{secondaryMenu.title}</Text>
              <Box marginTop={-1}>
                <SelectInput
                  items={secondaryMenu.items}
                  isFocused={true}
                  onSelect={(item: any) => secondaryMenu.onSelect(item)}
                />
              </Box>
            </Box>
          ) : (
            <Hint>{truncate(tips, Math.max(10, rightSpace - 2))}</Hint>
          )}
        </Box>
      </Box>
    </Panel>
  );
});

// Chip (Semantic colors, support optional margin)
export const Chip: React.FC<{
  label: string;
  value?: string | number;
  tone?: 'accent'|'info'|'success'|'warning'|'danger'|'subtle';
  dim?: boolean;
}> = memo(({ label, value, tone = 'info', dim = false }) => {
  const colorMap = {
    accent: 'magenta',
    info: 'cyan',
    success: 'green',
    warning: 'yellow',
    danger: 'red',
    subtle: 'gray',
  } as const;
  const color = colorMap[tone];
  const text = value !== undefined ? `${label}: ${String(value)}` : label;
  return (
    <Box marginRight={1} marginTop={0}>
      <Text color={color} dimColor={dim}>[{text}]</Text>
    </Box>
  );
});

// ChipRow (Support wrap and auto fold)
export const ChipRow: React.FC<{ children: React.ReactNode }> = memo(({ children }) => (
  <Box flexDirection="row" flexWrap="wrap" alignItems="center">
    {children as any}
  </Box>
));

// TopBar (full-width toolbar, no separate logo slot)
export const TopBar: React.FC<{
  ready: boolean;
  page: string | null;
  width?: number;
  height?: number;
  homeLogo?: React.ReactNode;
  compactLogo?: React.ReactNode;
  toolbar?: React.ReactNode;
  ip?: string;
}> = memo(({ width = 80, height = 5, toolbar }) => (
  <Panel width={width} height={height} borderStyle="round" paddingX={1} paddingY={0}>
    <Box width={width - 4} flexDirection="row" alignItems="flex-start">
      {toolbar ?? null}
    </Box>
  </Panel>
));

// InfoPair (Label fixed width for column alignment)
export const InfoPair: React.FC<{ label: string; value: string; labelColor?: string; valueColor?: string; labelWidth?: number }> = memo(({
  label,
  value,
  labelColor = 'gray',
  valueColor,
  labelWidth = 12
}) => {
  const paddedLabel = safePadEnd(label, labelWidth);
  return (
    <Text>
      <Text color={labelColor}>{paddedLabel} </Text>
      <Text color={valueColor}>{value}</Text>
    </Text>
  );
});

export default {
  Kbd, Hint, Title, Divider, Panel, FallbackTop, TopBar, BottomBar, Chip, ChipRow, InfoPair, safePadEnd, truncate
};