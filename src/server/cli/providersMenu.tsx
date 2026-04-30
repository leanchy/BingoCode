import React, { useEffect, useState } from 'react';
import { render, Box, Text, useApp, useInput, Newline } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import { ProviderManager } from './providerManager';
import { SavedProvider, CreateProviderInput, UpdateProviderInput } from './types';
import chalk from 'chalk';

type UiMode = 'list'|'add'|'editKey'|'removeConfirm'|'detail'|'applyPreset';

const emptyInput: CreateProviderInput = {
  presetId: '',
  name: '',
  apiKey: '',
  baseUrl: '',
  apiFormat: 'anthropic',
  models: { main: '', haiku: '', sonnet: '', opus: '' }
};

const MODEL_OPTIONS = [
  'claude-opus-4','claude-opus-4.1','claude-opus-4.5','claude-opus-4.6','claude-opus-latest',
  'claude-sonnet-4','claude-sonnet-4.5','claude-sonnet-4.6','claude-sonnet-latest',
  'deepseek-v3','gemini-3-flash-preview','gemini-3.1-flash-lite-preview','gemini-3.1-pro-preview',
  'gpt-4.1','gpt-4.1-mini','gpt-4.1-nano','gpt-4o','gpt-4o-mini','gpt-5','gpt-5.1',
  'qwen3-coder','qwen3-max'
];

const FIXED_BASEURL = 'https://mlaas.games.com/proxy/openai';
const FIXED_APIFMT = 'openai_chat';

