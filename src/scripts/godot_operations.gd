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

# --- Scene editing ---
# Shared by the scene operations. On failure these call fail(...) and return null or false,
# so the calling operation only needs to return.

# `path` relative to the project, or already a res:// path
func to_res_path(path):
    return path if path.begins_with("res://") else "res://" + path

# Load a scene file and instantiate it. Returns the scene's root node.
func load_scene_root(path):
    var res_path = to_res_path(path)
    if not FileAccess.file_exists(res_path):
        return fail("Scene file does not exist: " + res_path)
    var scene = load(res_path)
    if not scene is PackedScene:
        return fail("Not a scene file: " + res_path)
    return scene.instantiate()

# Find a node by the path the tools accept: "" or "root" is the scene root; otherwise a leading
# "root/" is removed once and the rest is relative to the scene root.
func find_scene_node(scene_root, node_path, scene_path):
    var relative = node_path
    if relative == "root":
        relative = ""
    elif relative.begins_with("root/"):
        relative = relative.substr(5)
    var node = scene_root if relative == "" else scene_root.get_node_or_null(relative)
    if not node:
        return fail("Node not found in " + to_res_path(scene_path) + ": " + node_path)
    return node

# Path of `node` in the "root/..." form the tools accept
func scene_node_path(scene_root, node):
    if node == scene_root:
        return "root"
    return "root/" + str(scene_root.get_path_to(node))

# Set properties given as JSON: res:// strings load the resource for properties that take one, and
# objects such as {"x": 1, "y": 2} are converted to the property's Vector or Color type.
func set_node_properties(node, properties):
    for property in properties:
        var value = properties[property]
        var property_type = get_property_type(node, property)
        if property_type == -1:
            fail("Unknown property '" + property + "' on node type: " + node.get_class())
            return false
        if property_type == TYPE_OBJECT and typeof(value) == TYPE_STRING and value.begins_with("res://"):
            value = load(value) if ResourceLoader.exists(value) else null
            if value == null:
                fail("Cannot load resource " + properties[property] + " for property: " + property)
                return false
        elif typeof(value) == TYPE_DICTIONARY and property_type != TYPE_DICTIONARY:
            value = dictionary_to_type(value, property_type)
            if value == null:
                fail("Cannot convert " + JSON.stringify(properties[property]) + " to " + type_string(property_type) + " for property: " + property)
                return false
        log_debug("Setting property: " + property + " = " + str(value))
        node.set(property, value)
    return true

# Returns the declared Variant type of a property, or -1 if the object has no such property
func get_property_type(obj, property):
    for p in obj.get_property_list():
        if p.name == property:
            return p.type
    return -1

# Convert a JSON object to a vector or color, or return null if it does not fit the type
func dictionary_to_type(value, type):
    match type:
        TYPE_VECTOR2, TYPE_VECTOR2I:
            if value.has("x") and value.has("y"):
                return type_convert(Vector2(value.x, value.y), type)
        TYPE_VECTOR3, TYPE_VECTOR3I:
            if value.has("x") and value.has("y") and value.has("z"):
                return type_convert(Vector3(value.x, value.y, value.z), type)
        TYPE_COLOR:
            if value.has("r") and value.has("g") and value.has("b"):
                return Color(value.r, value.g, value.b, value.get("a", 1.0))
    return null

# Save a resource, creating its directory if needed
func save_resource(resource, path):
    var res_path = to_res_path(path)
    var dir = ProjectSettings.globalize_path(res_path.get_base_dir())
    if not DirAccess.dir_exists_absolute(dir):
        log_debug("Creating directory: " + dir)
        var dir_error = DirAccess.make_dir_recursive_absolute(dir)
        if dir_error != OK:
            fail("Failed to create directory " + dir + ": " + error_string(dir_error))
            return false
    var save_error = ResourceSaver.save(resource, res_path)
    if save_error != OK:
        fail("Failed to save " + res_path + ": " + error_string(save_error))
        return false
    return true

# Pack a scene's nodes (those owned by scene_root) and save them
func save_scene_root(scene_root, path):
    var packed_scene = PackedScene.new()
    var pack_error = packed_scene.pack(scene_root)
    if pack_error != OK:
        fail("Failed to pack scene: " + error_string(pack_error))
        return false
    return save_resource(packed_scene, path)

# --- Scene operations ---

