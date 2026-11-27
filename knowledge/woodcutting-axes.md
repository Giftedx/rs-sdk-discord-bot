# Woodcutting axes: which axe can I use

Checked against the server code (vendor/rs-sdk at 3506b20cc). Where this page disagrees with
wiki/skills/woodcutting.md or a wiki axe page, this page is correct.

## Chopping with an axe

- To chop a tree, an axe must be in the hand or in the inventory. The axe does not have to be wielded.
- No axe needs a Woodcutting level. The wiki table (Steel 6, Mithril 21, Adamant 31, Rune 41) is wrong for this server. Source: `server/content/scripts/skill_woodcutting/scripts/woodcut.rs2`, the `woodcutting_axe_checker` proc.
- The tree needs a Woodcutting level (for example Willow 30, Yew 60). The axe does not change that.
- If more than one axe is in the hand or the inventory, the game uses the best one: rune, then adamant, mithril, black, steel, iron, bronze.
- So the best axe to use for chopping is a rune axe, at any Woodcutting level and any Attack level.

## Wielding an axe

To wield an axe (hold it as a weapon) needs an Attack level. Source: `server/content/scripts/levelrequire/scripts/tier*.rs2`.

| Axe | Attack level to wield |
|-----|----------------------|
| Bronze | 1 |
| Iron | 1 |
| Steel | 5 |
| Black | 10 |
| Mithril | 20 |
| Adamant | 30 |
| Rune | 40 |

The "Level Requirement 41" on wiki/items/rune-axe.md is not the wield check. The wield check is Attack 40.

## Axes that are not in this game

There is no dragon axe on this server. The server item list has no `dragon_axe`. The dragon battleaxe is a weapon, not a woodcutting axe.
