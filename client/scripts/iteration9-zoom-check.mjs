import { createPagedWheelController, createWheelGestureMachine } from '../src/lib/wheelGesture.js';

function simulate({ zoom, physicalDelta = 100, notchIntervalMs = 300, notches = 20 }) {
  const paged = createPagedWheelController();
  const boundary = createWheelGestureMachine();
  let pageTurns = 0;
  let boundaryIntents = 0;
  const cssDelta = physicalDelta / zoom;
  const viewportHeight = 900 / zoom;
  for (let index = 0; index < notches; index += 1) {
    const time = 1 + index * notchIntervalMs;
    const input = { deltaY: cssDelta, deltaX: 0, deltaMode: 0 };
    const pageDecision = paged.consume(input, time, viewportHeight);
    if (pageDecision.action === 'turn') {
      pageTurns += 1;
      paged.settle(time + 180);
    }
    const boundaryDecision = boundary.consume(input, time, viewportHeight);
    if (boundaryDecision.action === 'turn') {
      boundaryIntents += 1;
      boundary.settle();
      boundary.endGesture();
    }
  }
  return { zoom: `${Math.round(zoom * 100)}%`, cssDelta: Number(cssDelta.toFixed(2)), viewportHeight: Number(viewportHeight.toFixed(2)), notchIntervalMs, notches, pageTurns, boundaryIntents, pagedState: paged.snapshot(), boundaryState: boundary.snapshot() };
}

const results = [
  simulate({ zoom: 1 }),
  simulate({ zoom: 1.25 }),
  simulate({ zoom: 1.5 }),
  simulate({ zoom: 1.75 }),
  simulate({ zoom: 2 }),
  simulate({ zoom: 2.25 }),
  simulate({ zoom: 2.5 }),
];

for (const result of results) {
  if (result.pageTurns !== result.notches) throw new Error(`${result.zoom} 缩放的分页模式仅完成 ${result.pageTurns}/${result.notches} 次翻页`);
  if (result.boundaryIntents !== result.notches) throw new Error(`${result.zoom} 缩放的连续模式仅识别 ${result.boundaryIntents}/${result.notches} 次跨章意图`);
}

console.log(JSON.stringify({
  ok: true,
  controllerThresholdViewportRatio: .07,
  idleResetMs: 220,
  physicalNotchAssumption: 100,
  results,
  guarantee: 'the same physical wheel notch produces the same relative intent in paged turns and continuous chapter boundaries',
}, null, 2));
