/**
 * Finding the Godot executable: the configured path, then GODOT_PATH, then `godot` on PATH, then
 * the usual install locations for the platform.
 */

import { normalize } from 'path';

import { GodotLauncher } from './godot-launcher.js';

/**
 * The first candidate whose `--version` succeeds. Without one, strict mode rejects; otherwise a
 * default install location is returned even though it did not run.
 */
export async function findGodot(options: {
  configured?: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  launcher: GodotLauncher;
  strict: boolean;
  log(message: string): void;
}): Promise<string> {
  const { configured, env, platform, launcher, strict, log } = options;
  const candidates = [configured, env.GODOT_PATH, 'godot', ...installLocations(platform, env)]
    .filter((path): path is string => !!path)
    .map((path) => normalize(path));

  for (const path of new Set(candidates)) {
    if (await runsVersion(launcher, path)) {
      log(`Found Godot at: ${path}`);
      return path;
    }
    log(`Invalid Godot path: ${path}`);
  }

  console.error(`[SERVER] Could not find Godot in common locations for ${platform}`);
  console.error(`[SERVER] Set GODOT_PATH=/path/to/godot environment variable or pass { godotPath: '/path/to/godot' } in the config to specify the correct path.`);
  if (strict) {
    throw new Error(`Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.`);
  }
  const fallback = normalize(
    platform === 'win32' ? 'C:\\Program Files\\Godot\\Godot.exe' : platform === 'darwin' ? '/Applications/Godot.app/Contents/MacOS/Godot' : '/usr/bin/godot'
  );
  console.error(`[SERVER] Using default path: ${fallback}, but this may not work.`);
  console.error(`[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.`);
  return fallback;
}

function installLocations(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  switch (platform) {
    case 'darwin':
      return [
        '/Applications/Godot.app/Contents/MacOS/Godot',
        '/Applications/Godot_4.app/Contents/MacOS/Godot',
        `${env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
        `${env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`,
        `${env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`,
      ];
    case 'win32':
      return [
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe',
        'C:\\Program Files\\Godot_4\\Godot.exe',
        'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
        `${env.USERPROFILE}\\Godot\\Godot.exe`,
      ];
    case 'linux':
      return ['/usr/bin/godot', '/usr/local/bin/godot', '/snap/bin/godot', `${env.HOME}/.local/bin/godot`];
    default:
      return [];
  }
}

// A missing file makes the launcher reject, so no separate existence check is needed
async function runsVersion(launcher: GodotLauncher, path: string): Promise<boolean> {
  try {
    return (await launcher.run(path, ['--version'])).exitCode === 0;
  } catch {
    return false;
  }
}
