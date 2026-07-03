// cards.js
// spawns temporary notification cards that rise up from off screen, sit for a
// bit, then slide back off and get removed. multiple cards stack bottom-up
// without overlapping, and reflow to close any gap when one is removed.

const CARD_GAP = 8;          // space between stacked cards
const CARD_BOTTOM_MARGIN = 20; // resting distance from the bottom edge
const RISE_MS = 500;         // time to rise into place
const HOLD_MS = 2000;        // time spent fully visible
const EXIT_MS = 500;         // time to slide back off screen (matches CSS transition)

const cardStack = document.getElementById('card-stack');
const activeCards = []; // ordered bottom -> top, each entry: { el, height }

// recalculate and apply the resting "bottom" position of every active card
// so they stack with no gaps and no overlap, from the bottom up.
function layoutCards() {
  let offset = CARD_BOTTOM_MARGIN;
  for (const card of activeCards) {
    card.el.style.bottom = offset + 'px';
    offset += card.height + CARD_GAP;
  }
}

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