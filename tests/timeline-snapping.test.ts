import assert from 'node:assert/strict';
import test from 'node:test';
import { snapTimelineDelta } from '../src/timeline-snapping';

const targets = [{ time: 10, label: 'Cursore' }, { time: 20, label: 'Bordo clip' }];
test('a moving end and any group edge can snap without changing internal distances', () => {
  const end = snapTimelineDelta([0, 3], 6.9, targets, 40);
  assert.equal(end.delta, 7); assert.equal(end.anchor, 3); assert.equal(end.target?.time, 10);
  const group = snapTimelineDelta([2, 4, 8, 11], 8.85, targets, 40);
  assert.equal(group.delta, 9); assert.equal(group.anchor, 11); assert.equal(group.target?.time, 20);
});
test('exact alignments still return feedback and pixel tolerance follows zoom', () => {
  assert.equal(snapTimelineDelta([2], 8, targets, 40).target?.time, 10);
  assert.equal(snapTimelineDelta([2], 7.8, targets, 40).delta, 8);
  assert.equal(snapTimelineDelta([2], 7.8, targets, 80).target, undefined);
});
test('disabled magnet and Alt bypass retain the requested time', () => {
  for (const options of [{ enabled: false }, { bypass: true }]) {
    assert.deepEqual(snapTimelineDelta([2], 7.9, targets, 40, options), { delta: 7.9 });
  }
});
test('snapping cannot exceed trim or placement bounds', () => {
  assert.deepEqual(snapTimelineDelta([2], 7.9, targets, 40, { maxDelta: 7.95 }), { delta: 7.9 });
  assert.deepEqual(snapTimelineDelta([3], -3.1, [{ time: 0, label: 'Inizio' }], 40, { minDelta: -2 }), { delta: -2 });
});
