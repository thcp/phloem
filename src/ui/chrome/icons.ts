// SPDX-License-Identifier: AGPL-3.0-only
/** Small stroke icons (24x24, currentColor). Hand-drawn paths, no icon font. */
const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICON = {
  play: svg('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>'),
  pause: svg('<rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>'),
  share: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  // movie camera: body + lens wedge
  names: svg('<path d="M4 19 10 5l6 14M6.2 14.5h7.6"/>'),
  people: svg('<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.5-3.2 2.8-5 5.5-5s5 1.8 5.5 5"/><path d="M16 5.6a3 3 0 0 1 0 5.8M17.5 14.3c1.7.5 2.8 2 3.1 4.7"/>'),
  expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  collapse: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  open: svg('<path d="M12 5v14M5 12h14"/>'),
  // visualization styles: a branching vein, and a right-angle trace with pads
  organic: svg('<path d="M4.5 19c3-.5 5-3 6.5-6s3-5 8.5-7.5"/><path d="M11 13c2.5.2 4.5 1.4 7 4.5"/><path d="M8 16.5c-1.8-2.2-2.6-4.6-2.4-7.5"/><circle cx="4.5" cy="19" r="1.4" fill="currentColor" stroke="none"/><circle cx="19.5" cy="5.5" r="1.4" fill="currentColor" stroke="none"/>'),
  circuit: svg('<path d="M4.5 18H10l3-3.5V8h6.5"/><path d="M10 18v1.5M13 8V4.5"/><circle cx="4.5" cy="18" r="1.6" fill="currentColor" stroke="none"/><circle cx="19.5" cy="8" r="1.6" fill="currentColor" stroke="none"/><circle cx="13" cy="4.5" r="1.2" fill="currentColor" stroke="none"/>'),
};

export const MARK = `<svg viewBox="0 0 28 28" width="22" height="22" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"><path d="M5 23c4-1 6-5 8-8s5-4 10-9"/><path d="M13 15c3 0 6 1 10 5"/><path d="M9 20c-2-3-3-6-3-10"/></g><g fill="currentColor"><circle cx="5" cy="23" r="2.6"/><circle cx="23" cy="6" r="1.9"/><circle cx="23" cy="20" r="1.9"/><circle cx="6" cy="10" r="1.9"/></g></svg>`;