const ProvidersMenu: React.FC = () => {
  const { exit } = useApp();
  const [modelSelectIdx, setModelSelectIdx] = useState(0);
  const [addStep, setAddStep] = useState(0); // 0:选模型, 1:填key
  const [inputKey, setInputKey] = useState('');
  const [addError, setAddError] = useState('');
  const [mode, setMode] = useState<UiMode>('list');
  const [list, setList] = useState<SavedProvider[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [editKey, setEditKey] = useState('');
  const [removeConfirm, setRemoveConfirm] = useState(false);
  // 新增
  const [msg, setMsg] = useState<string>('');
  const [detail, setDetail] = useState<SavedProvider | null>(null);
  const [presets, setPresets] = useState<any[]>([]);
  useEffect(() => { ProviderManager.listPresets().then(setPresets).catch(()=>setPresets([])); }, []);

  const refresh = async () => {
    const providers = await ProviderManager.listProviders();
    const current = await ProviderManager.getCurrentProvider();
    setList(providers);
    setActiveId(current ? current.id : null);
  };
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    if (mode !== 'add') { setAddStep(0); setInputKey(''); setAddError(''); setModelSelectIdx(0); }
  }, [mode]);

  // 主界面 LIST 模式
  useInput((inputKey, key) => {
    if (mode === 'list') {
      if (key.downArrow) setSelectedIdx(i => Math.min(list.length - 1, i + 1));
      else if (key.upArrow) setSelectedIdx(i => Math.max(0, i - 1));
      else if (inputKey === 'q') exit();
      else if (inputKey === 's') {
        if (list[selectedIdx]) ProviderManager.setCurrentProvider(list[selectedIdx].id).then(() => { setActiveId(list[selectedIdx].id); refresh(); });
      }
      else if (inputKey === 'n') { setMode('add'); }
      else if (inputKey === 'e') { setEditKey(''); setMode('editKey'); }
      else if (inputKey === 'd') { setRemoveConfirm(true); setMode('removeConfirm'); }
      else if (key.return) { const cur = list[selectedIdx]; if (cur) { setDetail(cur); setMode('detail'); setMsg(''); } }
      else if (inputKey === 'p') { setMode('applyPreset'); }
    } else if (mode === 'removeConfirm') {
      if (inputKey.toLowerCase() === 'y') {
        const delId = list[selectedIdx]?.id;
        if (delId) {
          ProviderManager.removeProvider(delId).then(() => {
            setRemoveConfirm(false); setMode('list');
            setSelectedIdx(idx => Math.max(0, Math.min(idx, list.length - 2)));
            setDetail(null);
            refresh();
          });
        }
      } else if (inputKey.toLowerCase() === 'q' || key.escape) {
        setRemoveConfirm(false); setMode('list');
      }
    }
  }, { isActive: mode === 'list' || mode === 'removeConfirm' });

  // ADD模式交互
  useInput((inputKey, key) => {
    if (mode !== 'add') return;
    // 全局返回
    if (inputKey === 'q' || key.escape) {
      setMode('list'); setAddError(''); setInputKey(''); setAddStep(0);
      return;
    }
    // 步骤0: 主模型选择
    if (addStep === 0) {
      if (key.downArrow) setModelSelectIdx(idx => Math.min(MODEL_OPTIONS.length - 1, idx + 1));
      else if (key.upArrow) setModelSelectIdx(idx => Math.max(0, idx - 1));
      else if (key.return) { setAddStep(1); }
    }
  }, { isActive: mode === 'add' });

  // 新增表单
  const addSubmit = async (keyInput: string) => {
    const selectedModel = MODEL_OPTIONS[modelSelectIdx];
    const presetId = selectedModel.replace(/[^a-zA-Z0-9]/g, '') + '-preset';
    const name = `${selectedModel} Provider`;
    if (!keyInput.trim()) { setAddError('API Key 不能为空'); return; }
    const exists = (await ProviderManager.listProviders()).some(p => p.id === presetId);
    if (exists) { setAddError('该模型已添加过，如要更换Key请在列表编辑。'); return; }
    setAddError('');
    // 支持预设覆盖
    const overrideBase = (global as any).__PM_BASEURL_OVERRIDE__ || FIXED_BASEURL;
    const overrideFmt = (global as any).__PM_APIFMT_OVERRIDE__ || FIXED_APIFMT;
    await ProviderManager.addProvider({
      presetId, name, apiKey: keyInput.trim(),
      baseUrl: overrideBase, apiFormat: overrideFmt,
      models: { main: selectedModel, haiku: '', sonnet: '', opus: '' }
    });
    delete (global as any).__PM_BASEURL_OVERRIDE__;
    delete (global as any).__PM_APIFMT_OVERRIDE__;
    setMode('list');
    setAddStep(0);
    setInputKey('');
    refresh();
  };

  // UI
  return (
    <Box flexDirection="column" margin={1}>
      <Text bold color="cyan">Provider 管理器 ↑↓切换 s激活 n新增 e编辑Key d删除 q退出</Text>
      <Text color="cyan">APIKey获取链接：https://mlaas.games.com/auth/token</Text>
      <Newline />
      {/* 列表 */}
      {mode === 'list' && (list.length === 0 ?
        <Text color="gray">无 provider，请按 n 新建…</Text> :
        list.map((p, idx) => (
          <Box key={p.id}>
            <Text>
              {selectedIdx === idx
                ? chalk.bgHex('#ffc300').black(`> ${p.name.padEnd(18)} ${p.baseUrl}`)
                : `  ${p.name.padEnd(18)} ${p.baseUrl}`}
              {activeId === p.id ? chalk.green(' [当前]') : ''}
            </Text>
          </Box>
        ))
      )}

      {/* 新增 */}
      {mode === 'add' && (
        <Box flexDirection="column">
          <Text>选择模型与输入API Key：</Text>
          {addStep === 0
            ? <>
                {MODEL_OPTIONS.map((m, idx) => (
                  <Text key={m} color={idx === modelSelectIdx ? 'yellow' : undefined}>
                    {idx === modelSelectIdx ? '> ' : '  '}{m}
                  </Text>
                ))}
                <Text color="gray">↑↓选择，回车下一步，q返回</Text>
              </>
            : <>
                <Text>已选模型：{MODEL_OPTIONS[modelSelectIdx]}</Text>
                <TextInput
                  value={inputKey}
                  onChange={setInputKey}
                  onSubmit={addSubmit}
                  placeholder="请输入API Key"
                />
                <Text color="gray">输入后回车提交，q返回</Text>
              </>
          }
          {addError && <Text color="red">{addError}</Text>}
        </Box>
      )}

      {/* 编辑key */}
      {mode === 'editKey' && (
        <Box flexDirection="column">
          <Text>输入新的 API Key：</Text>
          <TextInput
            value={editKey}
            onChange={setEditKey}
            onSubmit={async val => {
              if (!val) { setMode('list'); setEditKey(''); return; }
              const p = list[selectedIdx];
              if (p) {
                await ProviderManager.updateProvider(p.id, { apiKey: val } as UpdateProviderInput);
                setMode('list'); setEditKey(''); refresh();
              }
            }}
            placeholder="新API Key"
          />
          <Text>回车确认，q取消</Text>
        </Box>
      )}

      {/* 删除 */}
      {mode === 'removeConfirm' && (
        <Box flexDirection="column">
          <Text color="red">
            确认删除 "{list[selectedIdx]?.name}" provider？ (y确认 / q取消)
          </Text>
        </Box>
      )}

      {/* Provider 详情模式 */}
      {mode === 'detail' && detail && (
        <Box flexDirection="column">
          <Text color="cyan">Provider 详情</Text>
          <Text>名称: {detail.name}</Text>
          <Text>BaseURL: {detail.baseUrl}</Text>
          <Text>API格式: {detail.apiFormat}</Text>
          <Text>主模型: {detail.models?.main || '-'}</Text>
          <Text>备注: {detail.notes || '-'}</Text>
          {msg && <Text color="green">{msg}</Text>}
          <SelectInput
            items={[
              { label: activeId === detail.id ? '✓ 已是当前' : '设为当前', value: '__set' },
              { label: '测试连通性', value: '__test' },
              { label: '编辑 Key', value: '__editKey' },
              { label: '删除', value: '__delete' },
              { label: '← 返回列表', value: '__back' },
            ]}
            onSelect={async it => {
              setMsg('');
              if (it.value === '__back') { setMode('list'); setDetail(null); return; }
              if (it.value === '__editKey') { setEditKey(''); setMode('editKey'); return; }
              if (it.value === '__delete') { setRemoveConfirm(true); setMode('removeConfirm'); return; }
              if (it.value === '__set' && activeId !== detail.id) {
                await ProviderManager.setCurrentProvider(detail.id);
                setActiveId(detail.id);
                setMsg('已设为当前');
                await refresh();
                return;
              }
              if (it.value === '__test') {
                const r = await ProviderManager.testProvider(detail);
                setMsg(r.ok ? `连通性正常，延迟 ${r.latencyMs || 0}ms` : `失败：${r.message || '未知错误'}`);
              }
            }}
          />
        </Box>
      )}

      {/* 预设新增 Provider */}
      {mode === 'applyPreset' && (
        <Box flexDirection="column">
          <Text color="cyan">从预设新增 Provider</Text>
          {!presets.length ? (
            <Text color="gray">暂无可用预设，按 q 返回。</Text>
          ) : (
            <>
              <Text>选择一个预设：</Text>
              <SelectInput
                items={presets.map((p: any) => ({ label: `${p.name || p.id} ${p.baseUrl || ''}`, value: p.id }))}
                onSelect={async it => {
                  const p = presets.find((x: any) => x.id === it.value);
                  if (!p) return;
                  const model = (p.defaultModel || MODEL_OPTIONS[0]);
                  const presetBase = p.baseUrl || FIXED_BASEURL;
                  const presetFmt = p.apiFormat || FIXED_APIFMT;
                  const idx = Math.max(0, MODEL_OPTIONS.findIndex(m => m === model));
                  setModelSelectIdx(idx);
                  (global as any).__PM_BASEURL_OVERRIDE__ = presetBase;
                  (global as any).__PM_APIFMT_OVERRIDE__ = presetFmt;
                  setMode('add');
                  setAddStep(1); // 直接跳到 Key 输入
                }}
              />
              <Text color="gray">回车选择预设，q 返回</Text>
            </>
          )}
        </Box>
      )}
    </Box>
  );
};

if (require.main === module) {
  render(<ProvidersMenu />);
}

export default ProvidersMenu;
