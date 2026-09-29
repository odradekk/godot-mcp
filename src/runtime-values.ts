/**
 * Conversions between values in the running game (Variants from the remote debugger) and the JSON
 * that tools exchange with AI agents.
 */

import { TypedValue, Variant, VariantType, decodedVariantType } from './variant.js';

/** The path of a node in the running game, if `objectId` is one */
export type NodePathOf = (objectId: bigint) => string | undefined;

/**
 * JSON form of a value from the game:
 * - vectors, rects and transforms as number arrays, Color as `{ r, g, b, a }`
 * - a resource with a path (sent by Godot as that path) as `{ resource }`
 * - a node as `{ node: path }`, any other object as `{ objectId }`
 * - integers beyond JS precision as strings
 * `declaredType` is the property's declared type, when the game sent one.
 */
export function variantToJson(value: Variant, nodePathOf: NodePathOf, declaredType?: VariantType): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return declaredType === VariantType.OBJECT ? { resource: value } : value;
  if (isObjectReference(value)) {
    const path = nodePathOf(value.objectId);
    return path ? { node: path } : { objectId: value.objectId.toString() };
  }
  const type = decodedVariantType(value) ?? declaredType;
  if (Array.isArray(value)) {
    if (type === VariantType.COLOR) {
      const [r, g, b, a] = value as number[];
      return { r, g, b, a };
    }
    return value.map((item) => variantToJson(item, nodePathOf));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, variantToJson(item, nodePathOf)]));
}

const VECTOR_AXES: Partial<Record<VariantType, string[]>> = {
  [VariantType.VECTOR2]: ['x', 'y'],
  [VariantType.VECTOR2I]: ['x', 'y'],
  [VariantType.VECTOR3]: ['x', 'y', 'z'],
  [VariantType.VECTOR3I]: ['x', 'y', 'z'],
  [VariantType.VECTOR4]: ['x', 'y', 'z', 'w'],
  [VariantType.VECTOR4I]: ['x', 'y', 'z', 'w'],
};

export const SETTABLE_TYPES =
  'bool, int, float, String, StringName, NodePath, Vector2/2i/3/3i/4/4i ({x,y,...} or an array), Color ({r,g,b,a?} or an array), and Arrays of bools, numbers and strings';

/**
 * The Variant to send for setting a property of `type` to a JSON value. Throws with a message for
 * the agent when the type cannot be set from JSON or the value does not fit it.
 */
export function jsonToVariant(type: VariantType, json: unknown): unknown {
  const name = VariantType[type] ?? `type ${type}`;
  const mismatch = () => new Error(`${JSON.stringify(json)} does not fit a ${name} property`);

  switch (type) {
    case VariantType.BOOL:
      if (typeof json !== 'boolean') throw mismatch();
      return json;
    case VariantType.INT:
      if (!Number.isInteger(json)) throw mismatch();
      return json;
    case VariantType.FLOAT:
      if (typeof json !== 'number') throw mismatch();
      return { variantType: VariantType.FLOAT, value: json } satisfies TypedValue;
    case VariantType.STRING:
    case VariantType.STRING_NAME:
    case VariantType.NODE_PATH:
      // Godot converts the String to the property's type when setting it
      if (typeof json !== 'string') throw mismatch();
      return json;
    case VariantType.COLOR: {
      const rgba = components(json, ['r', 'g', 'b', 'a'], 3);
      if (!rgba) throw mismatch();
      return { variantType: type, value: rgba.length === 3 ? [...rgba, 1] : rgba } satisfies TypedValue;
    }
    case VariantType.ARRAY:
      if (!Array.isArray(json) || !json.every((item) => ['boolean', 'number', 'string'].includes(typeof item))) throw mismatch();
      return json;
    default: {
      const axes = VECTOR_AXES[type];
      if (!axes) throw new Error(`A ${name} property cannot be set from JSON. Settable types: ${SETTABLE_TYPES}`);
      const values = components(json, axes, axes.length);
      if (!values) throw mismatch();
      return { variantType: type, value: values } satisfies TypedValue;
    }
  }
}

/**
 * The type to set a property to when the game declared none (script members arrive as NIL):
 * the current value's decoded type, else inferred from the current value and the new JSON value.
 */
export function inferVariantType(current: Variant, json: unknown): VariantType {
  const decoded = decodedVariantType(current);
  if (decoded !== undefined) return decoded;
  const sample = current ?? json;
  if (typeof sample === 'boolean') return VariantType.BOOL;
  if (typeof sample === 'string') return VariantType.STRING;
  if (typeof sample === 'number') {
    // A float member that currently holds an integral value is indistinguishable from an int
    return Number.isInteger(json) && Number.isInteger(sample) ? VariantType.INT : VariantType.FLOAT;
  }
  if (Array.isArray(json)) return VariantType.ARRAY;
  throw new Error(`Cannot tell the type of this property from its value ${JSON.stringify(current)}`);
}

// Numbers from {x, y, ...} / {r, g, b, a} or an array; at least `required` of them
function components(json: unknown, keys: string[], required: number): number[] | null {
  const values = Array.isArray(json)
    ? json
    : typeof json === 'object' && json !== null
      ? keys.map((key) => (json as Record<string, unknown>)[key]).filter((value) => value !== undefined)
      : null;
  if (!values || values.length < required || values.length > keys.length || !values.every((value) => typeof value === 'number')) {
    return null;
  }
  return values as number[];
}

function isObjectReference(value: object): value is { objectId: bigint } {
  return 'objectId' in value && typeof (value as { objectId: unknown }).objectId === 'bigint';
}
