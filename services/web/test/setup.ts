import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

// The sidebar starts collapsed for a person who has not chosen; most tests read the full list, so they start expanded
// (test/nav-rail.test.tsx clears the choice to see the default).
beforeEach(() => {
  try {
    window.localStorage.setItem('aisdlc.nav.collapsed', '0');
  } catch {
    /* none */
  }
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});
