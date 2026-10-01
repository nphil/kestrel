/** Only one recording plays at a time across the whole panel: starting one pauses whichever was playing. */
let active: HTMLMediaElement | null = null;

export function claimAudio(element: HTMLMediaElement): void {
  if (active && active !== element) active.pause();
  active = element;
}

export function releaseAudio(element: HTMLMediaElement): void {
  if (active === element) active = null;
}
