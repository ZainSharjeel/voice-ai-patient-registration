/** Intersect a padded text box with the full-page screenshot bounds. */
export function specimenClip(
  box: { x: number; y: number; width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  const x = Math.max(0, Math.floor(box.x - 24));
  const y = Math.max(0, Math.floor(box.y - 24));
  const right = Math.min(page.width, Math.ceil(box.x + box.width + 24));
  const bottom = Math.min(page.height, Math.ceil(box.y + box.height + 24));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}
