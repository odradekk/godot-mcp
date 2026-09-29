#!/usr/bin/env -S godot --headless --script
extends SceneTree

# Debug mode flag
var debug_mode = false

# Prefix of the single stdout line that carries the operation's outcome to the MCP server.
const RESULT_MARKER = "@@GODOT_MCP_RESULT@@ "

# Exit code passed to quit(); set by ok() and fail().
var exit_code = 0
# Whether ok() or fail() has run. Only the first report counts.
var reported = false

func _init():
    run_operation(OS.get_cmdline_args())
    # A script error aborts the running function but lets its caller continue, so an operation
    # that hit one (or forgot to report) ends up here without a result.
    if not reported:
        fail("Operation ended without reporting a result")
    quit(exit_code)

func run_operation(args):
    # Check for debug flag
    debug_mode = "--debug-godot" in args
    
    # Find the script argument and determine the positions of operation and params
    var script_index = args.find("--script")
    if script_index == -1:
        return fail("Could not find --script argument")
    
    # The operation should be 2 positions after the script path (script_index + 1 is the script path itself)
    var operation_index = script_index + 2
    # The params should be 3 positions after the script path
    var params_index = script_index + 3
    
    if args.size() <= params_index:
        return fail("Not enough command-line arguments. Usage: godot --headless --script godot_operations.gd <operation> <json_params>")
    
    # Log all arguments for debugging
    log_debug("All arguments: " + str(args))
    log_debug("Script index: " + str(script_index))
    log_debug("Operation index: " + str(operation_index))
    log_debug("Params index: " + str(params_index))
    
    var operation = args[operation_index]
    var params_json = args[params_index]
    
    log_info("Operation: " + operation)
    log_debug("Params JSON: " + params_json)
    
    # Parse JSON using Godot 4.x API
    var json = JSON.new()
    var error = json.parse(params_json)
    if error != OK:
        return fail("Failed to parse JSON parameters: " + json.get_error_message() + " at line " + str(json.get_error_line()) + ": " + params_json)
    
    var params = json.get_data()
    if typeof(params) != TYPE_DICTIONARY:
        return fail("Failed to parse JSON parameters: expected an object, got: " + params_json)
    
    log_info("Executing operation: " + operation)
    
    match operation:
        "create_scene":
            create_scene(params)
        "add_node":
            add_node(params)
        "load_sprite":
            load_sprite(params)
        "export_mesh_library":
            export_mesh_library(params)
        "save_scene":
            save_scene(params)
        "get_uid":
            get_uid(params)
        "resave_resources":
            resave_resources(params)
        _:
            fail("Unknown operation: " + operation)

# Report success with a JSON-serializable result.
func ok(result = {}):
    report({"ok": true, "result": result})

# Report failure. Returns nothing, so operations can end with `return fail(...)`.
func fail(message):
    printerr("[ERROR] " + message)
    report({"ok": false, "error": message})

func report(outcome):
    if reported:
        return
    reported = true
    exit_code = 0 if outcome.ok else 1
    print(RESULT_MARKER + JSON.stringify(outcome))

# Logging functions
func log_debug(message):
    if debug_mode:
        print("[DEBUG] " + message)

func log_info(message):
    print("[INFO] " + message)

# Get a script by registered class name.
# Only looks up names via the project's global class registry. Raw paths
# (e.g. "res://evil.gd") are intentionally not accepted here to prevent
# arbitrary script instantiation from agent-supplied input.
func get_script_by_name(name_of_class):
    if debug_mode:
        print("Attempting to get script for class: " + name_of_class)

    # Search for it in the global class registry if it's a class name
    var global_classes = ProjectSettings.get_global_class_list()
    if debug_mode:
        print("Searching through " + str(global_classes.size()) + " global classes")
    
    for global_class in global_classes:
        var found_name_of_class = global_class["class"]
        var found_path = global_class["path"]
        
        if found_name_of_class == name_of_class:
            if debug_mode:
                print("Found matching class in registry: " + found_name_of_class + " at path: " + found_path)
            var script = load(found_path) as Script
            if script:
                if debug_mode:
                    print("Successfully loaded script from registry")
                return script
            else:
                printerr("Failed to load script from registry path: " + found_path)
                break
    
    printerr("Could not find script for class: " + name_of_class)
    return null

