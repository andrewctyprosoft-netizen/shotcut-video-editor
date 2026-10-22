// Gap-free preview playback with two <video> elements: one plays the current clip while the other
// sits paused on the first frame of the next clip. At the boundary they swap, so there is no seek or
// reload between clips. DOM-free apart from the video objects it is given, so tests use fakes.

import { locate } from '../core/project.js';

const EPS = 1e-6;
/** Seconds before a boundary when the hidden video starts playing (muted), so its decoder and audio are running at the swap. */
export const PREROLL = 0.3;

export class PlaybackEngine {
  /**
   * @param {{videos: [object, object], urlFor: (clip: object) => string, styleFor?: (clip: object) => string,
   *   onTime: (t: number) => void, onEnd: () => void}} opts
   */
  constructor({ videos, urlFor, styleFor = () => 'none', onTime, onEnd }) {
    this.slots = videos.map((video) => ({ video, url: null, item: null, target: 0, preroll: false }));
    this.active = 0;
    this.items = [];
    this.playing = false;
    this.urlFor = urlFor;
    this.styleFor = styleFor;
    this.onTime = onTime;
    this.onEnd = onEnd;
    this.show();
  }

  /**
   * New layout after an edit. Keeps playing without a reseek when the clip on screen did not change.
   * @param {Array<object>} items layout(project)
   * @param {number} t current timeline time
   */
  sync(items, t) {
    this.items = items;
    const hit = locate(null, t, items);
    const a = this.slots[this.active];
    const same = hit && a.item && a.item.clip === hit.clip && a.item.start === hit.item.start && a.url === this.urlFor(hit.clip);
    if (!same) {
      this.seek(t);
      return;
    }
    a.item = hit.item;
    const other = this.slots[1 - this.active];
    if (other.item) other.item = items.find((i) => i.clip === other.item.clip) ?? null;
    this.preloadNext();
  }

  /** Show timeline time `t`: load its clip into the visible slot and the next clip into the hidden one. */
  seek(t) {
    const hit = locate(null, t, this.items);
    const a = this.slots[this.active];
    if (!hit) {
      for (const s of this.slots) {
        s.video.pause();
        s.item = null;
      }
      this.show();
      return;
    }
    this.load(a, hit.item, hit.sourceTime);
    if (this.playing) safePlay(a.video);
    this.show();
    this.preloadNext();
  }

  play() {
    this.playing = true;
    safePlay(this.slots[this.active].video);
  }

  pause() {
    this.playing = false;
    for (const s of this.slots) {
      s.video.pause();
      this.cancelPreroll(s);
    }
  }

  /** Call once per animation frame while playing: reports time, swaps at clip boundaries, ends at the end. */
  tick() {
    if (!this.playing) return;
    const a = this.slots[this.active];
    const { video: v, item } = a;
    if (!item || v.seeking || v.readyState < 2) return;
    const t = item.start + (v.currentTime - item.clip.in) / item.clip.speed;
    const next = this.items[item.index + 1];
    const limit = next ? next.start : item.end;
    if (t < limit - 0.001 && !v.ended) {
      if (next && limit - t <= PREROLL) this.preroll(this.slots[1 - this.active], next, limit - t);
      this.onTime(Math.max(t, item.start));
      return;
    }
    if (!next) {
      this.pause();
      this.onTime(item.end);
      this.onEnd();
      return;
    }
    const o = this.slots[1 - this.active];
    if (o.item?.clip === next.clip && o.url === this.urlFor(next.clip) && Math.abs(o.target - next.clip.in) < EPS) {
      if (o.preroll) {
        o.video.muted = false;
        o.preroll = false;
      } else {
        safePlay(o.video);
      }
      v.pause();
      this.active = 1 - this.active;
      this.show();
    } else {
      this.load(a, next, next.clip.in); // not preloaded (e.g. an edit just happened): fall back to one slot
      safePlay(v);
    }
    this.onTime(next.start);
    this.preloadNext();
  }

  /** Index of the visible slot (for tests and debugging). */
  get activeSlot() {
    return this.active;
  }

  // ---------- internals ----------

  /** Start the hidden slot early and muted, timed to reach the clip's in-point at the boundary. */
  preroll(o, next, remaining) {
    if (o.preroll || o.item?.clip !== next.clip || o.video.readyState < 2 || o.video.seeking) return;
    o.preroll = true;
    o.video.muted = true;
    o.video.currentTime = Math.max(0, next.clip.in - remaining * next.clip.speed);
    safePlay(o.video);
  }

  cancelPreroll(slot) {
    if (!slot.preroll) return;
    slot.preroll = false;
    slot.video.muted = false;
    slot.video.pause();
    slot.video.currentTime = slot.target;
  }

  preloadNext() {
    const a = this.slots[this.active];
    const next = a.item ? this.items[a.item.index + 1] : null;
    const o = this.slots[1 - this.active];
    this.cancelPreroll(o);
    if (!next) return;
    const ready = o.item?.clip === next.clip && o.url === this.urlFor(next.clip) && Math.abs(o.target - next.clip.in) < EPS;
    if (!ready) this.load(o, next, next.clip.in);
    o.video.pause();
  }

  load(slot, item, sourceTime) {
    const v = slot.video;
    this.cancelPreroll(slot);
    const url = this.urlFor(item.clip);
    slot.item = item;
    slot.target = sourceTime;
    const rate = item.clip.speed;
    if (slot.url !== url) {
      slot.url = url;
      v.src = url;
      v.addEventListener('loadedmetadata', () => {
        if (slot.url !== url) return;
        v.currentTime = slot.target;
        v.defaultPlaybackRate = slot.item.clip.speed;
        v.playbackRate = slot.item.clip.speed;
      }, { once: true });
    } else {
      v.currentTime = sourceTime;
    }
    v.defaultPlaybackRate = rate;
    v.playbackRate = rate;
    v.style.filter = this.styleFor(item.clip);
  }

  show() {
    this.slots.forEach((s, i) => {
      s.video.style.visibility = i === this.active && s.item ? 'visible' : 'hidden';
    });
  }
}

function safePlay(video) {
  const p = video.play();
  if (p?.catch) p.catch(() => {}); // AbortError when the source changes mid-play
}
