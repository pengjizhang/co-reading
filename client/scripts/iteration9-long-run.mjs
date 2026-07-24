import { createPagedWheelController } from '../src/lib/wheelGesture.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runContinuous({ name, deltaY, eventEveryMs, animationMs, targetTurns }) {
  const controller = createPagedWheelController();
  let time = 1;
  let settleAt = null;
  let turns = 0;
  let events = 0;
  while (turns < targetTurns && events < targetTurns * 20) {
    if (settleAt !== null && settleAt <= time) {
      controller.settle(settleAt);
      settleAt = null;
    }
    const decision = controller.consume({ deltaY, deltaX: 0, deltaMode: 0 }, time, 900);
    if (decision.action === 'turn') {
      turns += 1;
      settleAt = time + animationMs;
    }
    time += eventEveryMs;
    events += 1;
  }
  if (settleAt !== null) controller.settle(settleAt);
  assert(turns === targetTurns, `${name}: stopped at ${turns}/${targetTurns} pages`);
  assert(!controller.snapshot().busy, `${name}: controller remained busy`);
  return { name, turns, events, simulatedSeconds: Number((time / 1000).toFixed(1)) };
}

function runBursts({ name, rounds, values, spacingMs, gapMs, animationMs }) {
  const controller = createPagedWheelController();
  let time = 1;
  let settleAt = null;
  let turns = 0;
  for (let round = 0; round < rounds; round += 1) {
    for (const deltaY of values) {
      if (settleAt !== null && settleAt <= time) {
        controller.settle(settleAt);
        settleAt = null;
      }
      const decision = controller.consume({ deltaY, deltaX: 0, deltaMode: 0 }, time, 900);
      if (decision.action === 'turn') {
        turns += 1;
        settleAt = time + animationMs;
      }
      time += spacingMs;
    }
    if (settleAt !== null && settleAt <= time + gapMs) {
      controller.settle(settleAt);
      settleAt = null;
    }
    time += gapMs;
  }
  if (settleAt !== null) controller.settle(settleAt);
  assert(turns === rounds, `${name}: expected one controlled turn per burst, received ${turns}/${rounds}`);
  assert(!controller.snapshot().busy, `${name}: controller remained busy`);
  return { name, rounds, turns, events: rounds * values.length };
}

const results = [
  runContinuous({ name: 'high-resolution-wheel', deltaY: 20, eventEveryMs: 50, animationMs: 300, targetTurns: 1000 }),
  runContinuous({ name: 'mechanical-wheel', deltaY: 100, eventEveryMs: 340, animationMs: 260, targetTurns: 1000 }),
  runBursts({ name: 'precision-touchpad-bursts', rounds: 500, values: [12, 12, 12, 12, 12, 12, 12, 12], spacingMs: 16, gapMs: 500, animationMs: 220 }),
  runBursts({ name: 'wheel-with-decaying-inertia', rounds: 500, values: [100, 30, 20, 10, 5], spacingMs: 20, gapMs: 500, animationMs: 260 }),
];

console.log(JSON.stringify({ ok: true, totalControlledTurns: results.reduce((sum, item) => sum + item.turns, 0), results }, null, 2));
