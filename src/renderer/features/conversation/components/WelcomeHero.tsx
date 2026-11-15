import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties } from "react";
import gentleRose from "@renderer/shared/assets/gentle-rose.png";
import "./WelcomeHero.css";

/**
 * The animated welcome hero (desktop-rpc T9b, spec S8): app-local animation,
 * not driven by pi — the native choreography paints through
 * `ctx.ui.setHeader`, which RPC does not expose.
 *
 * Ported from `design/slack-gentle/01-workspace.html`, which is the reference
 * for the choreography: the rose arrives and takes one restrained highlight,
 * the eleven cursive strokes of "Gentle Shell" draw in sequence, then one
 * glint and a finishing sparkle. It is a one-shot intro, never a loop.
 *
 * Two rules come straight from the artboard rather than from taste:
 *  - it plays once per chat and settles when the chat is restored, so
 *    switching back to a chat never replays the intro — an intro only counts
 *    as played once it ran to completion, so an interrupted one replays;
 *  - it settles immediately and statically under `prefers-reduced-motion`,
 *    and cancels an intro already in flight if the preference flips.
 */

interface Letter {
  readonly delay: string;
  readonly path: string;
}

// One entry per handwritten letter. `--letter-delay` is what spaces the
// overlapping strokes (150ms, then 110ms apart; each stroke draws for 420ms).
const LETTERS: readonly Letter[] = [
  { delay: "150ms", path: "M82 37C81 11 44 18 26 42C1 75 10 99 35 95C58 92 78 70 74 54C68 49 51 58 41 70M24 105C42 105 59 90 71 72L90 65" },
  { delay: "260ms", path: "M85 75C116 62 114 47 101 51C84 55 78 83 92 85C103 87 118 74 124 64" },
  { delay: "370ms", path: "M119 79L131 53L123 78C142 43 155 46 147 66L140 81C150 82 157 73 162 64" },
  { delay: "480ms", path: "M161 76L181 28M159 52L188 49M172 51L163 76C161 88 180 82 187 69" },
  { delay: "590ms", path: "M189 73C201 63 225 20 214 21C205 20 190 62 189 77C187 92 207 78 215 67" },
  { delay: "700ms", path: "M212 74C245 61 242 47 229 51C211 56 207 83 223 84C237 85 249 73 255 65" },
  { delay: "810ms", path: "M335 36C325 11 282 28 280 49C277 67 316 54 312 75C308 98 269 107 260 93M261 94C260 85 275 78 288 79" },
  { delay: "920ms", path: "M328 78C342 60 365 11 354 19C343 25 331 68 329 81C347 48 364 48 355 69C348 85 359 83 370 69" },
  { delay: "1030ms", path: "M368 74C397 60 398 48 384 51C367 55 362 81 377 84C389 86 401 74 408 64" },
  { delay: "1140ms", path: "M408 74C426 52 438 20 428 21C418 20 405 63 405 77C403 91 421 79 431 67" },
  { delay: "1250ms", path: "M432 74C449 52 465 19 454 21C442 22 429 63 430 77C429 96 457 78 466 65" },
];

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const SPARK_PATH = "m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8Z";

export type WelcomeIntro = "playing" | "complete";

export interface WelcomeHeroProps {
  /** Identity of the chat whose intro this is: one intro per chat. */
  readonly chatKey: string;
}

// Which chats already played their intro to the end. Module-level on
// purpose: it must survive a chat being closed and restored, exactly like
// the artboard's per-chat `introPlayed` flag, and it holds no user data.
// Only COMPLETED intros are recorded — React's StrictMode throwaway mount
// and a chat switch mid-intro never mark a chat as played, so an intro that
// was interrupted is played again the next time its chat opens.
const completedIntros = new Set<string>();

/** Test-only: clears the intro registry so tests start from a clean state. */
export function resetWelcomeHeroIntrosForTests(): void {
  completedIntros.clear();
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.(REDUCED_MOTION_QUERY).matches === true;
}

function animationsOf(hero: HTMLElement): Animation[] {
  return typeof hero.getAnimations === "function" ? hero.getAnimations({ subtree: true }) : [];
}

