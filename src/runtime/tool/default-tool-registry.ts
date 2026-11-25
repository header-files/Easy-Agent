import type {
  RegisteredTool,
  ToolHandler,
  ToolRegistry,
  ToolSpec,
} from '../../harness/contracts/tool/index.ts';
import { compileToolSchema, copyToolSpec } from './tool-validator.ts';
import { normalizeToolMeta, type ToolRuntimeMeta } from './tool-meta.ts';

/** Process-local registration; caller-owned declarations never become internal state. */
export class DefaultToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly meta = new Map<string, ToolRuntimeMeta>();

  register(
    spec: ToolSpec,
    handler: ToolHandler,
    runtimeMeta?: Partial<ToolRuntimeMeta>,
  ): void {
    const snapshot = copyToolSpec(spec);
    if (typeof handler !== 'function') throw new Error('Invalid tool handler.');
    if (this.tools.has(snapshot.name))
      throw new Error('Tool name is already registered.');
    compileToolSchema(snapshot.parameters);
    const meta = normalizeToolMeta(runtimeMeta);
    this.tools.set(snapshot.name, { spec: snapshot, handler });
    this.meta.set(snapshot.name, meta);
  }

  unregister(name: string): boolean {
    this.meta.delete(name);
    return this.tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    const tool = this.tools.get(name);
    return tool === undefined
      ? undefined
      : { spec: copyToolSpec(tool.spec), handler: tool.handler };
  }

  getMeta(name: string): ToolRuntimeMeta | undefined {
    return this.meta.get(name);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => copyToolSpec(tool.spec));
  }
}
