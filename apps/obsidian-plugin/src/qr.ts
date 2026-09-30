/**
 * QR code rendering for the invite link.
 *
 * Encoding is delegated to `uqr`: a small, dependency-free, browser-safe
 * encoder from the unjs maintainers. Writing a QR encoder here was the
 * alternative and was rejected deliberately — Reed-Solomon arithmetic over
 * GF(256), mask selection and version placement is a few hundred lines of easy
 * to get subtly wrong, and the failure mode is a code that looks perfect and
 * scans as nothing.
 *
 * The matrix is rendered to SVG markup rather than drawn to a canvas so the
 * result is a plain string: no DOM required, testable, and it scales to any
 * theme's foreground colour.
 */

import { encode } from 'uqr';

/** Quiet zone in modules. The QR specification requires at least four. */
const QUIET_ZONE = 4;

/**
 * Error correction level.
 *
 * `M` recovers up to 15% damage, which suits a code read off a screen where
 * glare, moire and a low-quality camera are more likely than physical damage.
 * `H` would be denser at the same physical size, making each module smaller
 * and harder to resolve.
 */
const DEFAULT_ECC = 'M';

export interface QrOptions {
  /** Rendered size in CSS pixels. */
  size?: number;
  /**
   * Foreground colour. Kept as `currentColor` by default so the code inherits
   * Obsidian's theme and stays legible in both light and dark.
   */
  color?: string;
  background?: string;
  /** Accessible description of what the code contains. */
  label?: string;
}

export interface QrMatrix {
  /** Width and height in modules, excluding the quiet zone. */
  size: number;
  /** True where a module is dark. */
  modules: boolean[][];
}

/**
 * Encodes text into a module matrix.
 *
 * Exposed separately from the SVG so the encoding can be asserted on
 * directly — a QR that is structurally wrong still renders perfectly, so
 * appearance is no evidence that it scans.
 */
export function qrMatrix(text: string): QrMatrix {
  const result = encode(text, { ecc: DEFAULT_ECC });
  const size = result.size;
  const modules: boolean[][] = [];
  for (let row = 0; row < size; row += 1) {
    const line: boolean[] = [];
    const dataRow = result.data[row] ?? [];
    for (let col = 0; col < size; col += 1) {
      line.push(Boolean(dataRow[col]));
    }
    modules.push(line);
  }
  return { size, modules };
}

/**
 * Renders a module matrix as standalone SVG markup.
 *
 * Drawn as a single path rather than one element per module: a version-4 code
 * is over a thousand modules, and a thousand DOM nodes would be wasteful for
 * something redrawn on every settings render.
 */
export function matrixToSvg(matrix: QrMatrix, options: QrOptions = {}): string {
  const {
    size = 180,
    color = 'currentColor',
    background = 'transparent',
    label = 'QR code',
  } = options;
  const extent = matrix.size + QUIET_ZONE * 2;

  const path: string[] = [];
  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      if (matrix.modules[row]?.[col]) {
        path.push(
          `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`
        );
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"`,
    ` viewBox="0 0 ${extent} ${extent}" shape-rendering="crispEdges"`,
    ` role="img" aria-label="${escapeAttribute(label)}">`,
    `<rect width="${extent}" height="${extent}" fill="${background}"/>`,
    `<path d="${path.join('')}" fill="${color}"/>`,
    `</svg>`,
  ].join('');
}

/** Encodes text and renders it in one step. */
export function qrSvg(text: string, options: QrOptions = {}): string {
  return matrixToSvg(qrMatrix(text), options);
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
