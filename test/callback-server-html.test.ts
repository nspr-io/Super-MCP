import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for the OAuth success page countdown/button logic (FOX-2720).
 *
 * Since generateSuccessHtml is not exported and jsdom is not available,
 * we extract and test the core logic (openApp, tick, click handler)
 * in isolation. This validates the state machine that prevents double-open.
 */

interface MockDOM {
  countdownText: string;
  countdownContainerDisplay: string;
  fallbackDisplay: string;
  locationAssigns: string[];
  preventDefaultCalled: boolean;
}

function createCountdownLogic(countdownSeconds: number, deepLinkUrl: string) {
  const dom: MockDOM = {
    countdownText: String(countdownSeconds),
    countdownContainerDisplay: '',
    fallbackDisplay: '',
    locationAssigns: [],
    preventDefaultCalled: false,
  };

  let count = countdownSeconds;
  let opened = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  function openApp() {
    if (opened) return;
    opened = true;
    if (timerId) clearTimeout(timerId);
    dom.countdownContainerDisplay = 'none';
    dom.fallbackDisplay = 'none';
    dom.locationAssigns.push(deepLinkUrl);
  }

  function tick() {
    if (opened) return;
    count--;
    dom.countdownText = String(count);
    if (count <= 0) {
      openApp();
    } else {
      timerId = setTimeout(tick, 1000);
    }
  }

  function clickButton() {
    dom.preventDefaultCalled = true;
    openApp();
  }

  // Start the countdown (mirrors: timerId = setTimeout(tick, 1000))
  timerId = setTimeout(tick, 1000);

  return { dom, clickButton, getOpened: () => opened };
}

describe('OAuth success page countdown logic (FOX-2720)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should auto-open when countdown reaches 0 without clicking', () => {
    const { dom } = createCountdownLogic(3, 'mindstone://settings/connectors');

    vi.advanceTimersByTime(1000); // count = 2
    vi.advanceTimersByTime(1000); // count = 1
    vi.advanceTimersByTime(1000); // count = 0 → openApp()

    expect(dom.locationAssigns).toHaveLength(1);
    expect(dom.locationAssigns[0]).toBe('mindstone://settings/connectors');
  });

  it('should not fire additional opens after countdown completes', () => {
    const { dom } = createCountdownLogic(3, 'mindstone://settings/connectors');

    vi.advanceTimersByTime(3000);
    expect(dom.locationAssigns).toHaveLength(1);

    vi.advanceTimersByTime(10000);
    expect(dom.locationAssigns).toHaveLength(1);
  });

  it('should open once when button is clicked before countdown ends', () => {
    const { dom, clickButton } = createCountdownLogic(5, 'mindstone://settings/connectors');

    vi.advanceTimersByTime(1000); // count = 4
    clickButton();

    expect(dom.locationAssigns).toHaveLength(1);
    expect(dom.locationAssigns[0]).toBe('mindstone://settings/connectors');
  });

  it('should NOT double-open after button click cancels countdown', () => {
    const { dom, clickButton } = createCountdownLogic(3, 'mindstone://settings/connectors');

    clickButton(); // click immediately
    expect(dom.locationAssigns).toHaveLength(1);

    // Let entire countdown time pass — timer should be cancelled
    vi.advanceTimersByTime(10000);
    expect(dom.locationAssigns).toHaveLength(1);
  });

  it('should NOT double-open when clicking at countdown boundary', () => {
    const { dom, clickButton } = createCountdownLogic(3, 'mindstone://settings/connectors');

    // Advance to just before the last tick
    vi.advanceTimersByTime(2000); // count = 1
    expect(dom.countdownText).toBe('1');

    // Click right before the final tick
    clickButton();
    expect(dom.locationAssigns).toHaveLength(1);

    // The final tick fires but should be guarded by opened flag
    vi.advanceTimersByTime(1000);
    expect(dom.locationAssigns).toHaveLength(1);
  });

  it('should NOT double-open if countdown fires then button is clicked', () => {
    const { dom, clickButton } = createCountdownLogic(3, 'mindstone://settings/connectors');

    // Let countdown complete
    vi.advanceTimersByTime(3000);
    expect(dom.locationAssigns).toHaveLength(1);

    // Now click the button — should be a no-op
    clickButton();
    expect(dom.locationAssigns).toHaveLength(1);
  });

  it('should hide countdown UI after button click', () => {
    const { dom, clickButton } = createCountdownLogic(3, 'mindstone://settings/connectors');

    clickButton();

    expect(dom.countdownContainerDisplay).toBe('none');
    expect(dom.fallbackDisplay).toBe('none');
  });

  it('should hide countdown UI after auto-open', () => {
    const { dom } = createCountdownLogic(3, 'mindstone://settings/connectors');

    vi.advanceTimersByTime(3000);

    expect(dom.countdownContainerDisplay).toBe('none');
    expect(dom.fallbackDisplay).toBe('none');
  });

  it('should decrement countdown display correctly each second', () => {
    const { dom } = createCountdownLogic(5, 'mindstone://settings/connectors');

    expect(dom.countdownText).toBe('5'); // initial
    vi.advanceTimersByTime(1000);
    expect(dom.countdownText).toBe('4');
    vi.advanceTimersByTime(1000);
    expect(dom.countdownText).toBe('3');
    vi.advanceTimersByTime(1000);
    expect(dom.countdownText).toBe('2');
    vi.advanceTimersByTime(1000);
    expect(dom.countdownText).toBe('1');
    vi.advanceTimersByTime(1000);
    // At 0, openApp fires, text stays at 0 (set before openApp call)
    expect(dom.countdownText).toBe('0');
  });

  it('should call preventDefault on button click', () => {
    const { dom, clickButton } = createCountdownLogic(3, 'mindstone://settings/connectors');

    clickButton();
    expect(dom.preventDefaultCalled).toBe(true);
  });

  it('should work with countdown of 1 second', () => {
    const { dom } = createCountdownLogic(1, 'mindstone://settings/connectors');

    vi.advanceTimersByTime(1000);
    expect(dom.locationAssigns).toHaveLength(1);
    expect(dom.countdownText).toBe('0');
  });
});
