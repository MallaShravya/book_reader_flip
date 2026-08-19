/**
 * Tileable value noise.
 *
 * Written out rather than pulled in, because the one property that matters
 * here is not in most noise libraries: the lattice wraps, so the texture can
 * repeat across a shelf of any width with no seam. Everything else — the
 * hashing, the interpolation — is the standard construction.
 */

/** Deterministic hash of a lattice point. Same input, same value, always. */
function hash(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 1442695040888963407
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 1274126177) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

/** Smoothstep: the ease that stops interpolation looking like a grid. */
const fade = (t) => t * t * (3 - 2 * t)

/**
 * Value noise at (x, y), on a lattice that repeats every `px` by `py`.
 *
 * Coordinates are taken modulo the period before hashing, which is what makes
 * the result seamless: the right edge samples the same lattice points as the
 * left.
 */
export function noise(x, y, px, py, seed = 1) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = fade(x - x0)
  const fy = fade(y - y0)

  const wrap = (v, period) => ((v % period) + period) % period
  const xa = wrap(x0, px)
  const xb = wrap(x0 + 1, px)
  const ya = wrap(y0, py)
  const yb = wrap(y0 + 1, py)

  const v00 = hash(xa, ya, seed)
  const v10 = hash(xb, ya, seed)
  const v01 = hash(xa, yb, seed)
  const v11 = hash(xb, yb, seed)

  const top = v00 + (v10 - v00) * fx
  const bottom = v01 + (v11 - v01) * fx
  return top + (bottom - top) * fy
}

/**
 * Fractal noise: several octaves of the above, each finer and fainter.
 *
 * The periods double with the frequency so every octave still wraps, which a
 * naive fBm does not — that is the usual reason a "seamless" texture seams.
 */
export function fbm(x, y, px, py, octaves = 4, seed = 1) {
  let sum = 0
  let amplitude = 1
  let total = 0

  for (let o = 0; o < octaves; o++) {
    const scale = 2 ** o
    sum += noise(x * scale, y * scale, px * scale, py * scale, seed + o * 101) * amplitude
    total += amplitude
    amplitude *= 0.5
  }

  return sum / total
}
