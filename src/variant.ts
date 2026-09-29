/**
 * Godot 4's binary Variant serialization, as used by the remote debugger protocol.
 *
 * Decoding covers every type that appears in debugger traffic. Values map to plain JS:
 * vectors, rects, transforms and colors become number arrays, NodePath a string, objects sent by
 * ID `{ objectId }`, and 64-bit integers a bigint when they do not fit a JS number.
 * Encoding covers what requests need; see `encodeVariant`.
 */

export enum VariantType {
  NIL = 0,
  BOOL = 1,
  INT = 2,
  FLOAT = 3,
  STRING = 4,
  VECTOR2 = 5,
  VECTOR2I = 6,
  RECT2 = 7,
  RECT2I = 8,
  VECTOR3 = 9,
  VECTOR3I = 10,
  TRANSFORM2D = 11,
  VECTOR4 = 12,
  VECTOR4I = 13,
  PLANE = 14,
  QUATERNION = 15,
  AABB = 16,
  BASIS = 17,
  TRANSFORM3D = 18,
  PROJECTION = 19,
  COLOR = 20,
  STRING_NAME = 21,
  NODE_PATH = 22,
  RID = 23,
  OBJECT = 24,
  CALLABLE = 25,
  SIGNAL = 26,
  DICTIONARY = 27,
  ARRAY = 28,
  PACKED_BYTE_ARRAY = 29,
  PACKED_INT32_ARRAY = 30,
  PACKED_INT64_ARRAY = 31,
  PACKED_FLOAT32_ARRAY = 32,
  PACKED_FLOAT64_ARRAY = 33,
  PACKED_STRING_ARRAY = 34,
  PACKED_VECTOR2_ARRAY = 35,
  PACKED_VECTOR3_ARRAY = 36,
  PACKED_COLOR_ARRAY = 37,
  PACKED_VECTOR4_ARRAY = 38,
}

// Header bit meaning "64-bit" for ints, floats, float vectors and object IDs
const FLAG_64 = 1 << 16;

// Number of float (or int) components of the fixed-size math types
const COMPONENTS: Partial<Record<VariantType, number>> = {
  [VariantType.VECTOR2]: 2,
  [VariantType.VECTOR2I]: 2,
  [VariantType.RECT2]: 4,
  [VariantType.RECT2I]: 4,
  [VariantType.VECTOR3]: 3,
  [VariantType.VECTOR3I]: 3,
  [VariantType.TRANSFORM2D]: 6,
  [VariantType.VECTOR4]: 4,
  [VariantType.VECTOR4I]: 4,
  [VariantType.PLANE]: 4,
  [VariantType.QUATERNION]: 4,
  [VariantType.AABB]: 6,
  [VariantType.BASIS]: 9,
  [VariantType.TRANSFORM3D]: 12,
  [VariantType.PROJECTION]: 16,
};
const INTEGER_COMPONENTS = new Set([VariantType.VECTOR2I, VariantType.RECT2I, VariantType.VECTOR3I, VariantType.VECTOR4I]);

export type Variant =
  | null
  | boolean
  | number
  | bigint
  | string
  | Variant[]
  | { [key: string]: Variant }
  | { objectId: bigint };

/**
 * Decode one Variant starting at `offset`. Returns the value and the offset after it.
 * Throws on truncated data or a type this decoder does not know.
 */
