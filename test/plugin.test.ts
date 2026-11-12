import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSkill } from '../src/plugin.ts';

test('the bundled review skill carries the fields the loader validates', () => {
  const skill = loadSkill();
  const content = skill.content;
  assert.equal(skill.error, undefined);
  assert.equal(skill.name, 'cs2-review');
  assert.equal(typeof skill.description, 'string');
  assert.ok((skill.description ?? '').length > 0);
  assert.equal(typeof skill.source, 'string', 'loaded skills require a source label');
  assert.ok(content !== undefined);
  assert.ok(content.length > 500);
  assert.match(content, /CS2 demo review/);
});
