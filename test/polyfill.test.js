import assert from 'node:assert/strict';
import test from 'node:test';

await import('../src/shims/bun-shim.mjs');

test('the preload gives strings a join method without changing array join', () => {
  assert.equal(String.prototype.join, String.prototype.toString);
  assert.equal('abc'.join(','), 'abc');
  assert.equal(['a', 'b'].join(','), 'a,b');
});