# Instantiate a class by name
func instantiate_class(name_of_class):
    if name_of_class.is_empty():
        printerr("Cannot instantiate class: name is empty")
        return null
    
    var result = null
    if debug_mode:
        print("Attempting to instantiate class: " + name_of_class)
    
    # Check if it's a built-in class
    if ClassDB.class_exists(name_of_class):
        if debug_mode:
            print("Class exists in ClassDB, using ClassDB.instantiate()")
        if ClassDB.can_instantiate(name_of_class):
            result = ClassDB.instantiate(name_of_class)
            if result == null:
                printerr("ClassDB.instantiate() returned null for class: " + name_of_class)
        else:
            printerr("Class exists but cannot be instantiated: " + name_of_class)
            printerr("This may be an abstract class or interface that cannot be directly instantiated")
    else:
        # Try to get the script
        if debug_mode:
            print("Class not found in ClassDB, trying to get script")
        var script = get_script_by_name(name_of_class)
        if script is GDScript:
            if debug_mode:
                print("Found GDScript, creating instance")
            result = script.new()
        else:
            printerr("Failed to get script for class: " + name_of_class)
            return null
    
    if result == null:
        printerr("Failed to instantiate class: " + name_of_class)
    elif debug_mode:
        print("Successfully instantiated class: " + name_of_class + " of type: " + result.get_class())
    
    return result

# Create a new scene with a specified root node type
func create_scene(params):
    # Normalize the scene path
    var full_scene_path = params.scenePath
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)
    log_debug("Scene path: " + full_scene_path + " (" + absolute_scene_path + ")")
    
    var root_node_type = "Node2D"  # Default value
    if params.has("rootNodeType"):
        root_node_type = params.rootNodeType
    
    # Create the root node
    var scene_root = instantiate_class(root_node_type)
    if not scene_root:
        return fail("Failed to instantiate node of type: " + root_node_type + ". It must be a Godot class that can be instantiated or a global script class (class_name).")
    scene_root.name = "root"
    # Set the owner of the root node to itself (important for scene saving)
    scene_root.owner = scene_root
    
    var packed_scene = PackedScene.new()
    var result = packed_scene.pack(scene_root)
    if result != OK:
        return fail("Failed to pack scene: " + error_string(result))
    
    # Create the scene directory if needed
    var scene_dir_abs = absolute_scene_path.get_base_dir()
    if not DirAccess.dir_exists_absolute(scene_dir_abs):
        log_debug("Creating directory: " + scene_dir_abs)
        var make_dir_error = DirAccess.make_dir_recursive_absolute(scene_dir_abs)
        if make_dir_error != OK:
            return fail("Failed to create directory: " + scene_dir_abs + ", error: " + error_string(make_dir_error))
    
    var save_error = ResourceSaver.save(packed_scene, full_scene_path)
    if save_error != OK:
        return fail("Failed to save scene " + full_scene_path + ": " + error_string(save_error))
    if not FileAccess.file_exists(full_scene_path):
        return fail("Scene reported as saved but does not exist at: " + full_scene_path)
    
    ok({"scenePath": full_scene_path, "rootNodeType": root_node_type})

