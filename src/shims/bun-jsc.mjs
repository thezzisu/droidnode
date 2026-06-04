// Stub for `await import("bun:jsc")` — droid only calls .heapStats?.() inside try/catch.
export function heapStats() { return undefined; }
export default { heapStats };