export function WelcomeHero({ chatKey }: WelcomeHeroProps) {
  // SVG ids must stay unique when more than one hero exists (Helpers and the
  // chat pane can both be mounted); useId avoids the collision and the
  // generated delimiters are stripped so `url(#…)` stays a valid reference.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const maskId = `gc-welcome-ink-mask-${uid}`;
  const heroRef = useRef<HTMLElement>(null);
  // Decided during the first render, not in an effect: the CSS default for
  // `.gc-welcome` is the fully drawn hero, so any first paint without a
  // decision would flash the finished state before the intro restarts.
  // Already-completed chats and reduced motion land on the static end state
  // immediately; everything else paints already playing.
  const [intro, setIntro] = useState<WelcomeIntro>(() =>
    completedIntros.has(chatKey) || prefersReducedMotion() ? "complete" : "playing",
  );

  // The `is-playing` class is what creates the
  // CSS animations, but they only exist once the browser has computed style
  // for that class — reading them in the same effect that committed it returns
  // nothing and would end the intro before it painted. The first frame after
  // the commit is the earliest reliable read; settling then means "every
  // animation finished", so the CSS stays the only owner of the timing.
  useEffect(() => {
    if (intro !== "playing") return;
    const hero = heroRef.current;
    if (!hero) return;
    let cancelled = false;
    const settle = (): void => {
      if (cancelled) return;
      completedIntros.add(chatKey);
      setIntro("complete");
    };
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      const animations = animationsOf(hero);
      if (animations.length === 0) {
        settle();
        return;
      }
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        if (hero.isConnected) settle();
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [intro, chatKey]);

  // A preference that flips mid-intro cancels the run and lands on the static
  // end state, so the hero never finishes animating for someone who asked it
  // not to.
  useEffect(() => {
    if (intro !== "playing") return;
    const hero = heroRef.current;
    const query = window.matchMedia?.(REDUCED_MOTION_QUERY);
    if (!hero || !query?.addEventListener) return;
    const onMotionChange = (event: MediaQueryListEvent): void => {
      if (!event.matches) return;
      animationsOf(hero).forEach((animation) => animation.cancel());
      completedIntros.add(chatKey);
      setIntro("complete");
    };
    query.addEventListener("change", onMotionChange);
    return () => query.removeEventListener("change", onMotionChange);
  }, [intro, chatKey]);

  const className = intro === "playing" ? "gc-welcome is-playing" : "gc-welcome";

  return (
    <header
      ref={heroRef}
      className={className}
      data-testid="gc-welcome-hero"
      data-intro={intro}
      aria-label="Gentle Shell Desktop welcome"
    >
      <img className="gc-welcome__rose" src={gentleRose} width={112} height={112} alt="Gentle Shell rose" />
      <div className="gc-welcome__wordmark">
        <svg className="gc-welcome__logo" viewBox="0 0 480 124" role="img" aria-label="Gentle Shell">
          <title>Gentle Shell</title>
          <defs>
            <mask id={maskId}>
              <g fill="none" stroke="white" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round">
                {LETTERS.map((letter) => (
                  <path key={letter.delay} d={letter.path} />
                ))}
              </g>
            </mask>
          </defs>
          <g fill="none" strokeLinecap="round" strokeLinejoin="round">
            {LETTERS.map((letter) => (
              <g key={letter.delay} style={{ "--letter-delay": letter.delay } as CSSProperties}>
                <path className="gc-welcome__ink" pathLength={1} d={letter.path} />
                <path className="gc-welcome__tip" pathLength={1} d={letter.path} />
              </g>
            ))}
          </g>
          <rect
            className="gc-welcome__glint"
            x={-80}
            y={0}
            width={80}
            height={124}
            mask={`url(#${maskId})`}
          />
        </svg>
        <p className="gc-welcome__desktop">
          DESKTOP <span>· You lead. Gentle helps.</span>
        </p>
        <svg className="gc-welcome__spark" width={18} height={18} viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d={SPARK_PATH} />
        </svg>
      </div>
    </header>
  );
}
