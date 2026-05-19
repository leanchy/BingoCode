import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import axios from 'axios';
import { Panel, Title, Chip, Hint, StateDisplay, ScrollBar, safePadEnd } from '../manager/CliMenuUi.tsx';

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
  height?: number;
}> = ({ apiUrl, onBack, height = 10 }) => {
  const { exit } = useApp();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Scrolling
  const [listOffset, setListOffset] = useState(0);

  // Calculated visible counts based on height
  const MAX_VISIBLE = Math.max(3, height - 7);
  const MAX_VISIBLE_MODELS = Math.max(3, height - 6);

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
      setErr(e?.message || 'Failed to fetch provider list');
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

  // Key processing for Page Up/Down and Arrow keys in scrolling lists
  useEffect(() => {
    const handler = (buf: Buffer) => {
      const s = buf.toString();
      if (stage === 'add_select_preset' || stage === 'slot_select_model') {
        if (s === 'j' || s === '\u001b[B') setListOffset(prev => prev + 1); // j or Down
        if (s === 'k' || s === '\u001b[A') setListOffset(prev => Math.max(0, prev - 1)); // k or Up
      }
    };
    process.stdin.on('data', handler);
    return () => process.stdin.off('data', handler);
  }, [stage]);

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
          setListOffset(0);
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
      setOpMsg(`Success -> ${name}`);
      await loadProviders();
      setStage('list');
    } catch (e: any) {
      setErr(e?.response?.data?.message || e?.message || 'Create failed');
      // Go back to the last field so user sees error instead of re-triggering submit
      setAddFieldIndex(Math.max(0, addFields.length - 1));
      setStage('add_input_fields');
    }
  };

  const doTest = async (id: string) => {
    setStage('testing');
    setErr(null); setOpMsg('Testing...');
    try {
      const res = await axios.post(`${base}/api/providers/${encodeURIComponent(id)}/test`);
      const result = res?.data?.result;
      const conn = result?.connectivity;
      if (conn?.success) {
        setOpMsg(`Connectivity OK -> ${id} (${conn.latencyMs}ms)`);
        setErr(null);
      } else {
        setErr(`Connectivity error: ${conn?.error || 'Unknown error'}`);
        setOpMsg(null);
      }
    } catch (e: any) {
      setErr(e?.response?.data?.message || e?.message || `Test failed -> ${id}`);
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
      setOpMsg(`Updated Provider -> ${name.trim() || id}`);
      await loadProviders();
      setStage('list');
    } catch (e: any) {
      setErr(e?.response?.data?.message || e?.message || 'Edit failed');
      setStage('edit_input_key');
    }
  };

  const doRemove = async (id: string) => {
    setStage('removing');
    setErr(null); setOpMsg(null);
    try {
      await axios.delete(`${base}/api/providers/${encodeURIComponent(id)}`);
      setOpMsg(`Deleted Provider -> ${id}`);
      await loadProviders();
      setStage('list');
    } catch (e: any) {
      setErr(e?.response?.data?.message || e?.message || 'Delete failed');
      setStage('list');
    }
  };

  const MAX_LIST = 5;

  // Render function for main list
  const renderList = () => {
    const visibleProviders = providers.slice(0, MAX_LIST);
    const overflow = providers.length - MAX_LIST;
    return (
    <Box flexDirection="column" flexGrow={1}>
      <Title color="cyan">Provider List</Title>
      {!providers.length && !loading && <StateDisplay type="empty" message="No providers found" />}
      <Box flexDirection="column" marginBottom={1}>
        {visibleProviders.map(p => {
          const isCur = currentProvider && (currentProvider.id === p.id);
          return (
            <Box key={p.id}>
              <Text color={isCur ? 'green' : undefined} bold={isCur}>
                {isCur ? '● ' : '  '}{p.name || '-'}
                {isCur ? <Text dimColor> (Current)</Text> : ''}
              </Text>
            </Box>
          );
        })}
        {overflow > 0 && <Text dimColor>  ...and {overflow} more</Text>}
      </Box>

      {loading && <StateDisplay type="loading" message="Loading..." />}

      <Box flexDirection="column" flexGrow={1}>
        <SelectInput
          items={[
            { label: 'Add Provider', value: 'add' },
            { label: 'Edit Provider (Name/Key)', value: 'edit' },
            { label: 'Configure Slots', value: 'slots' },
            { label: 'Connectivity Test', value: 'test' },
            { label: 'Delete Provider', value: 'delete' },
            { label: 'Refresh', value: 'refresh' },
          ]}
          onSelect={item => {
            switch (item.value) {
              case 'add':
                setSelectedPresetId(null);
                setAddFields([]);
                setAddFieldValues({});
                setAddFieldIndex(0);
                setListOffset(0);
                setStage('add_select_preset');
                break;
              case 'edit':
                setEditId(null);
                setEditName('');
                setEditKey('');
                setListOffset(0);
                setStage('edit_select');
                break;
              case 'slots':
                axios.get(`${base}/api/providers/slots`)
                  .then(r => setSlotTable(r.data as Record<string, SlotEntry>))
                  .catch(() => {});
                setStage('slot_config');
                setListOffset(0);
                break;
              case 'test':
                setStage('test_select');
                setListOffset(0);
                break;
              case 'delete':
                setStage('delete_select');
                setListOffset(0);
                break;
              case 'refresh':
                loadProviders();
                break;
            }
          }}
        />
        {err && <StateDisplay type="error" message={err} />}
        {opMsg && <Box marginTop={1}><Text color="green">{opMsg}</Text></Box>}
      </Box>
      <Hint>ESC: Back · ↑↓/Enter: Select Action</Hint>
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

    // Add Custom option only if not already in presets
    const finalItems = [
      ...(presets.some(p => p.id === 'custom') ? [] : [{ label: 'Custom (OpenAI Compatible)', value: 'custom' }]),
      ...items
    ];

    if (!items.length) {
      return (
        <Box flexDirection="column" flexGrow={1}>
          <Title color="cyan">Select Preset</Title>
          <SelectInput
            items={finalItems}
            onSelect={it => {
              if (it.value === 'custom') {
                const fields: ProviderField[] = [
                  { key: 'name', label: 'Provider Nickname', required: true, placeholder: 'My Custom API' },
                  { key: 'baseUrl', label: 'Base URL', required: true, placeholder: 'https://api.example.com/v1' },
                  { key: 'apiKey', label: 'API Key', required: true, secret: true },
                ];
                setSelectedPresetId('custom');
                setAddFields(fields);
                setAddFieldValues({});
                setAddFieldIndex(0);
                setListOffset(0);
                setStage('add_input_fields');
              } else {
                setStage('list');
              }
            }}
          />
          {!items.length && <Hint dimColor>No presets found from server, only Custom available.</Hint>}
        </Box>
      );
    }

    // const MAX_VISIBLE = 8;
    const start = Math.min(listOffset, Math.max(0, finalItems.length - MAX_VISIBLE));
    const sliced = finalItems.slice(start, start + MAX_VISIBLE);

    return (
      <Box flexDirection="column" flexGrow={1}>
        <Title color="cyan">Select Preset</Title>
        <Box flexDirection="row" flexGrow={1}>
          <Box flexDirection="column" flexGrow={1}>
            <SelectInput
              items={sliced}
              onSelect={it => {
                if (it.value === 'custom') {
                  const fields: ProviderField[] = [
                    { key: 'name', label: 'Provider Nickname', required: true, placeholder: 'My Custom API' },
                    { key: 'baseUrl', label: 'Base URL', required: true, placeholder: 'https://api.example.com/v1' },
                    { key: 'apiKey', label: 'API Key', required: true, secret: true },
                  ];
                  setSelectedPresetId('custom');
                  setAddFields(fields);
                  setAddFieldValues({});
                  setAddFieldIndex(0);
                  setListOffset(0);
                  setStage('add_input_fields');
                } else {
                  const preset = presets.find(p => p.id === (it.value as string));
                  const fields: ProviderField[] =
                    preset?.fields && preset.fields.length > 0
                      ? preset.fields
                      : [
                          { key: 'name', label: 'Provider Nickname', required: true },
                          { key: 'apiKey', label: 'API Key', required: true, secret: true },
                        ];
                  setSelectedPresetId(it.value as string);
                  setAddFields(fields);
                  setAddFieldValues({});
                  setAddFieldIndex(0);
                  setListOffset(0);
                  setStage('add_input_fields');
                }
              }}
            />
          </Box>
          <ScrollBar total={finalItems.length} offset={start} height={MAX_VISIBLE} />
        </Box>
        <Hint>↑↓: Select · j Next Page · k Prev Page · ESC: Back</Hint>
      </Box>
    );
  }

  if (stage === 'add_input_fields') {
    const field = addFields[addFieldIndex];
    if (!field) {
      return <StateDisplay type="loading" message="Creating..." />;
    }

    const currentVal = addFieldValues[field.key] ?? field.default ?? '';

    const handleSubmit = (submittedVal: string) => {
      const val = submittedVal;
      if (field.required && !val.trim()) return;

      const merged = { ...addFieldValues, [field.key]: val };

      const nextIndex = addFieldIndex + 1;
      if (nextIndex < addFields.length) {
        setAddFieldValues(merged);
        setAddFieldIndex(nextIndex);
      } else {
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
      <Box flexDirection="column" flexGrow={1}>
        <Title color="cyan">
          Add Provider — Field {addFieldIndex + 1}/{addFields.length}
        </Title>
        <Box marginBottom={1} flexDirection="row">
          <Box width={20}>
            <Text>
              {field.label}{field.required ? <Text color="red"> *</Text> : ''}
            </Text>
          </Box>
          <Box flexGrow={1}>
            {field.placeholder ? <Text dimColor>({field.placeholder})</Text> : <Text />}
          </Box>
        </Box>
        <TextInput
          value={currentVal}
          onChange={v => setAddFieldValues(prev => ({ ...prev, [field.key]: v }))}
          // @ts-ignore
          mask={field.secret ? '*' : undefined}
          onSubmit={handleSubmit}
        />
        {err && <StateDisplay type="error" message={err} />}
        <Hint>Enter: Continue · ESC: Back to List</Hint>
      </Box>
    );
  }

  if (stage === 'creating') {
    return <StateDisplay type="loading" message="Creating..." />;
  }

  if (stage === 'test_select') {
    const items = providers.map(p => ({
      label: `${p.name || p.id}`,
      value: p.id
    }));
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Title color="cyan">Select Provider to Test</Title>
        <SelectInput
          items={items}
          onSelect={it => doTest(it.value as string)}
        />
        {err && <StateDisplay type="error" message={err} />}
        <Hint>ESC: Back</Hint>
      </Box>
    );
  }

  if (stage === 'testing') {
    return <StateDisplay type="loading" message="Testing..." />;
  }

  if (stage === 'delete_select') {
    const items = providers.map(p => ({
      label: `${p.name || p.id}`,
      value: p.id
    }));
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Title color="red">Select Provider to Delete</Title>
        <SelectInput
          items={items}
          onSelect={it => {
            setSelectedId(it.value as string);
            setStage('delete_confirm');
          }}
        />
        <Hint>ESC: Back</Hint>
      </Box>
    );
  }

  if (stage === 'delete_confirm') {
    if (!selectedId) { setStage('list'); return null; }
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Title color="red">Confirm Delete: {selectedId}?</Title>
        <SelectInput
          items={[
            { label: 'Yes, Delete', value: 'yes' },
            { label: 'No, Back', value: 'no' }
          ]}
          onSelect={it => {
            if (it.value === 'no') {
              setStage('list');
            } else {
              void doRemove(selectedId);
            }
          }}
        />
        {err && <StateDisplay type="error" message={err} />}
        <Hint>ESC: Back</Hint>
      </Box>
    );
  }

  if (stage === 'removing') {
    return <StateDisplay type="loading" message="Deleting..." />;
  }

  if (stage === 'edit_select') {
    const items = providers.map(p => ({
      label: `${p.name || p.id}${(currentId === p.id || p.isCurrent) ? '  ← Current' : ''}`,
      value: p.id,
    }));
    if (!items.length) {
      return (
        <Box flexDirection="column" flexGrow={1}>
          <StateDisplay type="empty" message="No providers available to edit." />
          <SelectInput items={[{ label: '← Back', value: 'back' }]} onSelect={() => setStage('list')} />
        </Box>
      );
    }
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Title color="cyan">Select Provider to Edit</Title>
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
        <Hint>ESC: Back</Hint>
      </Box>
    );
  }

  if (stage === 'edit_input_name') {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Title color="cyan">Edit Name</Title>
        <Text>Current: <Text color="cyan">{editName}</Text> (Enter to keep):</Text>
        <TextInput
          value={editName}
          onChange={setEditName}
          onSubmit={() => setStage('edit_input_key')}
        />
        <Hint>Enter: Continue · ESC: Back</Hint>
      </Box>
    );
  }

  if (stage === 'edit_input_key') {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Title color="cyan">Edit API Key</Title>
        <Text>Enter new API Key (Leave empty to keep current):</Text>
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
        {err && <StateDisplay type="error" message={err} />}
        <Hint>Enter: Save · ESC: Back</Hint>
      </Box>
    );
  }

  if (stage === 'editing') {
    return <StateDisplay type="loading" message="Saving..." />;
  }

  if (stage === 'slot_config') {
    const SLOTS = ['main', 'haiku', 'sonnet', 'opus'] as const;
    const SLOT_DESCS: Record<string, string> = {
      main:   'Main model for complex reasoning and long context.',
      haiku:  'Fast & light for simple Q&A and low latency.',
      sonnet: 'Balanced quality & speed for daily tasks.',
      opus:   'Strongest reasoning for deep analysis.',
    };
    const items = SLOTS.map(s => {
      const entry = slotTable[s];
      const providerName = entry
        ? (providers.find(p => p.id === entry.providerId)?.name || entry.providerId)
        : null;
      const modelDisplayName = entry?.label || entry?.modelId || 'Unconfigured';
      const status = entry ? `${providerName} / ${modelDisplayName}` : 'Unconfigured';
      const label = `[${s}] ${safePadEnd(status, 30)} — ${SLOT_DESCS[s]}`;
      return { label, value: s };
    });
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Title color="cyan">Configure Model Slots</Title>
        {err && <StateDisplay type="error" message={err} />}
        {opMsg && <Box marginBottom={1}><Text color="green">{opMsg}</Text></Box>}
        <SelectInput
          items={[...items, { label: '← Back to Menu', value: 'back' }]}
          onSelect={it => {
            if (it.value === 'back') { setStage('list'); setErr(null); return; }
            const slotName = it.value as string;
            setCurrentSlotName(slotName);
            setErr(null);
            setSlotLoadingMsg(`Fetching model list...`);
            setStage('slot_loading');
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
              const hasAny = results.some(r => r.models.length > 0);
              if (!hasAny) {
                setErr('No models returned from any provider. Check API keys.');
                setStage('slot_config');
              } else {
                setListOffset(0);
                setStage('slot_select_model');
              }
            });
          }}
        />
        <Hint>ESC: Back</Hint>
      </Box>
    );
  }

  if (stage === 'slot_loading') {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <StateDisplay type="loading" message={slotLoadingMsg || 'Fetching models...'} />
        <Hint>ESC: Cancel</Hint>
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
        <Box flexDirection="column" flexGrow={1}>
          <StateDisplay type="error" message="No available models found." />
          <SelectInput
            items={[{ label: '← Back', value: 'back' }]}
            onSelect={() => setStage('slot_config')}
          />
        </Box>
      );
    }

    // const MAX_VISIBLE_MODELS = 8;
    const start = Math.min(listOffset, Math.max(0, items.length - MAX_VISIBLE_MODELS));
    const sliced = items.slice(start, start + MAX_VISIBLE_MODELS);

    return (
      <Box flexDirection="column" flexGrow={1}>
        <Title color="cyan">Configure Slot [{currentSlotName}] — Select Model</Title>
        {err && <StateDisplay type="error" message={err} />}

        <Box flexDirection="row" flexGrow={1}>
          <Box flexDirection="column" flexGrow={1}>
            <SelectInput
              items={sliced}
              onSelect={it => {
                const val = it.value as string;
                if (val.startsWith('__header__')) return;
                const sepIdx = val.indexOf('::');
                const providerId = val.slice(0, sepIdx);
                const modelId = val.slice(sepIdx + 2);
                setTempSlotProviderId(providerId);
                setTempSlotModelId(modelId);
                setSlotLabelInput(modelId);
                setStage('slot_input_label');
              }}
            />
          </Box>
          <ScrollBar total={items.length} offset={start} height={MAX_VISIBLE_MODELS} />
        </Box>
        <Hint>↑↓: Select · j Next Page · k Prev Page · ESC: Back</Hint>
      </Box>
    );
  }

  if (stage === 'slot_input_label') {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Title color="cyan">Configure Slot [{currentSlotName}] — Set Display Name</Title>
        <Text>
          Model: {providers.find(p => p.id === tempSlotProviderId)?.name || tempSlotProviderId} / {tempSlotModelId}
        </Text>
        <Box marginTop={1}>
          <Text>Display Name (Label): </Text>
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
                setOpMsg(`Configured [${currentSlotName}] -> ${label}`);
                setErr(null);
                setListOffset(0);
                setStage('slot_config');
              })
              .catch(e => {
                setErr((e as any)?.response?.data?.message || (e as any)?.message || 'Save failed');
                setStage('slot_config');
              });
            }}
          />
        </Box>
        <Hint>Enter: Save (Display name in UI) · ESC: Back to Models</Hint>
      </Box>
    );
  }

  return null;
};

export default ProviderPanel;
