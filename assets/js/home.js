document.documentElement.classList.remove('no-js');
document.documentElement.classList.add('js');

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

async function setupStableTextLayout() {
  const elements = Array.from(document.querySelectorAll('[data-pretext]'));
  if (!elements.length) return;

  await document.fonts.ready;

  let layoutFrame = 0;
  function relayout() {
    layoutFrame = 0;
    elements.forEach((element) => {
      if (!element.isConnected || element.clientWidth <= 0) return;
      const previous = element.style.minHeight;
      element.style.minHeight = '0px';
      const measured = `${Math.ceil(element.getBoundingClientRect().height)}px`;
      element.style.minHeight = previous === measured ? previous : measured;
    });
  }

  function scheduleRelayout() {
    if (layoutFrame) return;
    layoutFrame = window.requestAnimationFrame(relayout);
  }

  const resizeObserver = new ResizeObserver(scheduleRelayout);
  elements.forEach((element) => resizeObserver.observe(element));

  const mutationObserver = new MutationObserver((records) => {
    if (!records.length) return;
    scheduleRelayout();
  });

  elements.forEach((element) => {
    mutationObserver.observe(element, { characterData: true, childList: true, subtree: true });
  });

  window.addEventListener('resize', scheduleRelayout, { passive: true });
  window.addEventListener('orientationchange', scheduleRelayout, { passive: true });
  scheduleRelayout();
}

