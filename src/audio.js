// Preview volume per media element. HTMLMediaElement.volume stops at 1 (0 dB), so a boosted clip is
// routed through Web Audio with a GainNode; elements that never go above 0 dB stay on plain `volume`.
// Routing needs the media to be CORS-clean (crossOrigin="anonymous" + the media:// protocol's CORS header).

let ctx = null;
const gains = new WeakMap();

/**
 * Set an element's playback gain (linear; 1 = 0 dB, 0 = mute).
 * @param {HTMLMediaElement} el
 * @param {number} gain
 */
export function setGain(el, gain) {
  const g = Math.max(0, Number.isFinite(gain) ? gain : 1);
  try {
    if (!gains.has(el)) {
      if (g <= 1) {
        if (Math.abs(el.volume - g) > 1e-3) el.volume = g;
        return;
      }
      ctx ??= new AudioContext();
      const node = ctx.createGain();
      ctx.createMediaElementSource(el).connect(node).connect(ctx.destination);
      gains.set(el, node);
      el.volume = 1;
      globalThis.__vceAudioRouted = (globalThis.__vceAudioRouted ?? 0) + 1; // debugging and end-to-end checks
    }
    const node = gains.get(el);
    if (Math.abs(node.gain.value - g) > 1e-3) node.gain.value = g;
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    el.volume = Math.min(1, g); // Web Audio unavailable: up to 0 dB only
  }
}