# Add a node to an existing scene
func add_node(params):
    print("Adding node to scene: " + params.scenePath)
    
    var full_scene_path = params.scenePath
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    if debug_mode:
        print("Scene path (with res://): " + full_scene_path)
    
    var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)
    if debug_mode:
        print("Absolute scene path: " + absolute_scene_path)
    
    if not FileAccess.file_exists(absolute_scene_path):
        return fail("Scene file does not exist at: " + absolute_scene_path)
    
    var scene = load(full_scene_path)
    if not scene:
        return fail("Failed to load scene: " + full_scene_path)
    
    if debug_mode:
        print("Scene loaded successfully")
    var scene_root = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")
    
    # Use traditional if-else statement for better compatibility
    var parent_path = "root"  # Default value
    if params.has("parentNodePath"):
        parent_path = params.parentNodePath
    if debug_mode:
        print("Parent path: " + parent_path)
    
    var parent = scene_root
    if parent_path != "root":
        parent = scene_root.get_node(parent_path.replace("root/", ""))
        if not parent:
            return fail("Parent node not found: " + parent_path)
    if debug_mode:
        print("Parent node found: " + parent.name)
    
    if debug_mode:
        print("Instantiating node of type: " + params.nodeType)
    var new_node = instantiate_class(params.nodeType)
    if not new_node:
        return fail("Failed to instantiate node of type: " + params.nodeType + ". It must be a Godot class that can be instantiated or a global script class (class_name).")
    new_node.name = params.nodeName
    if debug_mode:
        print("New node created with name: " + new_node.name)
    
    if params.has("properties"):
        if debug_mode:
            print("Setting properties on node")
        var properties = params.properties
        for property in properties:
            if debug_mode:
                print("Setting property: " + property + " = " + str(properties[property]))
            var value = properties[property]
            var property_type = get_property_type(new_node, property)
            if property_type == -1:
                return fail("Unknown property '" + property + "' on node type: " + params.nodeType)
            if typeof(value) == TYPE_STRING and value.begins_with("res://"):
                value = load(value)
                if debug_mode:
                    print("Loaded resource for property: " + property + " -> " + str(value))
            elif typeof(value) == TYPE_DICTIONARY and property_type != TYPE_DICTIONARY:
                value = dictionary_to_type(value, property_type)
                if value == null:
                    return fail("Cannot convert " + JSON.stringify(properties[property]) + " to " + type_string(property_type) + " for property: " + property)
            new_node.set(property, value)
    
    parent.add_child(new_node)
    new_node.owner = scene_root
    if debug_mode:
        print("Node added to parent and ownership set")
    
    var packed_scene = PackedScene.new()
    var result = packed_scene.pack(scene_root)
    if result != OK:
        return fail("Failed to pack scene: " + error_string(result))
    var save_error = ResourceSaver.save(packed_scene, absolute_scene_path)
    if save_error != OK:
        return fail("Failed to save scene " + full_scene_path + ": " + error_string(save_error))

    ok({
        "scenePath": full_scene_path,
        "nodePath": scene_node_path(scene_root, new_node),
        "nodeType": params.nodeType,
    })

# Path of `node` in the "root/..." form the tools accept
func scene_node_path(scene_root, node):
    if node == scene_root:
        return "root"
    return "root/" + str(scene_root.get_path_to(node))

# Returns the declared Variant type of a property, or -1 if the object has no such property
func get_property_type(obj, property):
    for p in obj.get_property_list():
        if p.name == property:
            return p.type
    return -1

# JSON has no vector or color types, and Node.set() silently ignores a Dictionary it cannot
# convert, so {"x", "y"[, "z"]} and {"r", "g", "b"[, "a"]} objects are converted explicitly.
# Returns null when the dictionary does not fit the target type.
func dictionary_to_type(value, type):
    match type:
        TYPE_VECTOR2, TYPE_VECTOR2I:
            if value.has_all(["x", "y"]):
                return type_convert(Vector2(value.x, value.y), type)
        TYPE_VECTOR3, TYPE_VECTOR3I:
            if value.has_all(["x", "y", "z"]):
                return type_convert(Vector3(value.x, value.y, value.z), type)
        TYPE_COLOR:
            if value.has_all(["r", "g", "b"]):
                return Color(value.r, value.g, value.b, value.get("a", 1.0))
    return null

