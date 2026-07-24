export const DEFAULT_SIDEBAR_WIDTH = 390;
export const MIN_SIDEBAR_WIDTH = 300;
export const MAX_SIDEBAR_WIDTH = 720;
export const MIN_READER_WIDTH = 520;

export function clampSidebarWidth(width, viewportWidth = window.innerWidth) {
  const numeric = Number(width) || DEFAULT_SIDEBAR_WIDTH;
  const viewport = Number(viewportWidth || 0);
  const available = viewport <= 920
    ? Math.max(240, Math.floor(viewport * .92))
    : Math.max(MIN_SIDEBAR_WIDTH, viewport - MIN_READER_WIDTH);
  const minimum = Math.min(MIN_SIDEBAR_WIDTH, available);
  return Math.round(Math.max(minimum, Math.min(numeric, MAX_SIDEBAR_WIDTH, available)));
}

export function sidebarWidthFromPointer(startWidth, startX, currentX, viewportWidth) {
  return clampSidebarWidth(Number(startWidth) + Number(startX) - Number(currentX), viewportWidth);
}
