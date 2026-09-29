/**
 * Godot 4's binary Variant serialization, as used by the remote debugger protocol.
 *
 * Decoding covers every type that appears in debugger traffic. Arrays, Dictionaries, strings and
 * scalars map to plain JS, with NodePath a string and 64-bit integers a bigint when they do not fit
 * a JS number. Math types, Color, packed arrays and objects become a TypedVariant, which keeps the
 * type. Encoding covers what requests need; see `encodeVariant`.
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

// How a number is stored: `real` is a 64-bit float when the header's FLAG_64 is set (a double
// precision build), else a 32-bit float
type Element = 'i32' | 'i64' | 'f32' | 'f64' | 'real';

// Types made of a fixed number of numbers. A packed array is a length followed by that many items;
// an item of one number is that number, otherwise an array of `count` numbers.
const LAYOUTS: Partial<Record<VariantType, { count: number; element: Element; packed?: true }>> = {
  [VariantType.VECTOR2]: { count: 2, element: 'real' },
  [VariantType.VECTOR2I]: { count: 2, element: 'i32' },
  [VariantType.RECT2]: { count: 4, element: 'real' },
  [VariantType.RECT2I]: { count: 4, element: 'i32' },
  [VariantType.VECTOR3]: { count: 3, element: 'real' },
  [VariantType.VECTOR3I]: { count: 3, element: 'i32' },
  [VariantType.TRANSFORM2D]: { count: 6, element: 'real' },
  [VariantType.VECTOR4]: { count: 4, element: 'real' },
  [VariantType.VECTOR4I]: { count: 4, element: 'i32' },
  [VariantType.PLANE]: { count: 4, element: 'real' },
  [VariantType.QUATERNION]: { count: 4, element: 'real' },
  [VariantType.AABB]: { count: 6, element: 'real' },
  [VariantType.BASIS]: { count: 9, element: 'real' },
  [VariantType.TRANSFORM3D]: { count: 12, element: 'real' },
  [VariantType.PROJECTION]: { count: 16, element: 'real' },
  [VariantType.COLOR]: { count: 4, element: 'f32' },
  [VariantType.PACKED_INT32_ARRAY]: { packed: true, count: 1, element: 'i32' },
  [VariantType.PACKED_INT64_ARRAY]: { packed: true, count: 1, element: 'i64' },
  [VariantType.PACKED_FLOAT32_ARRAY]: { packed: true, count: 1, element: 'f32' },
  [VariantType.PACKED_FLOAT64_ARRAY]: { packed: true, count: 1, element: 'f64' },
  [VariantType.PACKED_VECTOR2_ARRAY]: { packed: true, count: 2, element: 'real' },
  [VariantType.PACKED_VECTOR3_ARRAY]: { packed: true, count: 3, element: 'real' },
  [VariantType.PACKED_COLOR_ARRAY]: { packed: true, count: 4, element: 'f32' },
  [VariantType.PACKED_VECTOR4_ARRAY]: { packed: true, count: 4, element: 'real' },
};

/**
 * A Variant whose type its JS value would not tell: math types, Color, packed arrays and objects
 * when decoded, and FLOAT or a vector type to encode. An object sent by ID has its ID as the value.
 */
export class TypedVariant {
  constructor(
    readonly type: VariantType,
    readonly value: number | bigint | string[] | Array<number | bigint> | number[][] | { [key: string]: Variant }
  ) {}
}

/** A decoded value. Arrays are always Arrays and plain objects Dictionaries. */
export type Variant = null | boolean | number | bigint | string | Variant[] | { [key: string]: Variant } | TypedVariant;

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

  const layout = LAYOUTS[type];
  if (layout) {
    const { count, element, packed } = layout;
    const [size, read] = elementReader(element, wide);
    const readItem = (at: number) => Array.from({ length: count }, (_, i) => read(buf, at + size * i));
    if (!packed) return [new TypedVariant(type, readItem(pos) as number[]), pos + size * count];
    const length = buf.readUInt32LE(pos);
    pos += 4;
    const items = Array.from({ length }, (_, i) => readItem(pos + size * count * i));
    const value = count === 1 ? items.map(([number]) => number) : (items as number[][]);
    return [new TypedVariant(type, value), pos + size * count * length];
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
      if (wide) return [new TypedVariant(type, buf.readBigUInt64LE(pos)), pos + 8];
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
      return [new TypedVariant(type, object), pos];
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
      return [new TypedVariant(type, [...buf.subarray(pos + 4, pos + 4 + length)]), pos + 4 + padded(length)];
    }
    case VariantType.PACKED_STRING_ARRAY: {
      const count = buf.readUInt32LE(pos);
      pos += 4;
      const values: string[] = [];
      for (let i = 0; i < count; i++) values.push(readString());
      return [new TypedVariant(type, values), pos];
    }
    default:
      throw new Error(`Unsupported Variant type ${type}`);
  }
}

// Size and reader of one stored number
function elementReader(element: Element, wide: boolean): [number, (buf: Buffer, at: number) => number | bigint] {
  switch (element) {
    case 'i32':
      return [4, (buf, at) => buf.readInt32LE(at)];
    case 'i64':
      return [8, (buf, at) => safeNumber(buf.readBigInt64LE(at))];
    case 'f32':
      return [4, (buf, at) => buf.readFloatLE(at)];
    case 'f64':
      return [8, (buf, at) => buf.readDoubleLE(at)];
    case 'real':
      return elementReader(wide ? 'f64' : 'f32', wide);
  }
}

/**
 * Encode a value: null, boolean, bigint (INT), number (INT when integral, else FLOAT), string,
 * arrays of these, or a TypedVariant for FLOAT and the math types.
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
  if (value instanceof TypedVariant) return encodeTyped(value);
  throw new Error(`Cannot encode ${JSON.stringify(value)} as a Variant`);
}

function encodeTyped({ type, value }: TypedVariant): Buffer {
  if (type === VariantType.FLOAT && typeof value === 'number') return float64(value);
  const layout = LAYOUTS[type];
  if (!layout || layout.packed || !Array.isArray(value) || value.length !== layout.count) {
    throw new Error(`Cannot encode ${stringify(value as Variant)} as Variant type ${type}`);
  }
  // 32-bit components, which every Godot build reads
  const body = Buffer.alloc(4 * value.length);
  (value as number[]).forEach((component, i) =>
    layout.element === 'i32' ? body.writeInt32LE(component, 4 * i) : body.writeFloatLE(component, 4 * i)
  );
  return Buffer.concat([uint32(type), body]);
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
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v instanceof TypedVariant ? v.value : v));
}

function uint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0);
  return buf;
}

function int64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt.asIntN(64, value));
  return Buffer.concat([uint32(VariantType.INT | FLAG_64), buf]);
}

function float64(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value);
  return Buffer.concat([uint32(VariantType.FLOAT | FLAG_64), buf]);
}