# Load a sprite into a Sprite2D node
func load_sprite(params):
    print("Loading sprite into scene: " + params.scenePath)
    
    # Ensure the scene path starts with res:// for Godot's resource system
    var full_scene_path = params.scenePath
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    
    if debug_mode:
        print("Full scene path (with res://): " + full_scene_path)
    
    # Check if the scene file exists
    var file_check = FileAccess.file_exists(full_scene_path)
    if debug_mode:
        print("Scene file exists check: " + str(file_check))
    
    if not file_check:
        return fail("Scene file does not exist at: " + full_scene_path)
    
    # Ensure the texture path starts with res:// for Godot's resource system
    var full_texture_path = params.texturePath
    if not full_texture_path.begins_with("res://"):
        full_texture_path = "res://" + full_texture_path
    
    if debug_mode:
        print("Full texture path (with res://): " + full_texture_path)
    
    # Load the scene
    var scene = load(full_scene_path)
    if not scene:
        return fail("Failed to load scene: " + full_scene_path)
    
    if debug_mode:
        print("Scene loaded successfully")
    
    # Instance the scene
    var scene_root = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")
    
    # Find the sprite node
    var node_path = params.nodePath
    if debug_mode:
        print("Original node path: " + node_path)
    
    if node_path.begins_with("root/"):
        node_path = node_path.substr(5)  # Remove "root/" prefix
        if debug_mode:
            print("Node path after removing 'root/' prefix: " + node_path)
    
    var sprite_node = null
    if node_path == "":
        # If no node path, assume root is the sprite
        sprite_node = scene_root
        if debug_mode:
            print("Using root node as sprite node")
    else:
        sprite_node = scene_root.get_node(node_path)
        if sprite_node and debug_mode:
            print("Found sprite node: " + sprite_node.name)
    
    if not sprite_node:
        return fail("Node not found: " + params.nodePath)
    
    # Check if the node is a Sprite2D or compatible type
    if debug_mode:
        print("Node class: " + sprite_node.get_class())
    if not (sprite_node is Sprite2D or sprite_node is Sprite3D or sprite_node is TextureRect):
        return fail("Node is not a sprite-compatible type: " + sprite_node.get_class())
    
    # Load the texture
    if debug_mode:
        print("Loading texture from: " + full_texture_path)
    var texture = load(full_texture_path)
    if not texture:
        return fail("Failed to load texture: " + full_texture_path)
    
    if debug_mode:
        print("Texture loaded successfully")
    
    # Set the texture on the sprite
    if sprite_node is Sprite2D or sprite_node is Sprite3D:
        sprite_node.texture = texture
        if debug_mode:
            print("Set texture on Sprite2D/Sprite3D node")
    elif sprite_node is TextureRect:
        sprite_node.texture = texture
        if debug_mode:
            print("Set texture on TextureRect node")
    
    # Save the modified scene
    var packed_scene = PackedScene.new()
    var result = packed_scene.pack(scene_root)
    if result != OK:
        return fail("Failed to pack scene: " + error_string(result))
    var error = ResourceSaver.save(packed_scene, full_scene_path)
    if error != OK:
        return fail("Failed to save scene " + full_scene_path + ": " + error_string(error))

    ok({
        "scenePath": full_scene_path,
        "nodePath": scene_node_path(scene_root, sprite_node),
        "texturePath": full_texture_path,
    })

