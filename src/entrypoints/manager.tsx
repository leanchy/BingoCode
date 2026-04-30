/**
 * Bingo Manager 入口
 * 直接渲染 CliMenuManager（窗口管理控制台），不走 cli.tsx 的完整启动流程。
 * 由 bin/bingo-win.cjs 和 bin/bingo 调用。
 */
import React from 'react';
import { render } from 'ink';
import { CliMenuManager } from '../manager/CliMenuManager.tsx';

render(<CliMenuManager />);
