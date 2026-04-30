#!/usr/bin/env node
import { ProviderManager } from '../services/providerManager.ts';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

function buildCli() {
  return yargs(hideBin(process.argv))
    .scriptName('provider')
    .command('list', 'List providers', y => y, async () => {
      const list = await ProviderManager.listProviders();
      console.log(list);
    })
    .command('current [id]', 'Get/Set current provider', y => y.positional('id', { type: 'string' }), async argv => {
      if (argv.id) { await ProviderManager.setCurrentProvider(String(argv.id)); }
      const cur = await ProviderManager.getCurrentProvider();
      console.log(cur || null);
    })
    .command('presets', 'List presets', y => y, async () => {
      console.log(await ProviderManager.listPresets());
    })
    .command('add', 'Add provider', y => y
      .option('preset', { type: 'string' })
      .option('id', { type: 'string' })
      .option('type', { type: 'string' })
      .option('name', { type: 'string' })
      .option('apiKey', { type: 'string' })
      .option('baseUrl', { type: 'string' })
      .option('apiFormat', { type: 'string' })
      .option('notes', { type: 'string' })
    , async argv => {
      let input: any = { id: argv.id, type: argv.type, name: argv.name, apiKey: argv.apiKey, baseUrl: argv.baseUrl, apiFormat: argv.apiFormat, notes: argv.notes };
      if (argv.preset) input = await ProviderManager.applyPreset(String(argv.preset), input);
      const p = await ProviderManager.upsertProvider(input);
      console.log(p);
    })
    .command('update <id>', 'Update provider', y => y.positional('id', { type: 'string' })
      .option('name', { type: 'string' })
      .option('apiKey', { type: 'string' })
      .option('baseUrl', { type: 'string' })
      .option('apiFormat', { type: 'string' })
      .option('notes', { type: 'string' })
    , async argv => {
      const p = await ProviderManager.updateProvider(String(argv.id), argv as any);
      console.log(p);
    })
    .command('remove <id>', 'Remove provider', y => y.positional('id', { type: 'string' }), async argv => {
      await ProviderManager.removeProvider(String(argv.id));
      console.log('OK');
    })
    .command('test <id>', 'Connectivity test', y => y.positional('id', { type: 'string' }), async argv => {
      const r = await ProviderManager.testProvider(String(argv.id));
      console.log(r);
    })
    .strict();
}

if (require.main === module) {
  buildCli().parse();
}
