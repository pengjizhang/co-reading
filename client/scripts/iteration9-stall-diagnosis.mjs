import { createWheelGestureMachine } from '../src/lib/wheelGesture.js';

const machine = createWheelGestureMachine({ threshold: .07, idleMs: 150 });
const fineWheel = { deltaY: 20, deltaX: 0, deltaMode: 0 };
const timeline = [];

for (let time = 0; time <= 150; time += 50) {
  timeline.push({ time, ...machine.consume(fineWheel, time) });
}

// 模拟页面动画期间仍在持续上报滚轮事件。
for (let time = 200; time <= 400; time += 50) {
  timeline.push({ time, ...machine.consume(fineWheel, time) });
}
machine.settle();

// 页面已经稳定，但滚轮仍在连续滚动；hook 中的结束定时器会被不断推迟。
for (let time = 450; time <= 2000; time += 50) {
  timeline.push({ time, ...machine.consume(fineWheel, time) });
}

const afterSettle = timeline.filter((event) => event.time >= 450);
const laterTurns = afterSettle.filter((event) => event.action === 'turn');
const snapshot = machine.snapshot();
const reproduced = laterTurns.length === 0 && snapshot.triggered && !snapshot.busy;

if (!reproduced) throw new Error('未复现预期的持续滚轮停滞');

console.log(JSON.stringify({
  reproduced: true,
  input: 'deltaY=20, every 50ms, no 150ms silence',
  firstTurnAt: timeline.find((event) => event.action === 'turn')?.time,
  pageSettledAt: 400,
  laterTurns: laterTurns.length,
  finalState: snapshot,
  rootCause: 'continuous events keep postponing gesture end while triggered remains true after settling',
}, null, 2));
