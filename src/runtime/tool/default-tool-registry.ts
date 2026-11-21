import type {
  RegisteredTool,
  ToolHandler,
  ToolRegistry,
  ToolSpec,
} from '../../harness/contracts/tool/index.ts';
import { compileToolSchema, copyToolSpec } from './tool-validator.ts';

/** Process-local registration; caller-owned declarations never become internal state. */
export class DefaultToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(spec: ToolSpec, handler: ToolHandler): void {
    const snapshot = copyToolSpec(spec);
    if (typeof handler !== 'function') throw new Error('Invalid tool handler.');
    if (this.tools.has(snapshot.name))
      throw new Error('Tool name is already registered.');
    compileToolSchema(snapshot.parameters);
    this.tools.set(snapshot.name, { spec: snapshot, handler });
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    const tool = this.tools.get(name);
    return tool === undefined
      ? undefined
      : { spec: copyToolSpec(tool.spec), handler: tool.handler };
  }

  list(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => copyToolSpec(tool.spec));
  }
}
