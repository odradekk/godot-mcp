/**
 * Scene and resource tools, run as godot_operations.gd operations in headless Godot.
 */

import { importProject, operationTool, scriptOperation } from '../operations.js';
import { Param, ToolContext, ToolDefinition, projectPathParam, textReply } from '../tool-requests.js';

// How godot_operations.gd resolves node paths; stated in every node path parameter
const NODE_PATH_RULE = 'Node paths: "" or "root" is the scene root, and a leading "root/" is optional, so "root/Player" and "Player" are the same node.';

const UID_SUPPORT = {
  version: [4, 4] as [number, number],
  feature: 'UIDs',
  solutions: ['Upgrade to Godot 4.4 or later to use UIDs', 'Use resource paths instead of UIDs for this version of Godot'],
};

/** A parameter naming an existing scene file in the project */
export function sceneFile(description: string): Param {
  return { type: 'string', description, check: 'existingFile', label: 'Scene file', hint: 'Use create_scene to create a new scene first' };
}

export function sceneTools(ctx: ToolContext): ToolDefinition[] {
  const projectPath = projectPathParam;
  return [
    operationTool<{ scenePath: string }>(ctx, {
      name: 'create_scene',
      description: 'Create a new Godot scene file',
      params: {
        projectPath,
        scenePath: { type: 'string', description: 'Path where the scene file will be saved (relative to project)', check: 'projectFile' },
        rootNodeType: { type: 'string', description: 'Type of the root node (e.g., Node2D, Node3D)', check: 'className' },
      },
      required: ['projectPath', 'scenePath'],
      failure: 'Failed to create scene',
      solutions: [
        'Check if the root node type is valid',
        'Ensure you have write permissions to the scene path',
        'Verify the scene path is valid',
      ],
      render: (result) => `Scene created successfully at: ${result.scenePath}`,
    }),
    operationTool<{ nodePath: string; nodeType: string; scenePath: string }>(ctx, {
      name: 'add_node',
      description: 'Add a node to an existing scene',
      params: {
        projectPath,
        scenePath: sceneFile('Path to the scene file (relative to project)'),
        parentNodePath: {
          type: 'string',
          description: `Path to the parent node (default: the scene root). ${NODE_PATH_RULE}`,
        },
        nodeType: { type: 'string', description: 'Type of node to add (e.g., Sprite2D, CollisionShape2D)', check: 'className' },
        nodeName: { type: 'string', description: 'Name for the new node' },
        properties: { type: 'object', description: 'Optional properties to set on the node' },
      },
      required: ['projectPath', 'scenePath', 'nodeType', 'nodeName'],
      failure: 'Failed to add node',
      solutions: [
        'Check if the node type is valid',
        'Ensure the parent node path exists',
        'Verify the scene file is valid',
      ],
      render: (result, args) =>
        `Node '${args.nodeName}' of type '${result.nodeType}' added successfully at ${result.nodePath} in '${result.scenePath}'.`,
    }),
    operationTool<{ texturePath: string; nodePath: string; scenePath: string }>(ctx, {
      name: 'load_sprite',
      description: 'Load a sprite into a Sprite2D node',
      params: {
        projectPath,
        scenePath: sceneFile('Path to the scene file (relative to project)'),
        nodePath: {
          type: 'string',
          description: `Path to the Sprite2D, Sprite3D or TextureRect node (e.g., "root/Player/Sprite2D"). ${NODE_PATH_RULE}`,
        },
        texturePath: {
          type: 'string',
          description: 'Path to the texture file (relative to project)',
          check: 'existingFile',
          label: 'Texture file',
          hint: 'Upload or create the texture file first',
        },
      },
      required: ['projectPath', 'scenePath', 'nodePath', 'texturePath'],
      failure: 'Failed to load sprite',
      solutions: [
        'Check if the node path is correct',
        'Ensure the node is a Sprite2D, Sprite3D, or TextureRect',
        'Verify the texture file is a valid image format',
      ],
      render: (result) =>
        `Sprite loaded successfully with texture: ${result.texturePath} on ${result.nodePath} in '${result.scenePath}'.`,
    }),
    operationTool<{ outputPath: string; items: string[] }>(ctx, {
      name: 'export_mesh_library',
      description: 'Export a scene as a MeshLibrary resource',
      params: {
        projectPath,
        scenePath: sceneFile('Path to the scene file (.tscn) to export'),
        outputPath: { type: 'string', description: 'Path where the mesh library (.res) will be saved', check: 'projectFile' },
        meshItemNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: Names of specific mesh items to include (defaults to all)',
        },
      },
      required: ['projectPath', 'scenePath', 'outputPath'],
      failure: 'Failed to export mesh library',
      solutions: [
        'Check if the scene contains valid 3D meshes',
        'Ensure the output path is valid',
        'Verify the scene file is valid',
      ],
      render: (result) =>
        `MeshLibrary exported successfully to: ${result.outputPath} (${result.items.length} items: ${result.items.join(', ')})`,
    }),
    operationTool<{ scenePath: string }>(ctx, {
      name: 'save_scene',
      description: 'Save changes to a scene file',
      params: {
        projectPath,
        scenePath: sceneFile('Path to the scene file (relative to project)'),
        newPath: { type: 'string', description: 'Optional: New path to save the scene to (for creating variants)', check: 'projectFile' },
      },
      required: ['projectPath', 'scenePath'],
      failure: 'Failed to save scene',
      solutions: [
        'Check if the scene file is valid',
        'Ensure you have write permissions to the output path',
        'Verify the scene can be properly packed',
      ],
      render: (result) => `Scene saved successfully to: ${result.scenePath}`,
    }),
    operationTool<Record<string, unknown>>(ctx, {
      name: 'get_uid',
      description: 'Get the UID for a specific file in a Godot project (for Godot 4.4+)',
      params: {
        projectPath,
        filePath: { type: 'string', description: 'Path to the file (relative to project) for which to get the UID', check: 'existingFile' },
      },
      required: ['projectPath', 'filePath'],
      failure: 'Failed to get UID',
      minGodot: UID_SUPPORT,
      solutions: ['Check if the file is a valid Godot resource', 'Ensure the file path is correct'],
      render: (result) => JSON.stringify(result, null, 2),
    }),
    {
      name: 'update_project_uids',
      description: 'Generate missing UIDs and resave resources in a Godot project (for Godot 4.4+)',
      params: { projectPath },
      required: ['projectPath'],
      failure: 'Failed to update project UIDs',
      minGodot: UID_SUPPORT,
      handle: async (args) => {
        const failure = 'Failed to update project UIDs';
        const solutions = ['Check if the project is valid', 'Ensure you have write permissions to the project directory'];
        // The editor's filesystem scan writes missing .uid files; ResourceSaver does not outside the editor
        await importProject(ctx, args.projectPath, failure, solutions);
        // The script scans res:// by default; args.projectPath is a disk path for --path and must not
        // be passed as the scan root.
        const result = await scriptOperation<{ scenesResaved: number; scriptsChecked: number }>(
          ctx,
          'resave_resources',
          {},
          args.projectPath,
          failure,
          solutions
        );
        return textReply(
          `Project UIDs updated successfully. Resaved ${result.scenesResaved} scenes; ${result.scriptsChecked} scripts and shaders have UIDs.`
        );
      },
    },
  ];
}
