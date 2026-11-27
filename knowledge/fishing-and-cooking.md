# Fishing and cooking

Checked against the server code (vendor/rs-sdk at 3506b20cc). Where this page disagrees with
wiki/skills/fishing.md or wiki/skills/cooking.md, this page is correct.

## Fishing: what the wiki gets wrong

- The tool must be in the inventory. Bait is used only when you catch a fish.
- Catherby does not have all spot types. It has Net/Bait, Cage/Harpoon and Net/Harpoon. It has no Lure/Bait (fly fishing) spot.
- The Fishing Guild has only Cage/Harpoon and Net/Harpoon spots. Entry needs Fishing 68.
- Sea turtle (level 79) gives 105 XP, not 57. Manta ray (level 81) gives 115 XP, not 69. Both come only from the Fishing Trawler, which needs Fishing 15.
- Fish share spots: anchovies come from the shrimp net at level 15, herring from the sardine bait at 10, salmon from fly fishing at 30, swordfish from the tuna harpoon at 50.

## Cooking: what the wiki gets wrong

| Food | Wiki says | Code says |
|------|-----------|-----------|
| Anchovies | level 15 | level 1 |
| Cod | 70 XP | 75 XP |
| Meat pie | 80 XP | 110 XP |
| Apple pie | 100 XP | 130 XP |
| Curry | 221 XP | 280 XP |
| Chompy bird | 100 XP | 14 XP, only on the Big Chompy Bird Hunting spit roast (Cooking 30) |
| Pineapple pizza | 110 XP | 45 XP for adding the pineapple |
| Ugthanki kebab | level 53 | no level to make it; the pitta bread needs Cooking 58 |
| Wine | heals 15 | heals 11 and lowers Attack by 2 |
| Sea turtle | heals 20 | heals 21 |

- Curry: use spice on an uncooked stew (water, potato and meat). It is members-only.
- A range does not burn less food than a fire for most foods. Only some foods have their own range odds. Cooked camel meat burns more on a range.
- Only cooked meat can be burnt on purpose. Other cooked food gives "You can't cook that."
- Bread, cakes, pies, pizza and pitta bread can only be cooked on a range.
- The Cooking Guild is west of Varrock (door at 3143, 3444), not northwest. Entry needs Cooking 32 and a worn chef's hat.
