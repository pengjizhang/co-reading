import { createBoundaryConfirmation, createPagedWheelController, createWheelGestureMachine, isCoarseWheelInput, normalizePagedWheelDistance, normalizeWheelDelta } from '../src/lib/wheelGesture.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const pixel = (deltaY, deltaX = 0) => ({ deltaY, deltaX, deltaMode: 0 });

assert(normalizeWheelDelta(pixel(40), 800) === 40, 'pixel delta should remain stable');
assert(normalizeWheelDelta({ deltaY: 3, deltaX: 0, deltaMode: 1 }, 800) === 48, 'line delta should be normalized');
assert(normalizeWheelDelta({ deltaY: 1, deltaX: 0, deltaMode: 2 }, 900) === 160, 'page delta should be normalized and capped');
assert(normalizeWheelDelta(pixel(20, 30), 800) === 0, 'horizontal drift should not turn a page');
assert(isCoarseWheelInput(pixel(100)), 'a clear mouse-wheel notch should be classified as coarse');
assert(!isCoarseWheelInput(pixel(18.4)), 'precision touchpad movement should stay fine-grained');
assert(Math.abs(normalizePagedWheelDistance(pixel(100), 900) - normalizePagedWheelDistance(pixel(100 / 1.75), 900 / 1.75)) < .0001, 'paged intent should be invariant across browser zoom');

const gesture = createWheelGestureMachine({ threshold: .07, idleMs: 150 });
assert(gesture.consume(pixel(18), 0).action === 'accumulating', 'small input should accumulate');
assert(gesture.consume(pixel(20), 30).action === 'accumulating', 'one gesture should accumulate');
assert(gesture.consume(pixel(28), 60).action === 'turn', 'intent threshold should turn once');
assert(gesture.consume(pixel(120), 90).action === 'consume', 'inertia must be consumed while turning');
gesture.settle();
assert(gesture.consume(pixel(120), 110).action === 'consume', 'settled animation must not retrigger in the same gesture');
gesture.endGesture();
assert(gesture.consume(pixel(80), 300).action === 'turn', 'a new gesture may turn the next page');

const mouseWheel = createWheelGestureMachine({ threshold: .07, idleMs: 150 });
assert(mouseWheel.consume(pixel(100), 0).action === 'turn', 'first physical wheel notch should turn');
mouseWheel.settle();
assert(mouseWheel.consume(pixel(8.5), 80).reason === 'coarse-inertia-tail', 'small tail after a wheel notch should be drained');
assert(mouseWheel.consume(pixel(100), 105).action === 'turn', 'next clear wheel notch should work without an artificial pause');
mouseWheel.settle();
mouseWheel.endGesture();
const lineWheel = createWheelGestureMachine({ threshold: .07 });
assert(lineWheel.consume({ deltaY: 3, deltaX: 0, deltaMode: 1 }, 0).action === 'turn', 'one standard line-mode notch should turn');
const paged = createPagedWheelController();
assert(paged.consume(pixel(30), 1, 900).action === 'accumulating', 'paged input should accumulate relative distance');
assert(paged.consume(pixel(40), 51, 900).action === 'turn', 'paged input should turn at the relative threshold');
assert(paged.consume(pixel(20), 101).reason === 'turning', 'paged input should retain at most one pending intent while turning');
paged.settle(301);
assert(!paged.snapshot().busy, 'paged input must always become ready when the page settles');

const reverse = createWheelGestureMachine({ threshold: .07 });
reverse.consume(pixel(45), 0);
assert(reverse.consume(pixel(-30), 25).action === 'accumulating', 'reversing direction should cancel previous accumulation');
assert(reverse.snapshot().direction === -1 && Math.abs(reverse.snapshot().accumulated - 30 / 800) < .0001, 'reverse accumulation should restart');

const boundaries = createBoundaryConfirmation(3500);
assert(boundaries.confirm(1, 1000) === false, 'first boundary gesture should only arm');
assert(boundaries.confirm(1, 1200) === true, 'second independent gesture should confirm');
assert(boundaries.confirm(-1, 2000) === false, 'opposite direction should arm separately');
assert(boundaries.confirm(-1, 6000) === false, 'expired intent should not cross a chapter');
boundaries.reset();
assert(boundaries.snapshot() === null, 'leaving the boundary should clear intent');

console.log(JSON.stringify({
  ok: true,
  cases: 25,
  guarantees: ['normalized-delta', 'adaptive-device-input', 'horizontal-filter', 'one-gesture-one-page', 'inertia-drain', 'continuous-wheel-notches', 'reverse-reset', 'two-step-chapter-boundary'],
}, null, 2));
