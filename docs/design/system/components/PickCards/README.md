# PickCards
A set of photo cards attached under a reply, for candidates to choose from (products, lodging, restaurants, shows). It looks like photos attached to the message.

- **Right under** Dool2's reply bubble, swiped sideways (168px per card, snapping). 2 to 8 cards, in order of recommendation.
- Card: square photo (an empty `surface-sunken` slot if there is none) → name in 2 lines → price (bold) → one info line (`ink-muted`, rating, arrival, etc.).
- **Every card is the same size**: the photo is cropped to fill its slot (the slot never stretches because of photo size or ratio), the name reserves two lines even if it is one, and the price and info lines keep their space even if empty. Buttons are always at the bottom.
- Sets of movie posters, book covers and show posters are **portrait 3:4** (`.pick-cards.portrait`, `shape: portrait` of show_cards).
- Only one badge, an ink pill at the top left of the photo (lowest price, recommended). No decoration with color.
- Two buttons: `보기` (View; outline, opens that page) · `이걸로` (This one; ink, sends the chosen one to Dool2). Payment is not made here; after the choice, Dool2 asks with an approval card.
- The screen does not connect directly to outside servers for photos; the PC daemon fetches and passes them on. The slot stays empty until they arrive, then they fade in smoothly.
- A reply with cards does not repeat the same list as text or a table (only the reason for the choice and the differences, in 2 to 4 sentences).
