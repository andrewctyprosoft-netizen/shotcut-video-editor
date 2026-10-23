// Gap-free preview playback of the main track with two <video> elements: one plays the current clip while
// the other sits paused on the first frame of the next clip. At the boundary they swap, so there is no seek
// or reload between clips. During a transition both play: the outgoing clip keeps running until its end
// while the incoming one starts. Stills (images, GIFs) and the part of the timeline after the main track
// (layers and subtitles can run longer) are timed by the wall clock instead of a video.
// DOM-free apart from the video objects it is given, so tests use fakes.

import { locate } from '../core/project.js';

const EPS = 1e-6;
/** Seconds before a boundary when the hidden video starts playing (muted), so its decoder and audio are running at the swap. */
export const PREROLL = 0.3;

export class PlaybackEngine {
  /**
   * @param {{videos: [object, object], urlFor: (clip: object) => string, styleFor?: (clip: object) => string,
   *   isStill?: (clip: object) => boolean, now?: () => number, onTime: (t: number) => void, onEnd: () => void}} opts
   *   isStill: clips shown by the page (images, GIFs), not by a video slot
   *   onShow(t): the visible slots changed at timeline time t (the page restyles them in the same frame)
   */
  constructor({ videos, urlFor, styleFor = () => 'none', isStill = () => false, now = () => performance.now(), onTime, onEnd, onShow = () => {} }) {
    this.slots = videos.map((video) => ({ video, url: null, item: null, target: 0, preroll: false }));
    this.active = 0;
    this.outgoing = null; // slot index still playing the clip before a transition
    this.items = [];
    this.total = 0;
    this.playing = false;
    this.clock = { t0: 0, wall: 0 };
    this.urlFor = urlFor;
    this.styleFor = styleFor;
    this.isStill = isStill;
    this.now = now;
    this.onTime = onTime;
    this.onEnd = onEnd;
    this.onShow = onShow;
    this.show();
  }

  /**
   * New layout after an edit. Keeps playing without a reseek when the clip on screen did not change.
   * @param {Array<object>} items layout(project) of the main track
   * @param {number} t current timeline time
   * @param {number} [total] timeline length (defaults to the end of the main track)
   */
  sync(items, t, total) {
    this.items = items;
    this.total = Math.max(total ?? 0, items.length ? items[items.length - 1].end : 0);
    const hit = locate(null, t, items);
    const a = this.slots[this.active];
    const inMain = hit && t < hit.item.end - EPS;
    const same = inMain && a.item && a.item.clip === hit.clip && a.item.start === hit.item.start && a.url === this.urlForItem(hit.item);
    if (!same || (this.outgoing !== null && !items.some((i) => i.clip === this.slots[this.outgoing].item?.clip))) {
      this.seek(t);
      return;
    }
    a.item = hit.item;
    const other = this.slots[1 - this.active];
    if (other.item) other.item = items.find((i) => i.clip === other.item.clip) ?? null;
    if (this.outgoing === null) this.preloadNext();
  }

  /** Show timeline time `t`: load its clip into the visible slot and the next clip into the hidden one. */
  seek(t) {
    this.stopOutgoing(false);
    const hit = locate(null, t, this.items);
    const a = this.slots[this.active];
    this.clock = { t0: t, wall: this.now() };
    if (!hit || t >= hit.item.end - EPS) {
      for (const s of this.slots) {
        s.video.pause();
        this.cancelPreroll(s);
        s.item = null;
      }
      this.show(t);
      return;
    }
    this.load(a, hit.item, hit.sourceTime);
    if (this.playing && !this.isStill(hit.clip)) safePlay(a.video);
    // Inside a transition: the clip before it is still on screen too.
    const prev = this.items[hit.item.index - 1];
    if (prev && hit.item.overlap > 0 && t < hit.item.start + hit.item.overlap && !this.isStill(prev.clip)) {
      const o = this.slots[1 - this.active];
      this.load(o, prev, Math.min(prev.clip.in + (t - prev.start) * prev.clip.speed, prev.clip.out));
      this.outgoing = 1 - this.active;
      if (this.playing) safePlay(o.video);
    }
    this.show(t);
    if (this.outgoing === null) this.preloadNext();
  }

