"use client";

import { useEffect, useRef } from "react";

const revealSelector = [
  ".metric-card", ".panel", ".next-assignment-card", ".event-card", ".asset-card",
  ".checklist-card", ".sop-card", ".training-path", ".content-card", ".incident-card",
  ".settings-panel", ".settings-card", ".welcome-line", ".section-intro", ".login-brand",
  ".login-side-content",
].join(",");

export function AmbientEffects() {
  const beamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const beam = beamRef.current;
    let frame = 0;
    let nextX = -1000;
    let nextY = -1000;

    const moveBeam = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      nextX = event.clientX - 340;
      nextY = event.clientY - 340;
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        beam?.style.setProperty("--beam-x", `${nextX}px`);
        beam?.style.setProperty("--beam-y", `${nextY}px`);
        frame = 0;
      });
    };

    window.addEventListener("pointermove", moveBeam, { passive: true });

    let revealObserver: IntersectionObserver | undefined;
    let mutationObserver: MutationObserver | undefined;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reducedMotion && "IntersectionObserver" in window) {
      revealObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-revealed");
          revealObserver?.unobserve(entry.target);
        }
      }, { threshold: 0.12, rootMargin: "0px 0px -38px 0px" });

      const scan = (root: ParentNode = document) => {
        root.querySelectorAll<HTMLElement>(revealSelector).forEach((element) => {
          if (element.dataset.scrollReveal === "ready") return;
          element.dataset.scrollReveal = "ready";
          element.classList.add("scroll-reveal");
          revealObserver?.observe(element);
        });
      };

      scan();
      mutationObserver = new MutationObserver(() => scan());
      mutationObserver.observe(document.body, { childList: true, subtree: true });
    }

    return () => {
      window.removeEventListener("pointermove", moveBeam);
      if (frame) window.cancelAnimationFrame(frame);
      revealObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, []);

  return <div ref={beamRef} className="cursor-beam" aria-hidden="true" />;
}
