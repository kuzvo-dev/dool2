# Button
Buttons end in a verb and are ink-filled, never brand orange and never pills.

- **primary** (ink fill): the one action per view. In an approval card it carries the amount: `₩59,800 승인하기`.
- **secondary** (surface + line-strong border): the alternative, e.g. `내가 할게요` (take over manually).
- **ghost**: toolbar and inline actions.
- **danger**: `거절`, `멈추기`. Outline only; red is text, never a fill.
- Sizes: `--lg` 52px (mobile primary, approval), default 44px, `--sm` 34px (inline in messages).
- Radius `radius-md` 12px. Focus: 2px ink ring, 2px offset.
- Consumer provides: label (Korean verb), optional 18px line icon left of the label.
