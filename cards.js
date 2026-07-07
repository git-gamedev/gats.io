// cards.js
// Spawns temporary notification cards that rise up from off screen, sit for
// a bit, then slide back off and get removed. Multiple cards stack bottom-up
// without overlapping, and reflow to close any gap when one is removed.

// CARD_GAP — space, in pixels, left between stacked cards.
const CARD_GAP = 8;

// CARD_BOTTOM_MARGIN — resting distance, in pixels, from the bottom edge of
// the screen to the lowest card in the stack.
const CARD_BOTTOM_MARGIN = 20;

// RISE_MS — time, in milliseconds, a card takes to rise into its resting
// place in the stack.
const RISE_MS = 500;

// HOLD_MS — time, in milliseconds, a card spends fully visible before it
// starts sliding back off screen.
const HOLD_MS = 2000;

// EXIT_MS — time, in milliseconds, a card takes to slide back off screen;
// must match the CSS transition duration on .notif-card.
const EXIT_MS = 500;

// cardStack — the container element that holds all currently active card
// elements.
const cardStack = document.getElementById('card-stack');

// activeCards — ordered bottom -> top list of currently active cards, each
// entry shaped as { el, height }, used to compute stacking offsets.
const activeCards = [];

// layoutCards — recalculates and applies the resting "bottom" CSS position
// of every active card so they stack with no gaps and no overlap, from the
// bottom of the screen up. Called whenever a card is added or removed.
function layoutCards() {
  let offset = CARD_BOTTOM_MARGIN;
  for (const card of activeCards) {
    card.el.style.bottom = offset + 'px';
    offset += card.height + CARD_GAP;
  }
}

// spawnCard — creates a new notification card element with the given
// message, animates it rising off screen into its stacked position, holds
// it visible for HOLD_MS, then slides it back off screen and removes it
// from the DOM and from activeCards, reflowing the remaining stack
// afterward.
function spawnCard(message) {
  const el = document.createElement('div');
  el.className = 'notif-card';
  el.textContent = message;
  el.style.bottom = '0px'; // temporary, corrected below once we know its height
  cardStack.appendChild(el);

  const height = el.getBoundingClientRect().height;
  const offScreenBottom = -(height + CARD_BOTTOM_MARGIN + CARD_GAP);

  // start fully off screen with no transition, so it doesn't animate from 0
  el.style.transition = 'none';
  el.style.bottom = offScreenBottom + 'px';

  const card = { el, height };
  activeCards.push(card);

  // force layout so the off-screen position is committed before we animate
  void el.offsetHeight;
  el.style.transition = '';

  // next frame: rise into its slot in the stack
  requestAnimationFrame(() => {
    layoutCards();
  });

  setTimeout(() => {
    // hold time is over, slide back off screen
    el.style.bottom = offScreenBottom + 'px';

    setTimeout(() => {
      cardStack.removeChild(el);
      const index = activeCards.indexOf(card);
      if (index !== -1) activeCards.splice(index, 1);
      layoutCards(); // remaining cards slide down to close the gap
    }, EXIT_MS);
  }, RISE_MS + HOLD_MS);
}