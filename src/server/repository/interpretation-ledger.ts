const MAX_OUTPUT_BYTES = 128 * 1024;

// Iterative traversal bounds both the encoded output and pending work. Do not
// invoke getters/toJSON or silently discard values while normalizing internal JSON.
export function encodeInterpretationOutput(value: unknown): string {
  type Task = { kind: "value"; value: unknown } | { kind: "text"; text: string } | { kind: "leave"; value: object };
  const tasks: Task[] = [{ kind: "value", value }];
  const ancestors = new WeakSet<object>();
  const parts: string[] = [];
  let bytes = 0;
  let pendingBytes = 0;
  let slots = 0;
  const invalid = (): never => { throw new TypeError("Interpretation output must be lossless JSON within 128 KiB"); };
  const append = (text: string) => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes + pendingBytes > MAX_OUTPUT_BYTES) invalid();
    parts.push(text);
  };
  const string = (text: string) => {
    if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) invalid();
    return JSON.stringify(text);
  };
  const queueText = (text: string) => {
    pendingBytes += Buffer.byteLength(text, "utf8");
    if (bytes + pendingBytes > MAX_OUTPUT_BYTES) invalid();
    tasks.push({ kind: "text", text });
  };
  while (tasks.length) {
    const task = tasks.pop()!;
    if (task.kind === "text") {
      pendingBytes -= Buffer.byteLength(task.text, "utf8");
      append(task.text);
      continue;
    }
    if (task.kind === "leave") { ancestors.delete(task.value); continue; }
    const item = task.value;
    if (item === null) { append("null"); continue; }
    if (typeof item === "string") { append(string(item)); continue; }
    if (typeof item === "boolean") { append(item ? "true" : "false"); continue; }
    if (typeof item === "number") {
      if (!Number.isFinite(item) || Object.is(item, -0)) invalid();
      append(JSON.stringify(item));
      continue;
    }
    if (typeof item !== "object") invalid();
    const object = item as object;
    const array = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid();
    if (ancestors.has(object)) invalid();
    if (array && object.length > MAX_OUTPUT_BYTES) invalid();
    const keys = Reflect.ownKeys(object);
    slots += keys.length;
    if (slots > MAX_OUTPUT_BYTES || keys.some(key => typeof key !== "string")) invalid();
    const names = (keys as string[]).filter(key => !array || key !== "length");
    if (array && names.length !== object.length) invalid();
    if (!array) names.sort();
    const values = names.map((key, index) => {
      if (array && key !== String(index)) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) invalid();
      return { key, value: descriptor.value as unknown };
    });
    ancestors.add(object);
    append(array ? "[" : "{");
    tasks.push({ kind: "leave", value: object });
    queueText(array ? "]" : "}");
    for (let index = values.length - 1; index >= 0; index--) {
      const entry = values[index];
      tasks.push({ kind: "value", value: entry.value });
      if (!array) queueText(`${string(entry.key)}:`);
      if (index > 0) queueText(",");
    }
  }
  return parts.join("");
}