  play() {
    this.playing = true;
    this.clock = { t0: this.currentTime(), wall: this.now() };
    const a = this.slots[this.active];
    if (a.item && !this.isStill(a.item.clip)) safePlay(a.video);
    if (this.outgoing !== null) safePlay(this.slots[this.outgoing].video);
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
    this.tickOutgoing();
    const a = this.slots[this.active];
    const { video: v, item } = a;
    const byClock = !item || this.isStill(item.clip);
    if (!byClock && (v.seeking || v.readyState < 2)) {
      this.clock = { t0: this.currentTime(), wall: this.now() };
      return;
    }
    const t = byClock ? this.clock.t0 + (this.now() - this.clock.wall) / 1000 : item.start + (v.currentTime - item.clip.in) / item.clip.speed;
    const next = item ? this.items[item.index + 1] : null;
    const limit = item ? (next ? next.start : item.end) : this.total;
    if (t < limit - 0.001 && !(!byClock && v.ended)) {
      if (next && limit - t <= PREROLL && !this.isStill(next.clip) && this.outgoing === null) this.preroll(this.slots[1 - this.active], next, limit - t);
      this.onTime(Math.max(t, item?.start ?? 0));
      return;
    }
    if (!next) {
      if (item && item.end < this.total - EPS) {
        // Main track over; layers or subtitles keep the timeline going.
        v.pause();
        a.item = null;
        this.clock = { t0: item.end, wall: this.now() };
        this.show();
        this.onTime(item.end);
        return;
      }
      this.pause();
      this.onTime(item ? item.end : this.total);
      this.onEnd();
      return;
    }
    this.clock = { t0: next.start, wall: this.now() };
    const o = this.slots[1 - this.active];
    const transition = next.overlap > 0 && item && !this.isStill(item.clip);
    if (this.isStill(next.clip)) {
      if (!transition) v.pause();
      this.load(o, next, next.clip.in);
      this.active = 1 - this.active;
      this.outgoing = transition ? 1 - this.active : null;
    } else if (o.item?.clip === next.clip && o.url === this.urlForItem(next) && Math.abs(o.target - next.clip.in) < EPS) {
      if (o.preroll) {
        o.video.muted = false;
        o.preroll = false;
      } else {
        safePlay(o.video);
      }
      if (!transition) v.pause();
      this.active = 1 - this.active;
      this.outgoing = transition ? 1 - this.active : null;
    } else {
      this.load(a, next, next.clip.in); // not preloaded (e.g. an edit just happened): fall back to one slot
      safePlay(v);
    }
    this.show(next.start);
    this.onTime(next.start);
    if (this.outgoing === null) this.preloadNext();
  }

  /** Index of the visible slot (for tests and debugging). */
  get activeSlot() {
    return this.active;
  }

  // ---------- internals ----------

  /** Timeline time the engine is at (for restarting the clock). */
  currentTime() {
    const a = this.slots[this.active];
    if (!a.item || this.isStill(a.item.clip)) return this.clock.t0 + (this.playing ? (this.now() - this.clock.wall) / 1000 : 0);
    return a.item.start + (a.video.currentTime - a.item.clip.in) / a.item.clip.speed;
  }

  /** The clip before a transition stops at its own end. */
  tickOutgoing() {
    if (this.outgoing === null) return;
    const o = this.slots[this.outgoing];
    const it = o.item;
    const t = it ? it.start + (o.video.currentTime - it.clip.in) / it.clip.speed : Infinity;
    if (!it || o.video.ended || t >= it.end - 0.001) this.stopOutgoing(true);
  }

  stopOutgoing(preload) {
    if (this.outgoing === null) return;
    const o = this.slots[this.outgoing];
    this.outgoing = null;
    o.video.pause();
    this.show();
    if (preload) this.preloadNext();
  }

  urlForItem(item) {
    return this.isStill(item.clip) ? null : this.urlFor(item.clip);
  }

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
    if (!next || this.isStill(next.clip)) return;
    const ready = o.item?.clip === next.clip && o.url === this.urlForItem(next) && Math.abs(o.target - next.clip.in) < EPS;
    if (!ready) this.load(o, next, next.clip.in);
    o.video.pause();
  }

  load(slot, item, sourceTime) {
    const v = slot.video;
    this.cancelPreroll(slot);
    slot.item = item;
    slot.target = sourceTime;
    if (this.isStill(item.clip)) {
      v.pause();
      return; // drawn by the page; the slot keeps whatever file it had
    }
    const url = this.urlFor(item.clip);
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

  show(t = this.currentTime()) {
    this.slots.forEach((s, i) => {
      const on = (i === this.active || i === this.outgoing) && s.item && !this.isStill(s.item.clip);
      s.video.style.visibility = on ? 'visible' : 'hidden';
    });
    this.onShow?.(t);
  }
}

function safePlay(video) {
  const p = video.play();
  if (p?.catch) p.catch(() => {}); // AbortError when the source changes mid-play
}
