/**
 * BLINDSIGHT — Gallery persistence (localStorage).
 *
 * Stores brain-painting thumbnails and metadata for a local gallery.
 * Full images are stored as medium-quality JPEGs to keep under
 * localStorage limits (~5 MB).  Older entries are evicted when full.
 */

import type { SessionSummary, GalleryEntry } from './types';

const GALLERY_KEY = 'blindsight-gallery';
const MAX_ENTRIES = 20;

// ─── Public API ──────────────────────────────────────────────────────────

export function loadGallery(): GalleryEntry[] {
  try {
    const raw = localStorage.getItem(GALLERY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Save the current painting to the gallery. Returns the new entry. */
export function saveToGallery(
  paintCanvas: HTMLCanvasElement,
  summary: SessionSummary,
): GalleryEntry {
  const entries = loadGallery();

  // Medium-res image (max 640 wide)
  const imageData = scaleToDataURL(paintCanvas, 640, 480, 0.82);

  // Tiny thumbnail (160 × 120)
  const thumbData = scaleToDataURL(paintCanvas, 160, 120, 0.6);

  const entry: GalleryEntry = {
    id: `bs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    date: new Date().toISOString(),
    imageData,
    thumbData,
    gestures: summary.totalGestures,
    paintTimeMs: summary.totalPaintTime,
    dominantBand: summary.dominantBand,
    jawClenches: summary.jawClenches,
    durationMs: summary.durationMs,
  };

  entries.unshift(entry);

  // Trim oldest entries beyond the cap
  while (entries.length > MAX_ENTRIES) entries.pop();

  persistGallery(entries);
  return entry;
}

export function deleteFromGallery(id: string): void {
  const entries = loadGallery().filter((e) => e.id !== id);
  persistGallery(entries);
}

export function clearGallery(): void {
  localStorage.removeItem(GALLERY_KEY);
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function persistGallery(entries: GalleryEntry[]): void {
  try {
    localStorage.setItem(GALLERY_KEY, JSON.stringify(entries));
  } catch {
    // Storage full — progressively evict oldest until it fits
    const list = [...entries];
    while (list.length > 1) {
      list.pop();
      try {
        localStorage.setItem(GALLERY_KEY, JSON.stringify(list));
        return;
      } catch { /* keep trimming */ }
    }
  }
}

/** Scale a canvas down and return a compressed JPEG data-URL. */
function scaleToDataURL(
  source: HTMLCanvasElement,
  maxW: number,
  maxH: number,
  quality: number,
): string {
  const aspect = source.width / source.height;
  let w = maxW;
  let h = maxH;
  if (aspect > maxW / maxH) {
    h = Math.round(maxW / aspect);
  } else {
    w = Math.round(maxH * aspect);
  }

  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  tmp.getContext('2d')!.drawImage(source, 0, 0, w, h);
  return tmp.toDataURL('image/jpeg', quality);
}