export function decodeVariant(buf: Buffer, offset = 0): [Variant, number] {
  let pos = offset;
  const header = buf.readUInt32LE(pos);
  pos += 4;
  const type = (header & 0xff) as VariantType;
  const wide = (header & FLAG_64) !== 0;

  const readString = (): string => {
    const length = buf.readUInt32LE(pos);
    const text = buf.toString('utf8', pos + 4, pos + 4 + length);
    pos += 4 + padded(length);
    return text;
  };
  const readInt64 = (): number | bigint => {
    const value = buf.readBigInt64LE(pos);
    pos += 8;
    return safeNumber(value);
  };

  const components = COMPONENTS[type];
  if (components !== undefined) {
    const integer = INTEGER_COMPONENTS.has(type);
    const size = wide ? 8 : 4;
    const values: number[] = [];
    for (let i = 0; i < components; i++) {
      const at = pos + size * i;
      values.push(integer ? (wide ? Number(buf.readBigInt64LE(at)) : buf.readInt32LE(at)) : wide ? buf.readDoubleLE(at) : buf.readFloatLE(at));
    }
    return [values, pos + size * components];
  }

  switch (type) {
    case VariantType.NIL:
      return [null, pos];
    case VariantType.BOOL:
      return [buf.readUInt32LE(pos) !== 0, pos + 4];
    case VariantType.INT:
      return wide ? [readInt64(), pos] : [buf.readInt32LE(pos), pos + 4];
    case VariantType.FLOAT:
      return wide ? [buf.readDoubleLE(pos), pos + 8] : [buf.readFloatLE(pos), pos + 4];
    case VariantType.STRING:
    case VariantType.STRING_NAME:
      return [readString(), pos];
    case VariantType.COLOR: {
      // Colors are always 32-bit floats
      const values = [0, 1, 2, 3].map((i) => buf.readFloatLE(pos + 4 * i));
      return [values, pos + 16];
    }
    case VariantType.NODE_PATH: {
      const names = buf.readUInt32LE(pos) & 0x7fffffff;
      const subnames = buf.readUInt32LE(pos + 4);
      const absolute = (buf.readUInt32LE(pos + 8) & 1) !== 0;
      pos += 12;
      const parts: string[] = [];
      for (let i = 0; i < names + subnames; i++) parts.push(readString());
      const path = (absolute ? '/' : '') + parts.slice(0, names).join('/');
      return [subnames > 0 ? `${path}:${parts.slice(names).join(':')}` : path, pos];
    }
    case VariantType.RID:
      return [readInt64(), pos];
    case VariantType.OBJECT: {
      if (wide) {
        const objectId = buf.readBigUInt64LE(pos);
        return [{ objectId }, pos + 8];
      }
      const className = readString();
      if (!className) return [null, pos];
      const count = buf.readUInt32LE(pos);
      pos += 4;
      const object: { [key: string]: Variant } = { class: className };
      for (let i = 0; i < count; i++) {
        const name = readString();
        const [value, next] = decodeVariant(buf, pos);
        object[name] = value;
        pos = next;
      }
      return [object, pos];
    }
    case VariantType.CALLABLE:
      return [null, pos];
    case VariantType.SIGNAL: {
      const name = readString();
      return [`signal ${name}`, pos + 8];
    }
    case VariantType.DICTIONARY: {
      // Typed dictionaries (4.4+) carry key and value type info, flagged in header bits 16-19
      pos = skipContainerType(buf, pos, (header >> 16) & 3);
      pos = skipContainerType(buf, pos, (header >> 18) & 3);
      const count = buf.readUInt32LE(pos) & 0x7fffffff;
      pos += 4;
      const dictionary: { [key: string]: Variant } = {};
      for (let i = 0; i < count; i++) {
        const [key, afterKey] = decodeVariant(buf, pos);
        const [value, afterValue] = decodeVariant(buf, afterKey);
        dictionary[typeof key === 'string' ? key : stringify(key)] = value;
        pos = afterValue;
      }
      return [dictionary, pos];
    }
    case VariantType.ARRAY: {
      // Typed arrays carry element type info, flagged in header bits 16-17
      pos = skipContainerType(buf, pos, (header >> 16) & 3);
      const count = buf.readUInt32LE(pos) & 0x7fffffff;
      pos += 4;
      const array: Variant[] = [];
      for (let i = 0; i < count; i++) {
        const [value, next] = decodeVariant(buf, pos);
        array.push(value);
        pos = next;
      }
      return [array, pos];
    }
    case VariantType.PACKED_BYTE_ARRAY: {
      const length = buf.readUInt32LE(pos);
      return [[...buf.subarray(pos + 4, pos + 4 + length)], pos + 4 + padded(length)];
    }
    case VariantType.PACKED_INT32_ARRAY:
    case VariantType.PACKED_INT64_ARRAY:
    case VariantType.PACKED_FLOAT32_ARRAY:
    case VariantType.PACKED_FLOAT64_ARRAY: {
      const count = buf.readUInt32LE(pos);
      pos += 4;
      const size = type === VariantType.PACKED_INT64_ARRAY || type === VariantType.PACKED_FLOAT64_ARRAY ? 8 : 4;
      const values: Variant[] = [];
      for (let i = 0; i < count; i++) {
        const at = pos + size * i;
        values.push(
          type === VariantType.PACKED_INT32_ARRAY ? buf.readInt32LE(at)
            : type === VariantType.PACKED_INT64_ARRAY ? safeNumber(buf.readBigInt64LE(at))
              : type === VariantType.PACKED_FLOAT32_ARRAY ? buf.readFloatLE(at)
                : buf.readDoubleLE(at)
        );
      }
      return [values, pos + size * count];
    }
    case VariantType.PACKED_STRING_ARRAY: {
      const count = buf.readUInt32LE(pos);
      pos += 4;
      const values: string[] = [];
      for (let i = 0; i < count; i++) values.push(readString());
      return [values, pos];
    }
    case VariantType.PACKED_VECTOR2_ARRAY:
    case VariantType.PACKED_VECTOR3_ARRAY:
    case VariantType.PACKED_COLOR_ARRAY:
    case VariantType.PACKED_VECTOR4_ARRAY: {
      const components = { 35: 2, 36: 3, 37: 4, 38: 4 }[type];
      const size = type !== VariantType.PACKED_COLOR_ARRAY && wide ? 8 : 4;
      const count = buf.readUInt32LE(pos);
      pos += 4;
      const values: number[][] = [];
      for (let i = 0; i < count; i++) {
        const item: number[] = [];
        for (let c = 0; c < components; c++) {
          const at = pos + size * (i * components + c);
          item.push(size === 8 ? buf.readDoubleLE(at) : buf.readFloatLE(at));
        }
        values.push(item);
      }
      return [values, pos + size * components * count];
    }
    default:
      throw new Error(`Unsupported Variant type ${type}`);
  }
}