function setupCloseFilm() {
  const media = document.querySelector('[data-hero-media]');
  const video = media?.querySelector('[data-close-film]');
  const toggle = media?.querySelector('[data-close-film-toggle]');
  const startPoster = media?.querySelector('[data-close-film-start]');
  const finalPoster = media?.querySelector('[data-close-film-final]');
  if (!media || !video || !toggle || !startPoster || !finalPoster) return;

  const desktopQuery = window.matchMedia('(min-width: 1024px)');
  let openingPosterAttached = false;
  let finalPosterAttached = false;
  let openingPosterReady = false;
  let posterListenersAttached = false;
  let sourceAttached = false;
  let hasStarted = false;
  let hasEnded = false;
  let hasFailed = false;
  let observer = null;

  video.defaultMuted = true;
  video.muted = true;

  function canAnimate() {
    return desktopQuery.matches && !motionQuery.matches;
  }

  function setControlState(state) {
    toggle.dataset.filmControlState = state === 'pause' ? 'pause' : 'play';
    const labels = {
      pause: 'Pause close animation',
      play: 'Resume close animation',
      start: 'Play close animation',
    };
    toggle.setAttribute('aria-label', labels[state]);
  }

  function attachOpeningPoster() {
    if (openingPosterAttached) return;
    const startSource = startPoster.dataset.src;
    const startSourceSet = startPoster.dataset.srcset;
    const finalSource = finalPoster.dataset.src;
    if (!startSource || !finalSource) return;

    if (!posterListenersAttached) {
      posterListenersAttached = true;
      startPoster.addEventListener(
        'load',
        () => {
          openingPosterReady = true;
          if (canAnimate()) armFilm();
        },
        { once: true },
      );
      startPoster.addEventListener(
        'error',
        () => {
          hasFailed = true;
          settleToTextFallback();
        },
        { once: true },
      );
      finalPoster.addEventListener(
        'error',
        () => {
          hasFailed = true;
          settleToTextFallback();
        },
        { once: true },
      );
    }

    if (startSourceSet) startPoster.srcset = startSourceSet;
    startPoster.src = startSource;
    openingPosterAttached = true;

    if (startPoster.complete && startPoster.naturalWidth > 0) {
      openingPosterReady = true;
    }
  }

  function attachFinalPoster() {
    if (finalPosterAttached) return;
    const finalSource = finalPoster.dataset.src;
    const finalSourceSet = finalPoster.dataset.srcset;
    if (!finalSource) return;
    if (finalSourceSet) finalPoster.srcset = finalSourceSet;
    finalPoster.src = finalSource;
    finalPosterAttached = true;
  }

  function attachSource() {
    if (sourceAttached) return;
    attachOpeningPoster();
    const source = video.dataset.src;
    if (!source) return;
    video.src = source;
    video.load();
    sourceAttached = true;
  }

  async function playFilm() {
    if (!canAnimate() || hasEnded || hasFailed) return;
    attachSource();
    media.classList.add('is-film-enabled');
    try {
      await video.play();
    } catch {
      if (!canAnimate()) {
        settleToStatic();
        return;
      }
      media.classList.remove('is-film-playing');
      setControlState(hasStarted ? 'play' : 'start');
      toggle.hidden = false;
    }
  }

  function handoffControlFocus() {
    if (document.activeElement !== toggle) return;
    media.focus({ preventScroll: true });
  }

  function disconnectObserver() {
    observer?.disconnect();
    observer = null;
  }

  function armFilm() {
    attachOpeningPoster();
    if (!openingPosterReady) return;
    media.classList.add('is-film-enabled');
    if (hasEnded || hasFailed) return;

    if (hasStarted) {
      media.classList.add('is-film-playing');
      setControlState(video.paused ? 'play' : 'pause');
      toggle.hidden = false;
      return;
    }

    if (!('IntersectionObserver' in window)) {
      playFilm();
      return;
    }

    disconnectObserver();
    observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        disconnectObserver();
        playFilm();
      },
      { threshold: 0.3 },
    );
    observer.observe(media);
  }

  function settleToStatic() {
    disconnectObserver();
    video.pause();
    handoffControlFocus();
    media.classList.remove(
      'is-film-enabled',
      'is-film-playing',
      'is-film-complete',
      'is-film-fallback',
      'is-film-text-fallback',
    );
    toggle.hidden = true;
  }

  function settleToTextFallback() {
    disconnectObserver();
    video.pause();
    handoffControlFocus();
    media.classList.remove('is-film-playing', 'is-film-complete', 'is-film-fallback');
    media.classList.add('is-film-enabled', 'is-film-text-fallback');
    toggle.hidden = true;
  }

  function syncFilmMode() {
    if (!canAnimate()) {
      settleToStatic();
      return;
    }
    armFilm();
  }

  video.addEventListener('playing', () => {
    if (!canAnimate()) {
      settleToStatic();
      return;
    }
    attachFinalPoster();
    hasStarted = true;
    media.classList.add('is-film-enabled', 'is-film-playing');
    setControlState('pause');
    toggle.hidden = false;
  });

  video.addEventListener('pause', () => {
    if (hasEnded || !media.classList.contains('is-film-enabled')) return;
    setControlState('play');
  });

  video.addEventListener('ended', () => {
    attachFinalPoster();
    hasEnded = true;
    media.classList.remove('is-film-playing');
    media.classList.add('is-film-complete');
    toggle.setAttribute('aria-label', 'Close animation complete');
    handoffControlFocus();
    toggle.hidden = true;
  });

  video.addEventListener('error', () => {
    if (!canAnimate()) {
      hasFailed = true;
      settleToStatic();
      return;
    }
    attachFinalPoster();
    hasFailed = true;
    disconnectObserver();
    media.classList.remove('is-film-playing', 'is-film-text-fallback');
    media.classList.add('is-film-enabled', 'is-film-fallback');
    handoffControlFocus();
    toggle.hidden = true;
  });

  toggle.addEventListener('click', () => {
    if (hasEnded) return;
    if (video.paused) {
      playFilm();
      return;
    }
    video.pause();
  });

  const listenForPreferenceChange = (query) => {
    if ('addEventListener' in query) query.addEventListener('change', syncFilmMode);
    else query.addListener(syncFilmMode);
  };
  listenForPreferenceChange(desktopQuery);
  listenForPreferenceChange(motionQuery);
  syncFilmMode();
}

setupCloseFilm();
setupStableTextLayout().catch((error) => {
  console.warn('Stable text layout enhancement unavailable:', error);
});
