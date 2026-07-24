export function normalizeWheelDelta(input, viewportHeight = 800) {
  const rawX = Number(input.deltaX) || 0;
  const rawY = Number(input.deltaY) || 0;
  if (!rawY || Math.abs(rawY) < Math.abs(rawX) * 1.15) return 0;
  const unit = input.deltaMode === 1 ? 16 : input.deltaMode === 2 ? Math.max(1, viewportHeight) : 1;
  const pixels = rawY * unit;
  return Math.sign(pixels) * Math.min(160, Math.abs(pixels));
}

export function isCoarseWheelInput(input) {
  const raw = Math.abs(Number(input.deltaY) || 0);
  return input.deltaMode === 1 || input.deltaMode === 2 || (raw >= 80 && Number.isInteger(raw));
}

export function normalizePagedWheelDistance(input, viewportHeight = 800) {
  const delta = normalizeWheelDelta(input, viewportHeight);
  if (!delta) return 0;
  if (input.deltaMode === 1) return Math.sign(delta) * Math.abs(Number(input.deltaY) || 0) * .025;
  if (input.deltaMode === 2) return Math.sign(delta) * Math.abs(Number(input.deltaY) || 0);
  return delta / Math.max(1, viewportHeight);
}

export function createPagedWheelController(options = {}) {
  const threshold = Number(options.threshold || .07);
  const idleResetMs = Number(options.idleResetMs || 220);
  const minimumTurnMs = Number(options.minimumTurnMs || 180);
  let accumulated = 0;
  let direction = 0;
  let busy = false;
  let pending = 0;
  let pendingDirection = 0;
  let lastAt = 0;
  let lastTurnAt = -Infinity;
  let turns = 0;

  const clearIntent = () => {
    accumulated = 0;
    direction = 0;
    pending = 0;
    pendingDirection = 0;
  };

  return {
    consume(input, now = Date.now(), viewportHeight = 800) {
      const delta = normalizePagedWheelDistance(input, viewportHeight);
      if (!delta) return { action: 'ignore', reason: 'horizontal-or-empty' };
      const nextDirection = Math.sign(delta);
      const distance = Math.abs(delta);
      if (!busy && lastAt && now - lastAt > idleResetMs) clearIntent();
      lastAt = now;

      if (busy) {
        if (pendingDirection && pendingDirection !== nextDirection) pending = 0;
        pendingDirection = nextDirection;
        pending = Math.min(threshold, pending + distance);
        return { action: 'consume', reason: 'turning', pendingProgress: pending / threshold };
      }

      if (direction && direction !== nextDirection) accumulated = 0;
      direction = nextDirection;
      accumulated = Math.min(threshold, accumulated + distance);
      if (accumulated < threshold) return { action: 'accumulating', direction, progress: accumulated / threshold };
      if (now - lastTurnAt < minimumTurnMs) return { action: 'consume', reason: 'rate-limit', direction };

      accumulated = 0;
      busy = true;
      lastTurnAt = now;
      turns += 1;
      return { action: 'turn', direction, turn: turns };
    },
    settle(now = Date.now()) {
      busy = false;
      const recentInput = lastAt && now - lastAt <= idleResetMs;
      accumulated = recentInput ? Math.min(threshold, pending) : 0;
      direction = recentInput ? pendingDirection : 0;
      pending = 0;
      pendingDirection = 0;
      return { ready: true, carriedProgress: accumulated / threshold };
    },
    reset() {
      busy = false;
      lastAt = 0;
      lastTurnAt = -Infinity;
      turns = 0;
      clearIntent();
    },
    snapshot() {
      return { accumulated, direction, busy, pending, pendingDirection, lastAt, lastTurnAt, turns };
    },
  };
}

export function createWheelGestureMachine(options = {}) {
  const threshold = Number(options.threshold || .07);
  const idleMs = Number(options.idleMs || 150);
  let accumulated = 0;
  let direction = 0;
  let lastAt = 0;
  let triggered = false;
  let busy = false;
  let ended = false;
  let coarseTriggered = false;
  let coarseGate = false;

  const resetGesture = (preserveLastAt = false) => {
    accumulated = 0;
    direction = 0;
    if (!preserveLastAt) lastAt = 0;
    triggered = false;
    ended = false;
    coarseTriggered = false;
  };

  return {
    consume(input, now = Date.now(), viewportHeight = 800) {
      const delta = normalizePagedWheelDistance(input, viewportHeight);
      if (!delta) return { action: 'ignore', reason: 'horizontal-or-empty' };
      const coarse = isCoarseWheelInput(input);
      if (lastAt && now - lastAt > idleMs && !busy) {
        coarseGate = false;
        resetGesture();
      }
      if (coarseGate) {
        if (!coarse) {
          lastAt = now;
          return { action: 'consume', reason: 'coarse-inertia-tail' };
        }
        coarseGate = false;
        resetGesture();
      }
      lastAt = now;
      if (busy || triggered) return { action: 'consume', reason: busy ? 'turning' : 'same-gesture' };
      const nextDirection = Math.sign(delta);
      if (direction && nextDirection !== direction) accumulated = 0;
      direction = nextDirection;
      accumulated += Math.abs(delta);
      const effectiveThreshold = threshold;
      if (accumulated < effectiveThreshold) return { action: 'accumulating', direction, progress: accumulated / effectiveThreshold };
      triggered = true;
      busy = true;
      coarseTriggered = coarse;
      return { action: 'turn', direction, inputType: coarse ? 'coarse-wheel' : 'precision' };
    },
    settle() {
      busy = false;
      if (coarseTriggered) {
        coarseGate = true;
        resetGesture(true);
      } else if (ended) resetGesture();
    },
    endGesture() {
      ended = true;
      if (!busy) {
        coarseGate = false;
        resetGesture();
      }
    },
    reset() {
      busy = false;
      coarseGate = false;
      resetGesture();
    },
    snapshot() {
      return { accumulated, direction, lastAt, triggered, busy, ended, coarseTriggered, coarseGate };
    },
    idleMs,
  };
}

export function createBoundaryConfirmation(windowMs = 3500) {
  let intent = null;
  return {
    confirm(direction, now = Date.now()) {
      const confirmed = intent?.direction === direction && now - intent.at < windowMs;
      intent = confirmed ? null : { direction, at: now };
      return confirmed;
    },
    reset() { intent = null; },
    snapshot() { return intent; },
  };
}