# Export a scene as a MeshLibrary resource
func export_mesh_library(params):
    print("Exporting MeshLibrary from scene: " + params.scenePath)
    
    # Ensure the scene path starts with res:// for Godot's resource system
    var full_scene_path = params.scenePath
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    
    if debug_mode:
        print("Full scene path (with res://): " + full_scene_path)
    
    # Ensure the output path starts with res:// for Godot's resource system
    var full_output_path = params.outputPath
    if not full_output_path.begins_with("res://"):
        full_output_path = "res://" + full_output_path
    
    if debug_mode:
        print("Full output path (with res://): " + full_output_path)
    
    # Check if the scene file exists
    var file_check = FileAccess.file_exists(full_scene_path)
    if debug_mode:
        print("Scene file exists check: " + str(file_check))
    
    if not file_check:
        return fail("Scene file does not exist at: " + full_scene_path)
    
    # Load the scene
    if debug_mode:
        print("Loading scene from: " + full_scene_path)
    var scene = load(full_scene_path)
    if not scene:
        return fail("Failed to load scene: " + full_scene_path)
    
    if debug_mode:
        print("Scene loaded successfully")
    
    # Instance the scene
    var scene_root = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")
    
    # Create a new MeshLibrary
    var mesh_library = MeshLibrary.new()
    if debug_mode:
        print("Created new MeshLibrary")
    
    # Get mesh item names if provided
    var mesh_item_names = params.meshItemNames if params.has("meshItemNames") else []
    var use_specific_items = mesh_item_names.size() > 0
    
    if debug_mode:
        if use_specific_items:
            print("Using specific mesh items: " + str(mesh_item_names))
        else:
            print("Using all mesh items in the scene")
    
    # Process all child nodes
    var item_id = 0
    if debug_mode:
        print("Processing child nodes...")
    
    for child in scene_root.get_children():
        if debug_mode:
            print("Checking child node: " + child.name)
        
        # Skip if not using all items and this item is not in the list
        if use_specific_items and not (child.name in mesh_item_names):
            if debug_mode:
                print("Skipping node " + child.name + " (not in specified items list)")
            continue
            
        # Check if the child has a mesh
        var mesh_instance = null
        if child is MeshInstance3D:
            mesh_instance = child
            if debug_mode:
                print("Node " + child.name + " is a MeshInstance3D")
        else:
            # Try to find a MeshInstance3D in the child's descendants
            if debug_mode:
                print("Searching for MeshInstance3D in descendants of " + child.name)
            for descendant in child.get_children():
                if descendant is MeshInstance3D:
                    mesh_instance = descendant
                    if debug_mode:
                        print("Found MeshInstance3D in descendant: " + descendant.name)
                    break
        
        if mesh_instance and mesh_instance.mesh:
            if debug_mode:
                print("Adding mesh: " + child.name)
            
            # Add the mesh to the library
            mesh_library.create_item(item_id)
            mesh_library.set_item_name(item_id, child.name)
            mesh_library.set_item_mesh(item_id, mesh_instance.mesh)
            if debug_mode:
                print("Added mesh to library with ID: " + str(item_id))
            
            # Add collision shape if available
            var collision_added = false
            for collision_child in child.get_children():
                if collision_child is CollisionShape3D and collision_child.shape:
                    mesh_library.set_item_shapes(item_id, [collision_child.shape])
                    if debug_mode:
                        print("Added collision shape from: " + collision_child.name)
                    collision_added = true
                    break
            
            if debug_mode and not collision_added:
                print("No collision shape found for mesh: " + child.name)
            
            # Add preview if available
            if mesh_instance.mesh:
                mesh_library.set_item_preview(item_id, mesh_instance.mesh)
                if debug_mode:
                    print("Added preview for mesh: " + child.name)
            
            item_id += 1
        elif debug_mode:
            print("Node " + child.name + " has no valid mesh")
    
    if debug_mode:
        print("Processed " + str(item_id) + " meshes")
    
    # Create directory if it doesn't exist
    var dir = DirAccess.open("res://")
    if dir == null:
        return fail("Failed to open res:// directory, error: " + str(DirAccess.get_open_error()))
        
    var output_dir = full_output_path.get_base_dir()
    if debug_mode:
        print("Output directory: " + output_dir)
    
    if output_dir != "res://" and not dir.dir_exists(output_dir.substr(6)):  # Remove "res://" prefix
        if debug_mode:
            print("Creating directory: " + output_dir)
        var error = dir.make_dir_recursive(output_dir.substr(6))  # Remove "res://" prefix
        if error != OK:
            return fail("Failed to create directory: " + output_dir + ", error: " + str(error))
    
    # Save the mesh library
    if item_id == 0:
        return fail("No valid meshes found in the scene")
    var save_error = ResourceSaver.save(mesh_library, full_output_path)
    if save_error != OK:
        return fail("Failed to save MeshLibrary " + full_output_path + ": " + error_string(save_error))

    var items = []
    for id in mesh_library.get_item_list():
        items.append(mesh_library.get_item_name(id))
    ok({"outputPath": full_output_path, "items": items})

