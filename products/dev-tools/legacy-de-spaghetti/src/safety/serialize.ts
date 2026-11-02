/**
 * Lossless-enough encoding of arbitrary JS values into JSON, used for:
 *   - passing generated inputs to the recorder child process,
 *   - storing observed outputs in the golden master,
 *   - asserting in generated tests.
 *
 * ENCODER_SOURCE is the single source of truth: the runtime functions are built from it,
 * and the same text is written into the generated test support file, so recorded values
 * and test-time values are always encoded identically.
 */

export const ENCODER_SOURCE = String.raw`
function __dsEncode(value, depth, seen) {
  depth = depth || 0;
  seen = seen || new Map();
  if (value === undefined) return { $u: 1 };
  if (value === null) return null;
  var t = typeof value;
  if (t === "number") {
    if (Number.isNaN(value)) return { $n: "NaN" };
    if (!Number.isFinite(value)) return { $n: value > 0 ? "Infinity" : "-Infinity" };
    if (Object.is(value, -0)) return { $n: "-0" };
    return value;
  }
  if (t === "string" || t === "boolean") return value;
  if (t === "bigint") return { $big: String(value) };
  if (t === "symbol") return { $sym: String(value.description || "") };
  if (t === "function") return { $fn: value.name || "anonymous" };
  if (depth > 8) return { $deep: 1 };
  if (seen.has(value)) return { $circ: seen.get(value) };
  seen.set(value, depth);
  try {
    if (value instanceof Date) return { $date: isNaN(value.getTime()) ? "Invalid" : value.toISOString() };
    if (value instanceof RegExp) return { $re: String(value) };
    if (value instanceof Error) return { $err: { name: value.name, message: String(value.message) } };
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return { $bytes: value.toString("base64") };
    if (ArrayBuffer.isView(value)) return { $typed: value.constructor.name, v: Array.prototype.slice.call(value) };
    if (value instanceof Map) {
      var entries = [];
      value.forEach(function (v, k) { entries.push([__dsEncode(k, depth + 1, seen), __dsEncode(v, depth + 1, seen)]); });
      return { $map: entries };
    }
    if (value instanceof Set) {
      var items = [];
      value.forEach(function (v) { items.push(__dsEncode(v, depth + 1, seen)); });
      return { $set: items };
    }
    if (typeof value.then === "function") return { $promise: 1 };
    if (Array.isArray(value)) return value.map(function (v) { return __dsEncode(v, depth + 1, seen); });
    var out = {};
    Object.keys(value).sort().forEach(function (k) { out[k] = __dsEncode(value[k], depth + 1, seen); });
    var proto = Object.getPrototypeOf(value);
    if (proto && proto !== Object.prototype && proto.constructor && proto.constructor.name) {
      return { $class: proto.constructor.name, props: out };
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
function __dsDecode(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(__dsDecode);
  if ("$u" in value) return undefined;
  if ("$n" in value) return value.$n === "-0" ? -0 : Number(value.$n);
  if ("$big" in value) return BigInt(value.$big);
  if ("$date" in value) return new Date(value.$date);
  if ("$map" in value) return new Map(value.$map.map(function (e) { return [__dsDecode(e[0]), __dsDecode(e[1])]; }));
  if ("$set" in value) return new Set(value.$set.map(__dsDecode));
  var out = {};
  Object.keys(value).forEach(function (k) { out[k] = __dsDecode(value[k]); });
  return out;
}
async function __dsCapture(fn) {
  try {
    var value = await fn();
    return { returns: __dsEncode(value) };
  } catch (error) {
    var e = error instanceof Error ? { name: error.name, message: String(error.message) } : { thrown: __dsEncode(error) };
    return { throws: e };
  }
}
`;

export type Encoded = unknown;

const runtime = new Function(`${ENCODER_SOURCE}; return { encode: __dsEncode, decode: __dsDecode, capture: __dsCapture };`)() as {
  encode: (v: unknown) => Encoded;
  decode: (v: Encoded) => unknown;
  capture: (fn: () => unknown) => Promise<Outcome>;
};

export type Outcome = { returns: Encoded } | { throws: { name?: string; message?: string; thrown?: Encoded } };

export const encode = runtime.encode;
export const decode = runtime.decode;
export const capture = runtime.capture;

/** Stable string for equality checks (keys are already sorted by encode). */
export function fingerprint(v: unknown): string {
  return JSON.stringify(v);
}

/** Render an encoded value as a short human label for test names. */
export function label(v: Encoded, max = 40): string {
  const s = JSON.stringify(decodeForLabel(v));
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function decodeForLabel(v: Encoded): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(decodeForLabel);
  const o = v as Record<string, unknown>;
  if ("$u" in o) return "undefined";
  if ("$n" in o) return o.$n;
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, decodeForLabel(x)]));
}
