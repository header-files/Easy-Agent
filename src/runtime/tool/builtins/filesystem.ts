import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ToolHandler,
  ToolSpec,
} from '../../../harness/contracts/tool/index.ts';
import {
  WorkspaceError,
  WorkspacePathResolver,
  type WorkspaceManager,
} from '../../workspace/index.ts';
import type { ToolRuntimeMeta } from '../tool-meta.ts';
import {
  MAX_LIST_DEPTH,
  MAX_LIST_ENTRIES,
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
} from './limits.ts';
import {
  assertSameDirectory,
  listVerifiedDirectoryNames,
  readFileText,
  writeFileExclusive,
  writeFileOverwrite,
} from './safe-fs.ts';

export interface BuiltinTool {
  spec: ToolSpec;
  handler: ToolHandler;
  meta: ToolRuntimeMeta;
}

function requireWorkspace(
  manager: WorkspaceManager,
  workspaceId: string | undefined,
) {
  if (!workspaceId) throw new WorkspaceError('invalid_request');
  const workspace = manager.get(workspaceId);
  if (!workspace) throw new WorkspaceError('not_found');
  return workspace;
}

function fail(message: string): never {
  throw new Error(message);
}

export function createFilesystemTools(
  manager: WorkspaceManager,
): readonly BuiltinTool[] {
  const list_directory: BuiltinTool = {
    meta: { approval: 'never', workspaceAccess: 'read' },
    spec: {
      name: 'list_directory',
      description: 'List entries under a workspace-relative directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          maxDepth: { type: 'integer', minimum: 0, maximum: MAX_LIST_DEPTH },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    handler: async (args, context) => {
      const workspace = requireWorkspace(manager, context.workspaceId);
      const resolver = new WorkspacePathResolver(workspace.rootPath);
      const target = await resolver.resolve(String(args.path));
      const maxDepth =
        typeof args.maxDepth === 'number' ? args.maxDepth : MAX_LIST_DEPTH;
      const entries: string[] = [];
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (entries.length >= MAX_LIST_ENTRIES) return;
        // Node cannot scandir by fd: open+identity-check around path readdir.
        const { names, expected } = await listVerifiedDirectoryNames(
          dir,
          workspace.rootPath,
        );
        for (const name of names) {
          if (entries.length >= MAX_LIST_ENTRIES) {
            entries.push('[truncated]');
            return;
          }
          if (
            name.length === 0 ||
            name === '.' ||
            name === '..' ||
            name.includes('/') ||
            name.includes('\\') ||
            name.includes('\0')
          ) {
            throw new WorkspaceError('invalid_path');
          }
          // Re-check before each child: intermediate symlink replace must fail closed.
          await assertSameDirectory(dir, expected);
          const full = path.join(dir, name);
          let stat;
          try {
            stat = await fs.lstat(full);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw new WorkspaceError('invalid_path');
          }
          await assertSameDirectory(dir, expected);
          if (stat.isSymbolicLink()) continue;
          const rel = path.relative(workspace.rootPath, full);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new WorkspaceError('invalid_path');
          }
          entries.push(stat.isDirectory() ? `${rel}/` : rel);
          if (stat.isDirectory() && depth < maxDepth) {
            await walk(full, depth + 1);
          }
        }
      };
      if (!target.exists) fail('Directory was not found.');
      await walk(target.absolute, 0);
      return { content: JSON.stringify({ entries }, null, 2) };
    },
  };

  const read_file: BuiltinTool = {
    meta: { approval: 'never', workspaceAccess: 'read' },
    spec: {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    handler: async (args, context) => {
      const workspace = requireWorkspace(manager, context.workspaceId);
      const resolver = new WorkspacePathResolver(workspace.rootPath);
      const target = await resolver.resolve(String(args.path));
      if (!target.exists) fail('File was not found.');
      const content = await readFileText(
        target.absolute,
        MAX_READ_BYTES,
        workspace.rootPath,
      );
      return { content };
    },
  };

  const create_directory: BuiltinTool = {
    meta: { approval: 'always', workspaceAccess: 'write' },
    spec: {
      name: 'create_directory',
      description: 'Create a directory inside the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    handler: async (args, context) => {
      const workspace = requireWorkspace(manager, context.workspaceId);
      const resolver = new WorkspacePathResolver(workspace.rootPath);
      const target = await resolver.resolve(String(args.path));
      if (target.exists) fail('Directory already exists.');
      await fs.mkdir(target.absolute, { recursive: true });
      const stat = await fs.lstat(target.absolute);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        fail('Path is not a directory.');
      }
      return { content: `Created directory ${target.relative}` };
    },
  };

  const write_file: BuiltinTool = {
    meta: { approval: 'always', workspaceAccess: 'write' },
    spec: {
      name: 'write_file',
      description:
        'Create or overwrite a text file. overwrite must be true to replace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          overwrite: { type: 'boolean' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    handler: async (args, context) => {
      const workspace = requireWorkspace(manager, context.workspaceId);
      const resolver = new WorkspacePathResolver(workspace.rootPath);
      const target = await resolver.resolve(String(args.path));
      const content = String(args.content);
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_WRITE_BYTES) {
        fail(`Content exceeds ${MAX_WRITE_BYTES} byte write limit.`);
      }
      const overwrite = args.overwrite === true;
      if (overwrite) {
        if (!target.exists) {
          await fs.mkdir(path.dirname(target.absolute), { recursive: true });
          await writeFileExclusive(
            target.absolute,
            content,
            workspace.rootPath,
          );
          return {
            content: `Wrote ${target.relative} (${bytes} bytes)`,
          };
        }
        await writeFileOverwrite(target.absolute, content, workspace.rootPath);
        return {
          content: `Overwrote ${target.relative} (${bytes} bytes)`,
        };
      }
      // No overwrite: O_EXCL create so a file appearing after resolve cannot be replaced.
      if (target.exists) {
        fail('File exists; set overwrite=true to replace.');
      }
      await fs.mkdir(path.dirname(target.absolute), { recursive: true });
      await writeFileExclusive(target.absolute, content, workspace.rootPath);
      return {
        content: `Wrote ${target.relative} (${bytes} bytes)`,
      };
    },
  };

  const edit_file: BuiltinTool = {
    meta: { approval: 'always', workspaceAccess: 'write' },
    spec: {
      name: 'edit_file',
      description:
        'Replace exactly one occurrence of oldText with newText in a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldText: { type: 'string' },
          newText: { type: 'string' },
        },
        required: ['path', 'oldText', 'newText'],
        additionalProperties: false,
      },
    },
    handler: async (args, context) => {
      const workspace = requireWorkspace(manager, context.workspaceId);
      const resolver = new WorkspacePathResolver(workspace.rootPath);
      const target = await resolver.resolve(String(args.path));
      if (!target.exists) fail('File was not found.');
      const original = await readFileText(
        target.absolute,
        MAX_READ_BYTES,
        workspace.rootPath,
      );
      const oldText = String(args.oldText);
      const newText = String(args.newText);
      const first = original.indexOf(oldText);
      if (first < 0) fail('oldText was not found.');
      const second = original.indexOf(oldText, first + oldText.length);
      if (second >= 0) fail('oldText matched more than once.');
      const next =
        original.slice(0, first) +
        newText +
        original.slice(first + oldText.length);
      if (Buffer.byteLength(next, 'utf8') > MAX_WRITE_BYTES) {
        fail(`Edited content exceeds ${MAX_WRITE_BYTES} byte write limit.`);
      }
      await writeFileOverwrite(target.absolute, next, workspace.rootPath);
      return { content: `Edited ${target.relative}` };
    },
  };

  return [list_directory, read_file, create_directory, write_file, edit_file];
}