# Find files with a specific extension recursively
# Directories that cannot be opened are appended to `problems`.
func find_files(path, extension, problems):
    var files = []
    var dir = DirAccess.open(path)
    
    if dir == null:
        problems.append("Failed to open directory: " + path + ", error: " + error_string(DirAccess.get_open_error()))
    else:
        dir.list_dir_begin()
        var file_name = dir.get_next()
        
        while file_name != "":
            if dir.current_is_dir() and not file_name.begins_with("."):
                files.append_array(find_files(path + file_name + "/", extension, problems))
            elif file_name.ends_with(extension):
                files.append(path + file_name)
            
            file_name = dir.get_next()
    
    return files

# Get UID for a specific file
func get_uid(params):
    if not params.has("filePath"):
        return fail("File path is required")
    
    # Ensure the file path starts with res:// for Godot's resource system
    var file_path = params.filePath
    if not file_path.begins_with("res://"):
        file_path = "res://" + file_path
    
    print("Getting UID for file: " + file_path)
    if debug_mode:
        print("Full file path (with res://): " + file_path)
    
    # Get the absolute path for reference
    var absolute_path = ProjectSettings.globalize_path(file_path)
    if debug_mode:
        print("Absolute file path: " + absolute_path)
    
    # Ensure the file exists
    var file_check = FileAccess.file_exists(file_path)
    if debug_mode:
        print("File exists check: " + str(file_check))
    
    if not file_check:
        return fail("File does not exist at: " + file_path)
    
    # Imported resources (e.g. textures) keep their UID in the .import file rather than a .uid
    # sidecar, so ask the resource loader instead of reading files directly.
    var uid = ResourceLoader.get_resource_uid(file_path)
    var result = {
        "file": file_path,
        "absolutePath": absolute_path,
        "exists": uid != ResourceUID.INVALID_ID
    }
    if result.exists:
        result.uid = ResourceUID.id_to_text(uid)
    else:
        result.message = "No UID found for this file. Use update_project_uids to generate UIDs."
    ok(result)

