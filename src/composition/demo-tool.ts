import type { ToolRegistry } from '../harness/contracts/tool/index.ts';

/** Pure arithmetic only: no filesystem, process execution or network capabilities. */
export function registerDemoTool(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'add',
      description: 'Add two finite numbers and return their sum.',
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    },
    (args) => {
      const sum = (args.a as number) + (args.b as number);
      if (!Number.isFinite(sum)) throw new Error('The sum must be finite.');
      return { content: String(sum) };
    },
  );
}
