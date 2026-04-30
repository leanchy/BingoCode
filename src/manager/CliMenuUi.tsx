import React, { memo } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';

// 小工具
const repeatChar = (ch: string, n: number) => ch.repeat(Math.max(0, n));
// 按终端显示宽度截断（中文/全角字符占 2 列，ASCII 占 1 列）
const charDisplayWidth = (c: string) => c.charCodeAt(0) > 127 ? 2 : 1;
const displayWidth = (s: string) => [...s].reduce((acc, c) => acc + charDisplayWidth(c), 0);
const truncate = (s: string, maxCols: number) => {
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

// Kbd（去掉多余空格，保持紧凑视觉）
export const Kbd: React.FC<{ children: React.ReactNode }> = memo(({ children }) => (
  <Text color="black" backgroundColor="white">{String(children)}</Text>
));

// Hint（默认 dim）
export const Hint: React.FC<{ children: React.ReactNode; dim?: boolean }> = memo(({ children, dim = true }) => (
  <Text dimColor={dim}>{children}</Text>
));

// Title（保持可配置颜色）
export const Title: React.FC<{ children: React.ReactNode; color?: string }> = memo(({ children, color = 'magenta' }) => (
  <Text color={color}>{children}</Text>
));

// Divider（可根据宽度渲染，避免固定长度溢出）
export const Divider: React.FC<{ width?: number; pad?: boolean }> = memo(({ width, pad = false }) => {
  const line = width ? repeatChar('─', Math.max(0, width - (pad ? 2 : 0))) : '────────────────────────────────────────────────────────────────';
  return <Text dimColor>{pad ? ` ${line} ` : line}</Text>;
});

// Panel（更灵活，支持 title 插槽、最小/最大宽度，borderStyle=undefined 时无边框）
export const Panel: React.FC<{
  width?: number;
  height?: number;
  minWidth?: number;
  maxWidth?: number;
  borderStyle?: 'round' | 'single' | 'double' | 'bold' | 'classic' | undefined;
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
  // 只有明确传入 borderStyle 且未设置 noBorder 时才渲染边框
  if (!noBorder && borderStyle !== undefined) props.borderStyle = borderStyle;
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

// Fallback top（更紧凑）
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

// 类型
export type SecondaryMenuItem = { label: string; value: string };
export type SecondaryMenu = {
  title: string;
  items: SecondaryMenuItem[];
  onSelect: (item: SecondaryMenuItem) => void;
} | null;

// BottomBar（更紧凑的菜单显示、右侧提示会截断、secondary menu 宽度限制）
export const BottomBar: React.FC<{
  width?: number;
  height?: number;
  menuItems: { label: string; value: string }[];
  page: string | null;
  navIndex: number;
  tips: string;
  secondaryMenu: SecondaryMenu;
}> = memo(({ width = 60, height = 3, menuItems, page, navIndex, tips, secondaryMenu }) => {
  // 精确计算左侧菜单实际占用宽度：prefix(1) + 空格(1) + label + marginRight(2)
  // 中文字符宽度按 2 计算，ASCII 按 1 计算
  const charWidth = (s: string) => [...s].reduce((acc, c) => acc + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
  const leftActual = menuItems.reduce((acc, it) => acc + 1 + 1 + charWidth(it.label) + 2, 0);
  // Panel paddingX=1 占去两侧各1，Box width=width-2，左侧Box不设width（自然宽），右侧需要精确限制
  // 留出 4 字符作为两侧 padding 和分隔缓冲
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

// Chip（颜色语义，支持可选换行周边间距）
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

// ChipRow（支持换行和自动折叠）
export const ChipRow: React.FC<{ children: React.ReactNode }> = memo(({ children }) => (
  <Box flexDirection="row" flexWrap="wrap" alignItems="center">
    {children as any}
  </Box>
));

// TopBar（logo + 工具栏水平排列，增加 ready 状态与占位）
export const TopBar: React.FC<{
  ready: boolean;
  page: string | null;
  width?: number;
  height?: number;
  homeLogo: React.ReactNode;
  compactLogo: React.ReactNode;
  toolbar?: React.ReactNode;
  ip?: string;
}> = memo(({ ready, page, width = 80, height = 5, homeLogo, compactLogo, toolbar, ip }) => (
  <Panel width={width} height={height} borderStyle="round" paddingX={1} paddingY={0}>
    <Box width={width - 2} flexDirection="row" justifyContent="space-between" alignItems="center">
      <Box>
        {ready ? (page === null ? homeLogo : compactLogo) : <FallbackTop ip={ip} />}
      </Box>
      {toolbar ? <Box>{toolbar}</Box> : <Box><Hint dim>{ready ? '' : '…'}</Hint></Box>}
    </Box>
  </Panel>
));

// InfoPair（label 固定宽度，便于列对齐）
export const InfoPair: React.FC<{ label: string; value: string; labelColor?: string; valueColor?: string; labelWidth?: number }> = memo(({
  label,
  value,
  labelColor = 'gray',
  valueColor,
  labelWidth = 12
}) => {
  const paddedLabel = label.padEnd(labelWidth, ' ');
  return (
    <Text>
      <Text color={labelColor}>{paddedLabel} </Text>
      <Text color={valueColor}>{value}</Text>
    </Text>
  );
});

export default {
  Kbd, Hint, Title, Divider, Panel, FallbackTop, TopBar, BottomBar, Chip, ChipRow, InfoPair
};