import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import axios from 'axios';

type ProviderField = {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  default?: string;
};

type Provider = {
  id: string;
  name?: string;
  baseUrl?: string;
  notes?: string;
  isCurrent?: boolean;
  models?: { main: string; haiku: string; sonnet: string; opus: string };
};

type Preset = {
  id: string;
  label?: string;
  name?: string;
  desc?: string;
  baseUrl?: string;
  apiFormat?: string;
  needsApiKey?: boolean;
  websiteUrl?: string;
  fields?: ProviderField[];
};

type Stage =
  | 'list'
  | 'add_select_preset'
  | 'add_input_fields'
  | 'test_select'
  | 'delete_select'
  | 'delete_confirm'
  | 'testing'
  | 'creating'
  | 'removing'
  | 'edit_select'
  | 'edit_input_name'
  | 'edit_input_key'
  | 'editing'
  | 'slot_config'
  | 'slot_loading'
  | 'slot_select_model'
  | 'slot_input_label';

export const ProviderPanel: React.FC<{
  apiUrl: string;
  onBack?: () => void;
}> = ({ apiUrl, onBack }) => {
  const { exit } = useApp();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [providers, setProviders] = useState<Provider[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);

  const [presets, setPresets] = useState<Preset[]>([]);

  const [stage, setStage] = useState<Stage>('list');

  // 新增流程（动态字段）
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [addFields, setAddFields] = useState<ProviderField[]>([]);
  const [addFieldValues, setAddFieldValues] = useState<Record<string, string>>({});
  const [addFieldIndex, setAddFieldIndex] = useState(0);

  const [opMsg, setOpMsg] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 编辑所需状态
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editKey, setEditKey] = useState('');

  // 槽位配置状态
  type SlotEntry = { providerId: string; modelId: string; label?: string | null } | null;
  const [slotTable, setSlotTable] = useState<Record<string, SlotEntry>>({});
  const [slotProviderModels, setSlotProviderModels] = useState<Record<string, string[]>>({});
  const [currentSlotName, setCurrentSlotName] = useState<string>('main');
  const [slotLoadingMsg, setSlotLoadingMsg] = useState<string>('');
  const [tempSlotProviderId, setTempSlotProviderId] = useState<string>('');
  const [tempSlotModelId, setTempSlotModelId] = useState<string>('');
  const [slotLabelInput, setSlotLabelInput] = useState<string>('');

  const base = apiUrl.replace(/\/+$/, '');

  const parseListResp = (data: any): { list: Provider[]; currentId: string | null } => {
    if (Array.isArray(data)) {
      const cur = data.find((p: any) => p.isCurrent)?.id ?? null;
      return { list: data, currentId: cur };
    }
    const list = data?.providers || data?.list || data?.items || [];
    const cur =
      data?.currentId ??
      list.find((p: any) => p.isCurrent)?.id ??
      null;
    return { list, currentId: cur };
  };

  const loadProviders = useCallback(async (opts?: { keepError?: boolean }) => {
    setLoading(true);
    if (!opts?.keepError) setErr(null);
    try {
      const res = await axios.get(`${base}/api/providers`);
      const { list, currentId } = parseListResp(res.data);
      setProviders(list || []);
      setCurrentId(currentId);
    } catch (e: any) {
      setErr(e?.message || '获取 Provider 列表失败');
    } finally {
      setLoading(false);
    }
  }, [base]);

  const loadPresets = useCallback(async () => {
    try {
      const res = await axios.get(`${base}/api/providers/presets`);
      const data = Array.isArray(res.data) ? res.data : (res.data?.presets || res.data?.list || []);
      setPresets(data || []);
    } catch (e) {
      setPresets([]);
    }
  }, [base]);

  useEffect(() => {
    loadProviders();
    loadPresets();
  }, [loadProviders, loadPresets]);

  // ESC 处理：子页返回列表；列表再触发 onBack（或退出）
  useEffect(() => {
    const handler = (buf: Buffer) => {
      const key = buf.toString();
      if (key === '\u001b') {
        if (stage === 'slot_select_model' || stage === 'slot_loading') {
          setStage('slot_config');
          setErr(null);
        } else if (stage === 'slot_config') {
          setStage('list');
          setErr(null);
        } else if (stage !== 'list') {
          setStage('list');
          setSelectedPresetId(null);
          setAddFields([]);
          setAddFieldValues({});
          setAddFieldIndex(0);
          setSelectedId(null);
          setOpMsg(null);
          setErr(null);
          setEditId(null);
          setEditName('');
          setEditKey('');
        } else {
          onBack ? onBack() : exit();
        }
      }
    };
    process.stdin.on('data', handler);
    return () => process.stdin.off('data', handler);
  }, [stage, onBack, exit]);

  const currentProvider = useMemo(
    () => providers.find(p => (currentId ? p.id === currentId : p.isCurrent)),
    [providers, currentId]
  );

  // Actions
  const doCreate = async (
    presetId: string,
    name: string,
    apiKey: string,
    baseUrl?: string,
    extra?: Record<string, string>,
  ) => {
    setStage('creating');
    setErr(null); setOpMsg(null);
    try {
      // 从预设补全 baseUrl（前端填的 baseUrl 优先）；models 全部留空，后续通过槽位配置动态选择
      const preset = presets.find(p => p.id === presetId);
      const resolvedBaseUrl = baseUrl || preset?.baseUrl || '';

      const body: Record<string, unknown> = {
        presetId,
        name,
        apiKey,
        baseUrl: resolvedBaseUrl,
        models: { main: '', haiku: '', sonnet: '', opus: '' },
        ...(preset?.apiFormat && { apiFormat: preset.apiFormat }),
      };
      if (extra && Object.keys(extra).length > 0) body.extra = extra;
      await axios.post(`${base}/api/providers`, body);
      setOpMsg(`创建成功 -> ${name}`);
      await loadProviders();
      setStage('list');
    } catch (e: any) {
      setErr(e?.response?.data?.message || e?.message || '创建失败');
      // 回到最后一个字段让用户看到错误，而不是触发再次提交
      setAddFieldIndex(Math.max(0, addFields.length - 1));
      setStage('add_input_fields');
    }
  };

  const doTest = async (id: string) => {
    setStage('testing');
    setErr(null); setOpMsg('测试中...');
    try {
      const res = await axios.post(`${base}/api/providers/${encodeURIComponent(id)}/test`);
      const result = res?.data?.result;
      const conn = result?.connectivity;
      if (conn?.success) {
        setOpMsg(`连通性正常 -> ${id} (${conn.latencyMs}ms)`);
        setErr(null);
      } else {
        setErr(`连通性异常: ${conn?.error || '未知错误'}`);
        setOpMsg(null);
      }
    } catch (e: any) {
      setErr(e?.response?.data?.message || e?.message || `测试失败 -> ${id}`);
      setOpMsg(null);
    } finally {
      if (stage !== 'list') setStage('list');
      await loadProviders({ keepError: true });
    }
  };

  const doEdit = async (id: string, name: string, apiKey: string) => {
    setStage('editing');
    setErr(null); setOpMsg(null);
    try {
      const updates: Record<string, string> = {};
      if (name.trim()) updates.name = name.trim();
      if (apiKey.trim()) updates.apiKey = apiKey.trim();
      await axios.put(`${base}/api/providers/${encodeURIComponent(id)}`, updates);
      setOpMsg(`已更新 Provider -> ${name.trim() || id}`);
      await loadProviders();
      setStage('list');
    } catch (e: any) {
      setErr(e?.response?.data?.message || e?.message || '编辑失败');
      setStage('edit_input_key');
    }
  };

  const doRemove = async (id: string) => {
    setStage('removing');
    setErr(null); setOpMsg(null);
    try {
      await axios.delete(`${base}/api/providers/${encodeURIComponent(id)}`);
      setOpMsg(`已删除 Provider -> ${id}`);
      await loadProviders();
      setStage('list');
    } catch (e: any) {
      setErr(e?.response?.data?.message || e?.message || '删除失败');
      setStage('list');
    }
  };

  const MAX_LIST = 5;

  // 渲染块
  const renderList = () => {
    const visibleProviders = providers.slice(0, MAX_LIST);
    const overflow = providers.length - MAX_LIST;
    return (
    <Box flexDirection="column">
      <Text color="cyan">Provider 列表</Text>
      {!providers.length && !loading && <Text>暂无 Provider</Text>}
      {visibleProviders.map(p => {
        const isCur = currentProvider && (currentProvider.id === p.id);
        return (
          <Text key={p.id} color={isCur ? 'green' : undefined} bold={isCur}>
            {p.name || '-'}{isCur ? '  ← 当前' : ''}
          </Text>
        );
      })}
      {overflow > 0 && <Text dimColor>  ...还有 {overflow} 个</Text>}
      {currentProvider && (
        <Text dimColor>
          当前 Provider: {currentProvider.name || currentProvider.id}
        </Text>
      )}
      {loading && <Text color="yellow">加载中...</Text>}

      <Box marginTop={1} flexDirection="column">
        <SelectInput
          items={[
            { label: '新增 Provider', value: 'add' },
            { label: '编辑 Provider（名称/API Key）', value: 'edit' },
            { label: '配置槽位（main/haiku/sonnet/opus）', value: 'slots' },
            { label: '连通性测试', value: 'test' },
            { label: '删除 Provider', value: 'delete' },
            { label: '刷新', value: 'refresh' },
            { label: '返回主菜单（ESC）', value: 'back' },
          ]}
          onSelect={item => {
            switch (item.value) {
              case 'add':
                setSelectedPresetId(null);
                setAddFields([]);
                setAddFieldValues({});
                setAddFieldIndex(0);
                setStage('add_select_preset');
                break;
              case 'edit':
                setEditId(null);
                setEditName('');
                setEditKey('');
                setStage('edit_select');
                break;
              case 'slots':
                axios.get(`${base}/api/providers/slots`)
                  .then(r => setSlotTable(r.data as Record<string, SlotEntry>))
                  .catch(() => {});
                setStage('slot_config');
                break;
              case 'test':
                setStage('test_select');
                break;
              case 'delete':
                setStage('delete_select');
                break;
              case 'refresh':
                loadProviders();
                break;
              case 'back':
                onBack ? onBack() : null;
                break;
            }
          }}
        />
        {err && (
          <Box marginTop={1}>
            <Text color="red">{err}</Text>
          </Box>
        )}
        {opMsg && (
          <Box marginTop={1}>
            <Text color="green">{opMsg}</Text>
          </Box>
        )}
        <Text dimColor>提示：ESC 返回。↑↓/回车 选择操作</Text>
      </Box>
    </Box>
    );
  };

  if (stage === 'list') return renderList();

  if (stage === 'add_select_preset') {
    const items = (presets || []).map(pr => ({
      label: pr.websiteUrl
        ? `${pr.label || pr.name || pr.id}  ${pr.websiteUrl}`
        : `${pr.label || pr.name || pr.id}`,
      value: pr.id
    }));
    if (!items.length) {
      return (
        <Box flexDirection="column">
          <Text color="yellow">未获取到预设，请先确保主服务已启动。</Text>
          <SelectInput
            items={[{ label: '← 返回', value: 'back' }]}
            onSelect={() => setStage('list')}
          />
        </Box>
      );
    }
    return (
      <Box flexDirection="column">
        <Text>选择预设：</Text>
        <SelectInput
          items={items}
          onSelect={it => {
            const preset = presets.find(p => p.id === (it.value as string));
            // 从 preset.fields 获取字段列表；若为空则用默认最小集
            const fields: ProviderField[] =
              preset?.fields && preset.fields.length > 0
                ? preset.fields
                : [
                    { key: 'name', label: 'Provider 昵称', required: true },
                    { key: 'apiKey', label: 'API Key', required: true, secret: true },
                  ];
            setSelectedPresetId(it.value as string);
            setAddFields(fields);
            setAddFieldValues({});
            setAddFieldIndex(0);
            setStage('add_input_fields');
          }}
        />
        <Text dimColor>ESC 返回</Text>
      </Box>
    );
  }

  if (stage === 'add_input_fields') {
    const field = addFields[addFieldIndex];
    if (!field) {
      // 防御性分支：所有字段已填完但还没触发提交（一般不应走到这里）
      return <Text color="yellow">创建中...</Text>;
    }

    const currentVal = addFieldValues[field.key] ?? field.default ?? '';

    const handleSubmit = (submittedVal: string) => {
      // ink-text-input passes the current value to onSubmit
      const val = submittedVal;
      if (field.required && !val.trim()) return; // 必填不允许空

      // 确保最新值已写入
      const merged = { ...addFieldValues, [field.key]: val };

      const nextIndex = addFieldIndex + 1;
      if (nextIndex < addFields.length) {
        setAddFieldValues(merged);
        setAddFieldIndex(nextIndex);
      } else {
        // 最后一个字段提交，触发创建
        const name = merged['name'] || '';
        const apiKey = merged['apiKey'] || '';
        const baseUrl = merged['baseUrl'] || '';
        const extra: Record<string, string> = {};
        for (const [k, v] of Object.entries(merged)) {
          if (!['name', 'apiKey', 'baseUrl'].includes(k) && v) extra[k] = v;
        }
        setAddFieldValues(merged);
        void doCreate(selectedPresetId!, name, apiKey, baseUrl || undefined, extra);
      }
    };

    return (
      <Box flexDirection="column">
        <Text color="cyan">
          新增 Provider — 字段 {addFieldIndex + 1}/{addFields.length}
        </Text>
        <Text>
          {field.label}{field.required ? <Text color="red"> *</Text> : ''}
          {field.placeholder ? <Text dimColor>  ({field.placeholder})</Text> : ''}：
        </Text>
        <TextInput
          value={currentVal}
          onChange={v => setAddFieldValues(prev => ({ ...prev, [field.key]: v }))}
          // @ts-ignore - ink-text-input supports mask prop
          mask={field.secret ? '*' : undefined}
          onSubmit={handleSubmit}
        />
        {err && <Text color="red">{err}</Text>}
        <Text dimColor>回车继续，ESC 返回列表</Text>
      </Box>
    );
  }

  if (stage === 'creating') {
    return <Text color="yellow">创建中...</Text>;
  }

  if (stage === 'test_select') {
    const items = providers.map(p => ({
      label: `${p.name || p.id}`,
      value: p.id
    }));
    return (
      <Box flexDirection="column">
        <Text>选择要测试的 Provider：</Text>
        <SelectInput
          items={items}
          onSelect={it => doTest(it.value as string)}
        />
        {err && <Text color="red">{err}</Text>}
        <Text dimColor>ESC 返回</Text>
      </Box>
    );
  }

  if (stage === 'testing') {
    return <Text color="yellow">测试中...</Text>;
  }

  if (stage === 'delete_select') {
    const items = providers.map(p => ({
      label: `${p.name || p.id}`,
      value: p.id
    }));
    return (
      <Box flexDirection="column">
        <Text color="red">选择要删除的 Provider：</Text>
        <SelectInput
          items={items}
          onSelect={it => {
            setSelectedId(it.value as string);
            setStage('delete_confirm');
          }}
        />
        <Text dimColor>ESC 返回</Text>
      </Box>
    );
  }

  if (stage === 'delete_confirm') {
    if (!selectedId) { setStage('list'); return null; }
    return (
      <Box flexDirection="column">
        <Text color="red">确认删除 Provider：{selectedId} ？</Text>
        <SelectInput
          items={[
            { label: '是，删除', value: 'yes' },
            { label: '否，返回', value: 'no' }
          ]}
          onSelect={it => {
            if (it.value === 'no') {
              setStage('list');
            } else {
              void doRemove(selectedId);
            }
          }}
        />
        {err && <Text color="red">{err}</Text>}
        <Text dimColor>ESC 返回</Text>
      </Box>
    );
  }

  if (stage === 'removing') {
    return <Text color="yellow">删除中...</Text>;
  }

  if (stage === 'edit_select') {
    const items = providers.map(p => ({
      label: `${p.name || p.id}${(currentId === p.id || p.isCurrent) ? '  ← 当前' : ''}`,
      value: p.id,
    }));
    if (!items.length) {
      return (
        <Box flexDirection="column">
          <Text color="yellow">暂无 Provider 可编辑。</Text>
          <SelectInput items={[{ label: '← 返回', value: 'back' }]} onSelect={() => setStage('list')} />
        </Box>
      );
    }
    return (
      <Box flexDirection="column">
        <Text>选择要编辑的 Provider：</Text>
        <SelectInput
          items={items}
          onSelect={it => {
            const p = providers.find(p => p.id === it.value);
            setEditId(it.value as string);
            setEditName(p?.name || '');
            setEditKey('');
            setStage('edit_input_name');
          }}
        />
        <Text dimColor>ESC 返回</Text>
      </Box>
    );
  }

  if (stage === 'edit_input_name') {
    return (
      <Box flexDirection="column">
        <Text>编辑名称（当前：<Text color="cyan">{editName}</Text>，回车保留不变）：</Text>
        <TextInput
          value={editName}
          onChange={setEditName}
          onSubmit={() => setStage('edit_input_key')}
        />
        <Text dimColor>回车继续，ESC 返回</Text>
      </Box>
    );
  }

  if (stage === 'edit_input_key') {
    return (
      <Box flexDirection="column">
        <Text>输入新 API Key（留空则不修改）：</Text>
        <TextInput
          value={editKey}
          onChange={setEditKey}
          // @ts-ignore
          mask="*"
          onSubmit={() => {
            if (!editId) { setStage('list'); return; }
            doEdit(editId, editName, editKey);
          }}
        />
        {err && <Text color="red">{err}</Text>}
        <Text dimColor>回车保存，ESC 返回</Text>
      </Box>
    );
  }

  if (stage === 'editing') {
    return <Text color="yellow">保存中...</Text>;
  }

  if (stage === 'slot_config') {
    const SLOTS = ['main', 'haiku', 'sonnet', 'opus'] as const;
    const SLOT_DESCS: Record<string, string> = {
      main:   '主力模型，复杂推理、长上下文、代码生成等高要求任务',
      haiku:  '快速轻量，简单问答、自动补全、低延迟响应',
      sonnet: '均衡模型，兼顾质量与速度，适合日常对话',
      opus:   '最强模型，深度推理与复杂分析（调用量通常最少）',
    };
    const items = SLOTS.map(s => {
      const entry = slotTable[s];
      const providerName = entry
        ? (providers.find(p => p.id === entry.providerId)?.name || entry.providerId)
        : null;
      const modelDisplayName = entry?.label || entry?.modelId || '未配置';
      const status = entry ? `${providerName} / ${modelDisplayName}` : '未配置';
      const label = `[${s}]  ${status}  — ${SLOT_DESCS[s]}`;
      return { label, value: s };
    });
    return (
      <Box flexDirection="column">
        <Text color="cyan">配置槽位（选中槽位后选择模型）</Text>
        {err && <Text color="red">{err}</Text>}
        {opMsg && <Text color="green">{opMsg}</Text>}
        <SelectInput
          items={[...items, { label: '← 返回主菜单', value: 'back' }]}
          onSelect={it => {
            if (it.value === 'back') { setStage('list'); setErr(null); return; }
            const slotName = it.value as string;
            setCurrentSlotName(slotName);
            setErr(null);
            setSlotLoadingMsg(`正在拉取模型列表...`);
            setStage('slot_loading');
            // Fetch model lists from each provider's API endpoint
            Promise.all(
              providers.map(p =>
                axios.get(`${base}/api/providers/${encodeURIComponent(p.id)}/models`)
                  .then(r => {
                    const data = r.data;
                    const models = Array.isArray(data) ? data : (data?.models || []);
                    return { id: p.id, models: (models as string[]) || [] };
                  })
                  .catch(() => ({ id: p.id, models: [] as string[] }))
              )
            ).then(results => {
              const map: Record<string, string[]> = {};
              results.forEach(r => { map[r.id] = r.models; });
              setSlotProviderModels(map);
              // Check if any models available
              const hasAny = results.some(r => r.models.length > 0);
              if (!hasAny) {
                setErr('所有 Provider 均未返回可用模型，请检查 API Key 和网络连接');
                setStage('slot_config');
              } else {
                setStage('slot_select_model');
              }
            });
          }}
        />
        <Text dimColor>ESC 返回</Text>
      </Box>
    );
  }

  if (stage === 'slot_loading') {
    return (
      <Box flexDirection="column">
        <Text color="yellow">{slotLoadingMsg || '正在拉取模型列表...'}</Text>
        <Text dimColor>ESC 取消</Text>
      </Box>
    );
  }

  if (stage === 'slot_select_model') {
    const items: Array<{ label: string; value: string }> = [];
    providers.forEach(p => {
      const models = slotProviderModels[p.id] || [];
      if (models.length === 0) return;
      items.push({ label: `── ${p.name || p.id} ──`, value: `__header__${p.id}` });
      models.forEach(m => items.push({ label: `   ${m}`, value: `${p.id}::${m}` }));
    });

    if (items.length === 0) {
      return (
        <Box flexDirection="column">
          <Text color="red">没有可用的模型（所有 Provider 均未返回模型，请检查 API Key 和网络）</Text>
          <SelectInput
            items={[{ label: '← 返回', value: 'back' }]}
            onSelect={() => setStage('slot_config')}
          />
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Text color="cyan">配置槽位 [{currentSlotName}] — 选择模型</Text>
        {err && <Text color="red">{err}</Text>}
        <SelectInput
          items={items}
          onSelect={it => {
            const val = it.value as string;
            if (val.startsWith('__header__')) return;
            const sepIdx = val.indexOf('::');
            const providerId = val.slice(0, sepIdx);
            const modelId = val.slice(sepIdx + 2);
            setTempSlotProviderId(providerId);
            setTempSlotModelId(modelId);
            setSlotLabelInput(modelId); // 默认建议使用模型名作为 Label
            setStage('slot_input_label');
          }}
        />
        <Text dimColor>↑↓ 选择模型，回车确认，ESC 返回</Text>
      </Box>
    );
  }

  if (stage === 'slot_input_label') {
    return (
      <Box flexDirection="column">
        <Text color="cyan">配置槽位 [{currentSlotName}] — 设置显示名称</Text>
        <Text>
          模型：{providers.find(p => p.id === tempSlotProviderId)?.name || tempSlotProviderId} / {tempSlotModelId}
        </Text>
        <Box marginTop={1}>
          <Text>显示名称 (Label)：</Text>
          <TextInput
            value={slotLabelInput}
            onChange={setSlotLabelInput}
            onSubmit={() => {
              const label = slotLabelInput.trim() || tempSlotModelId;
              axios.put(`${base}/api/providers/slots/${currentSlotName}`, {
                providerId: tempSlotProviderId,
                modelId: tempSlotModelId,
                label,
              })
              .then(() => {
                setSlotTable(prev => ({
                  ...prev,
                  [currentSlotName]: { providerId: tempSlotProviderId, modelId: tempSlotModelId, label }
                }));
                setOpMsg(`已配置 [${currentSlotName}] -> ${label}`);
                setErr(null);
                setStage('slot_config');
              })
              .catch(e => {
                setErr((e as any)?.response?.data?.message || (e as any)?.message || '保存失败');
                setStage('slot_config');
              });
            }}
          />
        </Box>
        <Text dimColor>回车保存组件名称（显示在 Claude UI），ESC 返回模型选择</Text>
      </Box>
    );
  }

  return null;
};

export default ProviderPanel;
