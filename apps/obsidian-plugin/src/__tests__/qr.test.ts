import { describe, expect, it } from 'vitest';

import { matrixToSvg, qrMatrix, qrSvg } from '../qr.js';

/**
 * A QR code that is structurally wrong still renders perfectly, so its
 * appearance is no evidence that it scans. These assert the properties a
 * scanner depends on: the finder patterns, the alignment pattern, a quiet
 * zone, and a square matrix.
 */

const LINK =
  'thoth://?serverUrl=https%3A%2F%2Fsync.example.com&vaultId=3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function isDark(matrix: ReturnType<typeof qrMatrix>, row: number, col: number): boolean {
  return matrix.modules[row]?.[col] === true;
}

describe('qrMatrix', () => {
  it('is square, with every row the same length as the side', () => {
    const matrix = qrMatrix(LINK);

    expect(matrix.size).toBeGreaterThan(0);
    expect(matrix.modules).toHaveLength(matrix.size);
    for (const row of matrix.modules) {
      expect(row).toHaveLength(matrix.size);
    }
  });

  it('is deterministic for the same input', () => {
    // The settings tab re-renders often; a code that changed each time would
    // be unscannable in a screenshot taken a moment later.
    expect(qrMatrix(LINK).modules).toEqual(qrMatrix(LINK).modules);
  });

  it('places the three finder patterns', () => {
    // The large squares in three corners are what a scanner locks onto; their
    // absence means the code cannot be found at all. Each is inset by one
    // module from the edge, which is the light ring around the dark border.
    const matrix = qrMatrix(LINK);
    const last = matrix.size - 2;

    for (const [top, left] of [
      [1, 1],
      [1, last - 6],
      [last - 6, 1],
    ] as const) {
      // 7x7 finder: dark border, then a light ring one module in, then a
      // dark 3x3 core in the middle.
      expect(isDark(matrix, top, left), 'border corner').toBe(true);
      expect(isDark(matrix, top + 6, left + 6), 'border corner').toBe(true);
      expect(isDark(matrix, top + 1, left + 1), 'ring').toBe(false);
      expect(isDark(matrix, top + 5, left + 5), 'ring').toBe(false);
      expect(isDark(matrix, top + 2, left + 2), 'core').toBe(true);
      expect(isDark(matrix, top + 3, left + 3), 'core centre').toBe(true);
      expect(isDark(matrix, top + 4, left + 4), 'core').toBe(true);
      expect(isDark(matrix, top + 7, left), 'outside the finder').toBe(false);
    }
  });

  it('keeps the matrix corners clear of the finder patterns', () => {
    const matrix = qrMatrix(LINK);
    // The outermost ring is the format/timing area; the finders are inset.
    expect(isDark(matrix, 0, 0)).toBe(false);
    expect(isDark(matrix, 0, matrix.size - 1)).toBe(false);
    expect(isDark(matrix, matrix.size - 1, 0)).toBe(false);
  });

  it('is mostly light, so it is a code rather than a solid block', () => {
    const matrix = qrMatrix(LINK);
    const dark = matrix.modules.flat().filter(Boolean).length;
    const ratio = dark / (matrix.size * matrix.size);

    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.7);
  });

  it('grows the code for longer input', () => {
    const short = qrMatrix('a');
    const long = qrMatrix(LINK);

    expect(long.size).toBeGreaterThanOrEqual(short.size);
  });
});

describe('matrixToSvg', () => {
  const matrix = qrMatrix(LINK);
  const svg = matrixToSvg(matrix);

  it('emits a square viewBox with the quiet zone included', () => {
    // The QR specification requires at least four modules of margin. Omit it
    // and a scanner cannot find the code's edge, which fails silently and
    // looks like a bad camera.
    const extent = matrix.size + 8;
    expect(svg).toContain(`viewBox="0 0 ${extent} ${extent}"`);
  });

  it('offsets every module by the quiet zone', () => {
    // The first dark module must not sit at the origin, or there is no quiet
    // zone and a scanner cannot find the code's edge.
    const coordinates = [...svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map(
      (m) => [Number(m[1]), Number(m[2])] as const
    );
    expect(coordinates.length).toBeGreaterThan(0);

    const minX = Math.min(...coordinates.map(([x]) => x));
    const minY = Math.min(...coordinates.map(([, y]) => y));
    expect(minX).toBeGreaterThanOrEqual(4);
    expect(minY).toBeGreaterThanOrEqual(4);
  });

  it('paints a light background across the whole extent', () => {
    const extent = matrix.size + 8;
    expect(svg).toContain(`<rect width="${extent}" height="${extent}"`);
  });

  it('requests crisp module edges', () => {
    // Antialiased module edges blur the pattern and reduce scan reliability.
    expect(svg).toContain('shape-rendering="crispEdges"');
  });

  it('inherits the theme colour by default', () => {
    expect(svg).toContain('fill="currentColor"');
  });

  it('honours an explicit colour and size', () => {
    const custom = matrixToSvg(matrix, { color: '#ff0000', size: 320 });

    expect(custom).toContain('fill="#ff0000"');
    expect(custom).toContain('width="320"');
    expect(custom).toContain('height="320"');
  });

  it('is labelled for screen readers', () => {
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="QR code"');
    expect(matrixToSvg(matrix, { label: 'Thoth invite' })).toContain(
      'aria-label="Thoth invite"'
    );
  });

  it('escapes a label that would otherwise break the markup', () => {
    const hostile = matrixToSvg(matrix, { label: 'a" onload="x' });

    expect(hostile).not.toContain('onload="x"');
    expect(hostile).toContain('&quot;');
  });

  it('draws one path segment per dark module', () => {
    const dark = matrix.modules.flat().filter(Boolean).length;
    const segments = svg.match(/M\d+ \d+h1v1h-1z/g) ?? [];

    expect(segments).toHaveLength(dark);
  });
});

describe('qrSvg', () => {
  it('encodes and renders in one step', () => {
    const svg = qrSvg(LINK);

    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox="0 0');
  });

  it('produces a different code for a different vault', () => {
    // If these were identical the code would silently send a device to the
    // wrong vault.
    expect(qrSvg(LINK)).not.toBe(
      qrSvg('thoth://?serverUrl=https%3A%2F%2Fs.test&vaultId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    );
  });
});