# Resave all resources to update UID references
func resave_resources(params):
    print("Resaving all resources to update UID references...")
    
    # Get project path if provided
    var project_path = "res://"
    if params.has("projectPath"):
        project_path = params.projectPath
        if not project_path.begins_with("res://"):
            project_path = "res://" + project_path
        if not project_path.ends_with("/"):
            project_path += "/"
    
    if debug_mode:
        print("Using project path: " + project_path)
    
    # Get all .tscn files
    if debug_mode:
        print("Searching for scene files in: " + project_path)
    var problems = []
    var scenes = find_files(project_path, ".tscn", problems)
    if debug_mode:
        print("Found " + str(scenes.size()) + " scenes")
    
    # Resave each scene
    var success_count = 0
    var error_count = 0
    
    for scene_path in scenes:
        if debug_mode:
            print("Processing scene: " + scene_path)
        
        # Check if the scene file exists
        var file_check = FileAccess.file_exists(scene_path)
        if debug_mode:
            print("Scene file exists check: " + str(file_check))
        
        if not file_check:
            problems.append("Scene file does not exist at: " + scene_path)
            error_count += 1
            continue
        
        # Load the scene
        var scene = load(scene_path)
        if scene:
            if debug_mode:
                print("Scene loaded successfully, saving...")
            var error = ResourceSaver.save(scene, scene_path)
            if debug_mode:
                print("Save result: " + str(error) + " (OK=" + str(OK) + ")")
            
            if error == OK:
                success_count += 1
                if debug_mode:
                    print("Scene saved successfully: " + scene_path)
            else:
                error_count += 1
                problems.append("Failed to save: " + scene_path + ", error: " + error_string(error))
        else:
            error_count += 1
            problems.append("Failed to load: " + scene_path)
    
    # Get all .gd and .gdshader files (Godot 3 .shader files are not Godot 4 resources and have no UID)
    if debug_mode:
        print("Searching for script and shader files in: " + project_path)
    var scripts = find_files(project_path, ".gd", problems) + find_files(project_path, ".gdshader", problems)
    if debug_mode:
        print("Found " + str(scripts.size()) + " scripts/shaders")
    
    # Missing .uid files are generated beforehand by the editor's filesystem scan (godot --import).
    # ResourceSaver does not write them when running outside the editor, so only verify here.
    var missing_uids = 0
    for script_path in scripts:
        if ResourceLoader.get_resource_uid(script_path) == ResourceUID.INVALID_ID:
            missing_uids += 1
            problems.append("No UID for: " + script_path)
        elif debug_mode:
            print("UID exists for: " + script_path)
    
    if debug_mode:
        print("Summary:")
        print("- Scenes processed: " + str(scenes.size()))
        print("- Scenes successfully saved: " + str(success_count))
        print("- Scenes with errors: " + str(error_count))
        print("- Scripts/shaders missing UIDs: " + str(missing_uids))
    
    if not problems.is_empty():
        return fail(str(problems.size()) + " problem(s) while resaving resources: " + "; ".join(problems))
    ok({"scenesResaved": success_count, "scriptsChecked": scripts.size()})

# Save changes to a scene file
func save_scene(params):
    print("Saving scene: " + params.scenePath)
    
    # Ensure the scene path starts with res:// for Godot's resource system
    var full_scene_path = params.scenePath
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    
    if debug_mode:
        print("Full scene path (with res://): " + full_scene_path)
    
    # Check if the scene file exists
    var file_check = FileAccess.file_exists(full_scene_path)
    if debug_mode:
        print("Scene file exists check: " + str(file_check))
    
    if not file_check:
        return fail("Scene file does not exist at: " + full_scene_path)
    
    # Load the scene
    var scene = load(full_scene_path)
    if not scene:
        return fail("Failed to load scene: " + full_scene_path)
    
    if debug_mode:
        print("Scene loaded successfully")
    
    # Instance the scene
    var scene_root = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")
    
    # Determine save path
    var save_path = params.newPath if params.has("newPath") else full_scene_path
    if params.has("newPath") and not save_path.begins_with("res://"):
        save_path = "res://" + save_path
    
    if debug_mode:
        print("Save path: " + save_path)
    
    # Create directory if it doesn't exist
    if params.has("newPath"):
        var dir = DirAccess.open("res://")
        if dir == null:
            return fail("Failed to open res:// directory, error: " + str(DirAccess.get_open_error()))
            
        var scene_dir = save_path.get_base_dir()
        if debug_mode:
            print("Scene directory: " + scene_dir)
        
        if scene_dir != "res://" and not dir.dir_exists(scene_dir.substr(6)):  # Remove "res://" prefix
            if debug_mode:
                print("Creating directory: " + scene_dir)
            var error = dir.make_dir_recursive(scene_dir.substr(6))  # Remove "res://" prefix
            if error != OK:
                return fail("Failed to create directory: " + scene_dir + ", error: " + str(error))
    
    # Create a packed scene
    var packed_scene = PackedScene.new()
    var result = packed_scene.pack(scene_root)
    if result != OK:
        return fail("Failed to pack scene: " + error_string(result))
    var save_error = ResourceSaver.save(packed_scene, save_path)
    if save_error != OK:
        return fail("Failed to save scene " + save_path + ": " + error_string(save_error))

    ok({"scenePath": save_path})
