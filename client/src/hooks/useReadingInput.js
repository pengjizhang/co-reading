import { useEffect, useRef } from 'react';
import { createBoundaryConfirmation, createPagedWheelController, createWheelGestureMachine } from '../lib/wheelGesture';

export default function useReadingInput({ scrollRef, readingFlow, turnPage, keyboardDisabled, onBoundaryHint }) {
  const wheelMachine = useRef(createWheelGestureMachine());
  const pagedWheel = useRef(createPagedWheelController());
  const wheelEndTimer = useRef(null);
  const boundaryIntent = useRef(createBoundaryConfirmation());
  const touchStart = useRef(null);

  const finishWheelGestureLater = () => {
    clearTimeout(wheelEndTimer.current);
    wheelEndTimer.current = setTimeout(() => wheelMachine.current.endGesture(), wheelMachine.current.idleMs);
  };

  const handleWheel = (event) => {
    const element = event.currentTarget;
    const delta = event.deltaY;
    const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 8;
    const atTop = element.scrollTop <= 8;
    const boundaryDirection = delta > 0 && atBottom ? 1 : delta < 0 && atTop ? -1 : 0;

    if (readingFlow === 'continuous' && !boundaryDirection) {
      boundaryIntent.current.reset();
      wheelMachine.current.reset();
      return;
    }

    event.preventDefault();
    if (readingFlow === 'paged') {
      const decision = pagedWheel.current.consume(event, performance.now(), element.clientHeight);
      if (decision.action === 'turn') {
        Promise.resolve(turnPage(decision.direction))
          .finally(() => pagedWheel.current.settle(performance.now()));
      }
      return;
    }

    const decision = wheelMachine.current.consume(event, performance.now(), element.clientHeight);
    finishWheelGestureLater();
    if (decision.action !== 'turn') return;

    if (readingFlow === 'continuous') {
      const confirmed = boundaryIntent.current.confirm(decision.direction);
      if (!confirmed) {
        onBoundaryHint?.(decision.direction);
        wheelMachine.current.settle();
        return;
      }
    }

    Promise.resolve(turnPage(decision.direction))
      .finally(() => wheelMachine.current.settle());
  };

  const handleTouchStart = (event) => {
    if (readingFlow !== 'paged' || event.touches.length !== 1) return;
    touchStart.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  };

  const handleTouchEnd = (event) => {
    if (!touchStart.current || readingFlow !== 'paged') return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchStart.current.x;
    const dy = touch.clientY - touchStart.current.y;
    touchStart.current = null;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.2) turnPage(dx < 0 ? 1 : -1);
  };

  useEffect(() => {
    wheelMachine.current.reset();
    pagedWheel.current.reset();
    boundaryIntent.current.reset();
  }, [readingFlow]);

  useEffect(() => {
    const handleKey = (event) => {
      if (keyboardDisabled) return;
      if (event.target?.matches?.('input, textarea, select, [contenteditable="true"]')) return;
      const nextKeys = ['ArrowDown', 'ArrowRight', 'PageDown', ' '];
      const previousKeys = ['ArrowUp', 'ArrowLeft', 'PageUp'];
      if (!nextKeys.includes(event.key) && !previousKeys.includes(event.key)) return;
      event.preventDefault();
      turnPage(nextKeys.includes(event.key) ? 1 : -1);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [keyboardDisabled, turnPage]);

  useEffect(() => () => clearTimeout(wheelEndTimer.current), []);

  return { handleWheel, handleTouchStart, handleTouchEnd };
}
