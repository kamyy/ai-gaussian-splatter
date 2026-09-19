"use client";

import { useEffect, useRef, useState } from "react";

// Shared by web/components/splats/SplatCarousel.tsx (vertical) and web/components/splats/PhotoFilmstrip.tsx
// (horizontal): click-and-drag panning for a scrollable element, on top of its native scrollbar/wheel scrolling, plus
// momentum after release. Mouse only — touch and pen
// already pan a scrollable element natively, and handling those too would fight the browser's own gesture. Wheel
// input deliberately has no momentum of its own; only a drag release hands off to runMomentum.
//
// Velocity decays by this fraction every ~16ms until it drops below MOMENTUM_MIN_VELOCITY, at which point the
// animation stops outright rather than crawling on forever.
const MOMENTUM_FRICTION_PER_FRAME = 0.95;
const MOMENTUM_MIN_VELOCITY = 0.02;
// Safety cap, not a tuned physics constant: a real flick's velocity decays below MOMENTUM_MIN_VELOCITY in well under
// a second in practice. This only guards against a pathological dt sequence (e.g. a backgrounded tab's rAF clock
// reporting near-zero elapsed time between callbacks) that would otherwise let the loop keep rescheduling itself
// indefinitely instead of terminating.
const MOMENTUM_MAX_DURATION_MS = 4000;
// A plain click always moves the mouse by a pixel or two between press and release. Panning from the very first
// pointermove — capturing the pointer and writing scrollTop/scrollLeft — makes the browser treat that as a scroll
// gesture and drop the synthetic click it would otherwise fire on release, which breaks any link or button (e.g. a
// SplatCarouselCard) nested inside the scrollable element. Below this threshold a move is just click jitter, not a
// drag, so it's ignored instead of starting a pan.
const PAN_THRESHOLD_PX = 4;

interface UseDragMomentumScrollOptions {
  axis: "x" | "y";
}

function pointerPos(event: { clientX: number; clientY: number }, axis: "x" | "y") {
  return axis === "x" ? event.clientX : event.clientY;
}

export function useDragMomentumScroll<T extends HTMLElement>({ axis }: UseDragMomentumScrollOptions) {
  const elementRef = useRef<T>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ pointerPos: number; scrollPos: number } | null>(null);
  // Whether this gesture has crossed PAN_THRESHOLD_PX and actually started panning. Read synchronously from within
  // onPointerMove/onPointerUp, so it's a ref rather than the isPanning state (which only reflects the last render).
  const isDraggingRef = useRef(false);
  // Velocity in px/ms, signed the same way the pointer moves along `axis` (positive = right or down). Recomputed on
  // every pointermove from real timestamps rather than per-event pixel deltas, since move events don't fire at a
  // fixed rate.
  const velocityRef = useRef(0);
  const lastMoveRef = useRef<{ pos: number; time: number } | null>(null);
  const momentumFrameRef = useRef<number | null>(null);

  function stopMomentum() {
    if (momentumFrameRef.current !== null) {
      cancelAnimationFrame(momentumFrameRef.current);
      momentumFrameRef.current = null;
    }
  }

  // Unmount only: the handlers below call stopMomentum() themselves whenever a new drag or another scroll action
  // should pre-empt it.
  useEffect(() => {
    return () => {
      if (momentumFrameRef.current !== null) {
        cancelAnimationFrame(momentumFrameRef.current);
      }
    };
  }, []);

  function runMomentum(el: T) {
    const start = performance.now();
    let lastTime = start;
    function step(now: number) {
      const dt = now - lastTime;
      lastTime = now;
      // dt <= 0 (duplicate/coalesced frame timestamps) applies no decay this frame rather than a no-op `** 0`
      // multiplier, and the duration cap below is what still guarantees termination if that keeps happening.
      if (dt > 0) {
        velocityRef.current *= MOMENTUM_FRICTION_PER_FRAME ** (dt / 16);
      }
      if (Math.abs(velocityRef.current) < MOMENTUM_MIN_VELOCITY || now - start > MOMENTUM_MAX_DURATION_MS) {
        momentumFrameRef.current = null;
        return;
      }
      if (axis === "x") {
        el.scrollLeft -= velocityRef.current * dt;
      } else {
        el.scrollTop -= velocityRef.current * dt;
      }
      momentumFrameRef.current = requestAnimationFrame(step);
    }
    momentumFrameRef.current = requestAnimationFrame(step);
  }

  function onPointerDown(event: React.PointerEvent<T>) {
    if (event.pointerType !== "mouse") {
      return;
    }
    stopMomentum();
    // Pointer capture and isPanning wait for onPointerMove to actually cross PAN_THRESHOLD_PX — see its comment.
    const pos = pointerPos(event, axis);
    const scrollPos = axis === "x" ? event.currentTarget.scrollLeft : event.currentTarget.scrollTop;
    panStartRef.current = { pointerPos: pos, scrollPos };
    lastMoveRef.current = { pos, time: performance.now() };
    velocityRef.current = 0;
  }

  function onPointerMove(event: React.PointerEvent<T>) {
    const start = panStartRef.current;
    if (!start) {
      return;
    }
    const pos = pointerPos(event, axis);
    if (!isDraggingRef.current) {
      if (Math.abs(pos - start.pointerPos) < PAN_THRESHOLD_PX) {
        return;
      }
      isDraggingRef.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setIsPanning(true);
    }

    const scrollPos = start.scrollPos - (pos - start.pointerPos);
    if (axis === "x") {
      event.currentTarget.scrollLeft = scrollPos;
    } else {
      event.currentTarget.scrollTop = scrollPos;
    }

    const now = performance.now();
    const last = lastMoveRef.current;
    if (last) {
      const dt = now - last.time;
      // Skip zero/near-zero intervals (duplicate or coalesced events) rather than dividing by them.
      if (dt > 0) {
        velocityRef.current = (pos - last.pos) / dt;
      }
    }
    lastMoveRef.current = { pos, time: now };
  }

  function onPointerUp(event: React.PointerEvent<T>) {
    const el = event.currentTarget;
    const wasDragging = isDraggingRef.current;
    panStartRef.current = null;
    lastMoveRef.current = null;
    isDraggingRef.current = false;
    setIsPanning(false);
    if (wasDragging && Math.abs(velocityRef.current) >= MOMENTUM_MIN_VELOCITY) {
      runMomentum(el);
    }
  }

  return {
    elementRef,
    isPanning,
    stopMomentum,
    dragHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}
