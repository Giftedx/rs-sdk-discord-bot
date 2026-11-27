# Armour and weapon levels: what you need to wear or wield

Checked against the server code (vendor/rs-sdk at 3506b20cc). Where this page disagrees with
wiki/skills/defence.md, wiki/skills/ranged.md or wiki/skills/attack.md, this page is correct.
The wield checks are in `server/content/scripts/levelrequire/scripts/tier*.rs2`. Every check
uses the base level, so a potion boost does not help. An item with no check needs no level.

A wiki item page found by search_knowledge starts with a "Server code:" line. That line is the
real wield check for that item.

## Metal armour (Defence level)

The wiki/skills/defence.md table puts most metals one tier too high. The real Defence levels:

| Metal | Defence to wear |
|-------|-----------------|
| Bronze | 1 |
| Iron | 1 |
| Steel | 5 |
| Black | 10 |
| Mithril | 20 |
| Adamant | 30 |
| Rune | 40 |
| Dragon | 60 |

- The rune platebody (and its trimmed, gold and god versions) also needs the Dragon Slayer quest.
- Dragon med helm, chainbody and platelegs need Defence 60 and no quest. The dragon sq shield needs Defence 60 and Legends' Quest.
- There is no White armour, no Mystic robes and no Zamorak robes on this server.

## Metal weapons (Attack level)

Bronze 1, iron 1, steel 5, black 10, mithril 20, adamant 30, rune 40, dragon 60. Axes and pickaxes are wielded with the same Attack levels.

- Halberds also need Strength: black Attack 10 and Strength 5, mithril 20 and 10, adamant 30 and 15, rune 40 and 20.
- Dragon dagger and dragon longsword need the Lost City quest. Dragon mace and dragon battleaxe need Heroes' Quest. The dragon spear needs no quest. The dragon halberd needs Attack 60, Strength 30 and Regicide.
- Battlestaves need Magic 30 and Attack 30. Mystic staves need Magic 40 and Attack 40. Iban's staff needs Magic 50 and Attack 50.
- The granite shield needs Defence 50 and Strength 50.

## Ranged armour (Ranged and Defence levels)

| Item | Needs |
|------|-------|
| Leather armour (body, chaps, cowl and so on) | Ranged 1, no Defence |
| Hard leather body | Defence 10, no Ranged |
| Coif | Ranged 20 |
| Studded body | Ranged 20 and Defence 20 |
| Studded chaps | Ranged 20 |
| Green dragonhide body | Ranged 40, Defence 40 and the Dragon Slayer quest |
| Blue dragonhide body | Ranged 50 and Defence 40 |
| Red dragonhide body | Ranged 60 and Defence 40 |
| Black dragonhide body | Ranged 70 and Defence 40 |
| Dragonhide chaps and vambraces | Ranged only: green 40, blue 50, red 60, black 70 |
| Robin Hood hat, ranger boots | Ranged 40 |

## Other armour

- Splitbark armour needs Magic 40 and Defence 40.
- Viking helmet and shield need Defence 30 and The Fremennik Trials. The Fremennik helms (archer, berserker, farseer, warrior) need Defence 45 and The Fremennik Trials.
- The anti-dragonfire shield has no level check. Its name in the game is "Dragonfire shield".

## Ranged facts the wiki gets wrong

- The Ranging Guild is at Hemenster (doorman at 2658, 3439), not in Seers' Village. Entry needs Ranged 40. The current level counts, so a boost works.
- The guild targets are for the competition only.
- Ranged XP: 4 per damage on accurate and rapid, 2 Ranged and 2 Defence per damage on longrange.
- There is no combat triangle in the code. Only equipment bonuses decide accuracy and defence.
