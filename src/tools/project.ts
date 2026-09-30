/**
 * Project tools: the editor, the Godot version, and finding and describing projects.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { basename, join } from 'path';

import { ToolContext, ToolDefinition, jsonReply, projectPathParam, textReply } from '../tool-requests.js';

const ASSET_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'];

export function projectTools(ctx: ToolContext): ToolDefinition[] {
  return [
    {
      name: 'launch_editor',
      description: 'Launch Godot editor for a specific project',
      params: { projectPath: projectPathParam },
      required: ['projectPath'],
      failure: 'Failed to launch Godot editor',
      handle: async (args) => {
        ctx.log(`Launching Godot editor for project: ${args.projectPath}`);
        // Detached: the editor belongs to the user and keeps running after this server exits
        const process = ctx.launcher.start(ctx.godotPath, ['-e', '--path', args.projectPath], { detached: true });
        process.on('error', (err: Error) => {
          console.error('Failed to start Godot editor:', err);
        });
        return textReply(`Godot editor launched successfully for project at ${args.projectPath}.`);
      },
    },
    {
      name: 'get_godot_version',
      description: 'Get the installed Godot version',
      params: {},
      required: [],
      failure: 'Failed to get Godot version',
      handle: async () => textReply(await ctx.godotVersion()),
    },
    {
      name: 'list_projects',
      description: 'List Godot projects in a directory, skipping hidden directories',
      params: {
        directory: { type: 'string', description: 'Directory to search for Godot projects', check: 'directory' },
        recursive: { type: 'boolean', description: 'Whether to search recursively (default: false)', default: false },
      },
      required: ['directory'],
      failure: 'Failed to list projects',
      handle: async (args) => {
        ctx.log(`Listing Godot projects in directory: ${args.directory}`);
        return jsonReply(findGodotProjects(ctx, args.directory, args.recursive));
      },
    },
    {
      name: 'get_project_info',
      description: 'Retrieve metadata about a Godot project',
      params: { projectPath: projectPathParam },
      required: ['projectPath'],
      failure: 'Failed to get project info',
      handle: async (args) => {
        ctx.log(`Getting project info for: ${args.projectPath}`);
        return jsonReply({
          name: projectName(ctx, args.projectPath),
          path: args.projectPath,
          godotVersion: await ctx.godotVersion(),
          structure: projectStructure(ctx, args.projectPath),
        });
      },
    },
  ];
}

/**
 * Godot projects in `directory`: the directory itself and its subdirectories, or with `recursive`
 * every project below it. Hidden directories are skipped either way, and projects are not searched.
 */
function findGodotProjects(ctx: ToolContext, directory: string, recursive: boolean): Array<{ path: string; name: string }> {
  const projects: Array<{ path: string; name: string }> = [];
  try {
    if (existsSync(join(directory, 'project.godot'))) {
      projects.push({ path: directory, name: basename(directory) });
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const subdir = join(directory, entry.name);
      if (existsSync(join(subdir, 'project.godot'))) {
        projects.push({ path: subdir, name: entry.name });
      } else if (recursive) {
        projects.push(...findGodotProjects(ctx, subdir, true));
      }
    }
  } catch (error) {
    ctx.log(`Error searching directory ${directory}: ${error}`);
  }
  return projects;
}

/** The config/name in project.godot, or the directory name */
function projectName(ctx: ToolContext, projectPath: string): string {
  try {
    const match = readFileSync(join(projectPath, 'project.godot'), 'utf8').match(/config\/name="([^"]+)"/);
    if (match?.[1]) {
      ctx.log(`Found project name in config: ${match[1]}`);
      return match[1];
    }
  } catch (error) {
    ctx.log(`Error reading project file: ${error}`);
  }
  return basename(projectPath);
}

/** Counts of scenes, scripts, assets and other files, skipping hidden files and directories */
function projectStructure(ctx: ToolContext, projectPath: string) {
  const structure = { scenes: 0, scripts: 0, assets: 0, other: 0 };
  const scan = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.isFile()) structure[fileKind(entry.name)]++;
    }
  };
  try {
    scan(projectPath);
    return structure;
  } catch (error) {
    ctx.log(`Error getting project structure: ${error}`);
    return { error: 'Failed to get project structure', scenes: 0, scripts: 0, assets: 0, other: 0 };
  }
}

function fileKind(name: string): 'scenes' | 'scripts' | 'assets' | 'other' {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'tscn') return 'scenes';
  if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') return 'scripts';
  if (ASSET_EXTENSIONS.includes(ext)) return 'assets';
  return 'other';
}