/**
 * A value to encode with an explicit Variant type, for types JS values do not imply:
 * floats with integral values, vectors and colors.
 */
export interface TypedValue {
  variantType: VariantType;
  value: number | number[];
}

/**
 * Encode a value: null, boolean, bigint (INT), number (INT when integral, else FLOAT), string,
 * arrays of these, or a TypedValue for FLOAT, Vector2/2i/3/3i/4/4i and Color.
 */
export function encodeVariant(value: unknown): Buffer {
  if (value === null || value === undefined) return uint32(VariantType.NIL);
  if (typeof value === 'boolean') return Buffer.concat([uint32(VariantType.BOOL), uint32(value ? 1 : 0)]);
  if (typeof value === 'bigint') return int64(value);
  if (typeof value === 'number') return Number.isInteger(value) ? int64(BigInt(value)) : float64(value);
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    return Buffer.concat([uint32(VariantType.STRING), uint32(text.length), text, Buffer.alloc(padded(text.length) - text.length)]);
  }
  if (Array.isArray(value)) return Buffer.concat([uint32(VariantType.ARRAY), uint32(value.length), ...value.map(encodeVariant)]);
  if (isTypedValue(value)) return encodeTyped(value);
  throw new Error(`Cannot encode ${JSON.stringify(value)} as a Variant`);
}

function encodeTyped({ variantType, value }: TypedValue): Buffer {
  if (variantType === VariantType.FLOAT && typeof value === 'number') return float64(value);
  const components = variantType === VariantType.COLOR ? 4 : COMPONENTS[variantType];
  const vectors = [VariantType.VECTOR2, VariantType.VECTOR2I, VariantType.VECTOR3, VariantType.VECTOR3I, VariantType.VECTOR4, VariantType.VECTOR4I, VariantType.COLOR];
  if (!vectors.includes(variantType) || !Array.isArray(value) || value.length !== components) {
    throw new Error(`Cannot encode ${JSON.stringify(value)} as Variant type ${variantType}`);
  }
  // 32-bit components, which every Godot build reads
  const body = Buffer.alloc(4 * value.length);
  value.forEach((component, i) =>
    INTEGER_COMPONENTS.has(variantType) ? body.writeInt32LE(component, 4 * i) : body.writeFloatLE(component, 4 * i)
  );
  return Buffer.concat([uint32(variantType), body]);
}

function isTypedValue(value: unknown): value is TypedValue {
  return typeof value === 'object' && value !== null && 'variantType' in value && 'value' in value;
}

function skipContainerType(buf: Buffer, pos: number, kind: number): number {
  if (kind === 1) return pos + 4; // built-in type ID
  if (kind === 2 || kind === 3) return pos + 4 + padded(buf.readUInt32LE(pos)); // class name or script path
  return pos;
}

function padded(length: number): number {
  return length + ((4 - (length % 4)) % 4);
}

function safeNumber(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function stringify(value: Variant): string {
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function uint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0);
  return buf;
}

function int64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(value);
  return Buffer.concat([uint32(VariantType.INT | FLAG_64), buf]);
}

function float64(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value);
  return Buffer.concat([uint32(VariantType.FLOAT | FLAG_64), buf]);
}