func create_scene(params):
    var root_node_type = params.get("rootNodeType", "Node2D")
    var scene_root = instantiate_class(root_node_type)
    if not scene_root:
        return fail("Failed to instantiate node of type: " + root_node_type + ". It must be a Godot class that can be instantiated or a global script class (class_name).")
    scene_root.name = "root"
    if not save_scene_root(scene_root, params.scenePath):
        return
    ok({"scenePath": to_res_path(params.scenePath), "rootNodeType": root_node_type})

# Add a node to an existing scene
func add_node(params):
    var scene_root = load_scene_root(params.scenePath)
    if not scene_root:
        return
    var parent = find_scene_node(scene_root, params.get("parentNodePath", "root"), params.scenePath)
    if not parent:
        return
    var new_node = instantiate_class(params.nodeType)
    if not new_node:
        return fail("Failed to instantiate node of type: " + params.nodeType + ". It must be a Godot class that can be instantiated or a global script class (class_name).")
    new_node.name = params.nodeName
    if params.has("properties") and not set_node_properties(new_node, params.properties):
        return
    parent.add_child(new_node)
    new_node.owner = scene_root
    if not save_scene_root(scene_root, params.scenePath):
        return
    ok({
        "scenePath": to_res_path(params.scenePath),
        "nodePath": scene_node_path(scene_root, new_node),
        "nodeType": params.nodeType,
    })

# Set the texture of a Sprite2D, Sprite3D or TextureRect node
func load_sprite(params):
    var scene_root = load_scene_root(params.scenePath)
    if not scene_root:
        return
    var sprite_node = find_scene_node(scene_root, params.nodePath, params.scenePath)
    if not sprite_node:
        return
    if not (sprite_node is Sprite2D or sprite_node is Sprite3D or sprite_node is TextureRect):
        return fail("Node is not a sprite-compatible type: " + sprite_node.get_class())
    var texture_path = to_res_path(params.texturePath)
    var texture = load(texture_path)
    if not texture is Texture2D:
        return fail("Failed to load texture: " + texture_path)
    sprite_node.texture = texture
    if not save_scene_root(scene_root, params.scenePath):
        return
    ok({
        "scenePath": to_res_path(params.scenePath),
        "nodePath": scene_node_path(scene_root, sprite_node),
        "texturePath": texture_path,
    })

# Export a scene as a MeshLibrary resource: one item per child that is, or directly contains,
# a MeshInstance3D with a mesh
func export_mesh_library(params):
    var scene_root = load_scene_root(params.scenePath)
    if not scene_root:
        return
    var mesh_item_names = params.get("meshItemNames", [])
    var mesh_library = MeshLibrary.new()
    var item_id = 0

    for child in scene_root.get_children():
        if mesh_item_names.size() > 0 and not (child.name in mesh_item_names):
            continue

        var mesh_instance = child if child is MeshInstance3D else null
        if not mesh_instance:
            for descendant in child.get_children():
                if descendant is MeshInstance3D:
                    mesh_instance = descendant
                    break
        if not (mesh_instance and mesh_instance.mesh):
            log_debug("Node " + child.name + " has no valid mesh")
            continue

        mesh_library.create_item(item_id)
        mesh_library.set_item_name(item_id, child.name)
        mesh_library.set_item_mesh(item_id, mesh_instance.mesh)
        mesh_library.set_item_preview(item_id, mesh_instance.mesh)
        for collision_child in child.get_children():
            if collision_child is CollisionShape3D and collision_child.shape:
                mesh_library.set_item_shapes(item_id, [collision_child.shape])
                break
        item_id += 1

    if item_id == 0:
        return fail("No valid meshes found in the scene")
    if not save_resource(mesh_library, params.outputPath):
        return

    var items = []
    for id in mesh_library.get_item_list():
        items.append(mesh_library.get_item_name(id))
    ok({"outputPath": to_res_path(params.outputPath), "items": items})

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
    var file_path = to_res_path(params.filePath)
    var absolute_path = ProjectSettings.globalize_path(file_path)
    if not FileAccess.file_exists(file_path):
        return fail("File does not exist: " + file_path)
    
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
        project_path = to_res_path(params.projectPath)
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

# Save a scene, optionally to a new path (creating its directory)
func save_scene(params):
    var scene_root = load_scene_root(params.scenePath)
    if not scene_root:
        return
    var save_path = params.get("newPath", params.scenePath)
    if not save_scene_root(scene_root, save_path):
        return
    ok({"scenePath": to_res_path(save_path)})
