# Fit-Fantasy Quest: Trailmap

Design doc for the Trailmap gamification layer — a board-game-style journey map (one per Fitness Journey rank) that turns real activity into movement across the map, with camera-tracked exercise "boss fights" at each stop. This sits alongside the already-shipped Character/Garden/Boss popover (Menu tab / header icon), and is the next major evolution of that system.

Status: **design only, nothing in this doc is built yet.** Written to freeze the decisions made across a long design conversation before starting an implementation plan.

---

## 1. Concept

Real steps and consistent logging move your character along a themed trail, station by station, toward a final boss at a temple/citadel. Each station along the way is a short "mini-boss" skirmish; scattered ruin structures beside the path are optional side quests. One full map per Fitness Journey rank (Novice → Warrior → Spartan → Demi-God), each visually escalating with the rank.

The emotional goal (from the existing Stitch design brief for this feature): *make a walk or a workout feel like a dungeon raid, not a checklist.*

## 2. Assets already in hand

Generated via Stitch, now processed and living in the project:

| Rank | Map name | File |
|---|---|---|
| Novice | Serpents Hive (jungle ruins) | `icons/maps/map-novice-serpents-hive.webp` |
| Warrior | Frozen Ascent (ice mountains) | `icons/maps/map-warrior-frozen-ascent.webp` |
| Spartan | Burning Plains (volcanic) | `icons/maps/map-spartan-burning-plains.webp` |
| Demi-God | Celestial Realm (floating islands) | `icons/maps/map-demigod-celestial.webp` |

(Converted from the original 2MB+ PNGs at `E:\Icons\Adventure Maps\stitch_fitquest_adventure_map\` to ~230-300KB WebP each, 900px wide — full source PNGs still there if a higher-res source is ever needed.)

Also present, not yet used: a Stitch-generated `DESIGN.md` style system for a project named **"Fit-Fantasy Quest"** — Sora headline / Inter body / JetBrains Mono stat-number typography, pill-shaped XP bars, chunky "pressed" buttons, rounded card shapes. Useful for shape/type/component language.

**Resolved: not the dark navy scheme from that doc.** Trailmap gets its own **playful, friendly, bright-lit** visual skin — matches the mood already in the map art itself (Serpents Hive reads as a sunlit jungle, not a moody dungeon). Direction: warm daylight greens/golds for Novice, carrying similarly bright (not dark/gritty) tones into the other three maps when we get there — icy-but-cheerful blues for Warrior, warm sunset oranges rather than grim char-black for Spartan, airy pastel sky tones for Demi-God. Keep the Stitch doc's shapes/typography/component ideas, swap its dark palette for a light one. Still its own self-contained "world" distinct from the main app's cyan SYS_TERMINAL theme — just a friendly one, not a dark one.

Character portraits (already shipped, from the header popover work) live at `icons/character/char-{novice,warrior,spartan,demigod}.png` plus attack-animation strips for Spartan/Demi-God — these are the same character who walks the trail.

**Main-boss fight assets in hand so far** (station mini-bosses deferred to later — main bosses first):

| Rank | Boss | Room | Idle sprite | Attack sprite |
|---|---|---|---|---|
| Novice | many-headed moss/mushroom hydra-serpent | `icons/boss/novice-boss-room.webp` | `icons/boss/novice-boss-sprite.webp` | `icons/boss/novice-boss-sprite-attack.webp` |
| Warrior | six-armed ice queen (twin blades ×3 pairs) | `icons/boss/warrior-boss-room.webp` | `icons/boss/warrior-boss-sprite.webp` | `icons/boss/warrior-boss-sprite-attack.webp` |
| Spartan | three-headed lava cerberus/hellhound | `icons/boss/spartan-boss-room.webp` | `icons/boss/spartan-boss-sprite.webp` | `icons/boss/spartan-boss-sprite-attack.webp` |
| Demi-God | Solar Seraphim (winged knight, flaming sword) | `icons/boss/demigod-boss-room.webp` | `icons/boss/demigod-boss-sprite.webp` | `icons/boss/demigod-boss-sprite-attack.webp` |

**All 4 main bosses now have room + idle + attack assets in hand.**

Both bosses follow the same asset shape: a room background, an idle/neutral pose, and a second **single-frame** attack pose (not a 25-frame strip like the character animations) — so each is a two-pose idle↔attack swap, not a played animation. My read, same for both: the attack pose is the boss's own attack — shown during **Dodge Phase** (see §5) to sell "the boss is attacking, dodge!", swapping back to idle for Attack Phase (boss staggered, player dealing damage). Flagging this interpretation for confirmation rather than assuming it silently — could also be intended as an on-hit reaction instead.

(Same source folder structure as the maps — `E:\Icons\Boss\Boss Room\` and `E:\Icons\Boss\Serpents Hive Boss\` — each has its own `screen.png` plus a duplicate of the same Stitch style-token `DESIGN.md`, no new info there beyond what's already noted above.)

## 3. Progress economy (v1, simplified — "for the meantime")

Dropping the AP-currency-pool idea for now in favor of something simpler to build first and easy to understand as a player: a **daily step goal that escalates as you advance**.

- **Qualifying day** = a day where logged steps meet or beat the **current threshold**. Reuses the same once-per-finalized-day daily-catchup pattern already used elsewhere (`processDailyModeCheck`/`processDailyGameCheck`) — checked once per real day, not spammable.
- **Threshold starts at 4,000 steps/day**, and **increases by 1,000 for every station already cleared** — so Station 1 needs 4,000/day, Station 2 needs 5,000/day, ... Station 9 needs 12,000/day. Naturally ramps difficulty across the map without any extra tuning.
- **Each station costs 3 qualifying days** (carrying over the earlier "3 days completion" idea, now defined purely by the step threshold rather than a blended AP formula).
- **Falling short of the threshold on a given day just doesn't bank a qualifying day** — no penalty, no demotion, matching the no-punishment tone already used for the boss fights. Friendly, not stressful.
- Running/cardio-vs-steps weighting, the logged-data-completion AP source, and the Sunday Weekly Review bonus from earlier discussion are all **deferred to a later pass** — not needed to get a first playable loop working, and can layer on top of this once it's live.

## 4. Map structure (per rank)

Each map: **Start plaza → 9 stations → Main Boss (temple/citadel)**, with **5 side quests** branching off ruin structures visible beside the main path.

- **Station (×9)**: a short mini-boss skirmish — one quick Clash cycle (see §5), themed per map (a small jungle/ice/lava/sky creature). Clearing it grants XP/AP and sometimes a garden-style item.
- **Side quest (×5)**: optional spurs off specific stations, using the same mechanics but with rarer one-off rewards (cosmetic unlocks, bonus items). Skippable, not required to reach the boss.
- **Main Boss**: the full multi-cycle Clash fight (§5), themed per rank — jungle guardian serpent (Novice), the ice yeti already drawn into Frozen Ascent's art (Warrior), a lava sentinel (Spartan), a temple guardian (Demi-God). Difficulty (cycle count) scales with rank.

## 5. The fight mechanic: "Clash Phases"

Reuses both camera mechanics below rather than inventing new tech per encounter. Same camera framing throughout — the phone doesn't get repositioned mid-fight, only what the game asks you to do changes.

- **Dodge Phase** (boss attacks): obstacles scroll toward you; duck/lean/move to avoid them, tracked via head/face position. Getting hit drains your Stamina bar.
- **Attack Phase** (boss staggered): a short window to do real squats/push-ups, camera-counted; each valid rep damages the boss's HP bar.
- Cycles repeat until the boss's HP hits 0 (win) or your Stamina runs out (lose — no penalty, just retry; you don't lose the AP already spent reaching the station).

**Station mini-bosses**: 1 cycle (one Dodge + one Attack), ~30-45 seconds total — quick.
**Main Map Boss**: 3-4 cycles, scaling with rank (Novice shortest/easiest, Demi-God longest/hardest).

## 6. Camera tech

Both pieces run fully **client-side, on-device** — no video ever leaves the phone (worth surfacing to users as a privacy point). Reuses `getUserMedia` plumbing already in the app (progress-photo capture).

- **Rep counting (squats, push-ups)**: an in-browser pose-estimation model (TensorFlow.js MoveNet, or MediaPipe Pose Landmarker) tracks body joints. A joint-angle state machine (e.g. hip-knee-ankle angle for squats, shoulder-elbow-wrist for push-ups) counts a rep on each full down→up cycle, with smoothing/debounce against jitter.
  - Squats: reliable, front-facing camera is fine.
  - Push-ups: reliable, but needs a side-ish angle — phone propped on the floor.
  - Pull-ups: **not planned for v1** — bar framing and hand/face occlusion at the top of the rep make this meaningfully less reliable than the other two; revisit later, possibly with manual rep entry as a fallback.
- **Dodge tracking**: a lighter face detector (e.g. TensorFlow.js BlazeFace) gives head X/Y per frame. A ~2-second calibration ("move to the top... now the bottom") maps each person's actual range of motion to the game's playable space before a fight starts.

## 7. Progression integration — resolved

- **Timing**: the reset to Novice for all users, and gating real feature-unlocks behind Map Boss defeats, only takes effect **when this feature actually ships** — current users keep their earned rank/access until then. No one gets locked out of Training Log/GPS/AI nutrition/etc. with no way to re-earn it.
- **Map Boss works *alongside* the existing streak system**, not instead of it — either path promotes you. An off day (bad lighting, no space to move, camera trouble) never fully blocks progress; the old 7-day-streak path is always still there as a backup route to the same promotion.
- **The existing simple Boss Battle isn't retired** — it coexists with Map Bosses under one unified **Boss Menu** (below), each with a clearly distinct identity so they don't read as the same feature twice.

### The Boss Menu

Replaces the current small "Boss Battle" card in the Character/Garden popover with a dedicated screen listing every boss-type encounter available right now, in one place:

1. **Weekly Trial** — the existing task-based encounter ("log 4 workouts this week" etc.), auto-starts on a real rank-up, non-camera. Renamed from "Boss Battle" to "Weekly Trial" specifically to read as a different *kind* of thing from a Trail Boss, not a rival version of the same thing.
2. **Trail Bosses** — the current map's next station creature (ready to fight now), with the stations further ahead shown as silhouettes/fog-of-war (only revealed as you get close — keeps some mystery pulling you forward), and the Temple main boss shown as locked with "X stations remaining" until Station 9 clears.
3. **Bestiary / Trophy Log** — a running list of every boss already defeated (both Weekly Trials and Trail Bosses), each with a small icon and the date beaten. Cheap to build (just reads existing history), gives a satisfying sense of collection/progress to look back on, and reinforces the "addictive" pull from the original brief without any punishing mechanic behind it.

## 8. Data model sketch (additive, alongside existing `p.gamification`)

```js
p.gamification.trailmap = {
  rank: 'beginner',            // which map — mirrors fitnessMode
  stationIndex: 0,             // 0 = start plaza, 1-9 = stations, 10 = main boss
  qualifyingDays: 0,           // toward the 3 needed for the next station
  lastProcessedDate: null,     // same daily-catchup pattern as the rest of gamification
  clearedStations: [],         // station indices whose mini-boss is defeated
  sideQuestsCleared: [],       // side quest ids completed
  mainBossDefeated: false,
}
```
`stepThreshold` for a given day isn't stored — it's derived as `4000 + 1000 * stationIndex` at check time, so it's always consistent with progress. Rides along in the existing profile object the same way Character/Garden/Boss data already does — local backup/restore and web-sync for free, no new migration.

## 9. How to play: Serpents Hive (Novice map)

Concrete walkthrough of the first map, to sanity-check the whole loop before writing any code.

1. **Trailhead.** Character stands at the jungle plaza. HUD shows today's steps vs. today's goal (starts at 4,000) and "Qualifying days: 0/3 to Station 1."
2. **Daily loop.** Each real day, if logged steps hit that day's threshold, it banks as a qualifying day (checked once, on next app open, same pattern as the rest of the app's daily catch-up — not something you can spam by refreshing). No threshold met = no penalty, just no progress that day.
3. **3rd qualifying day banked → Station 1 unlocks.** A short "You've reached Station 1!" moment, then the station's mini-boss Clash opens (one Dodge phase, one Attack phase, camera-based, ~30-45 sec).
   - Win → character visibly walks forward to the next disc on the map, small XP/item reward, tomorrow's threshold is now 5,000 (4,000 + 1,000 × 1 station cleared).
   - Lose → no penalty, retry any time — you already banked the 3 qualifying days, so a fight loss doesn't cost you steps progress, only the fight itself needs redoing.
4. **Repeat for Stations 2-9**, threshold climbing 1,000/station (Station 9 needs 12,000 steps/day), each a slightly tougher single-cycle Clash.
5. **Side quests** appear as branch icons next to a handful of stations (using the ruin structures already drawn beside the path in the art) — fully optional, same short Clash format, rarer reward, never blocks the main path.
6. **After Station 9 → the Temple.** The full multi-cycle Clash against the jungle guardian serpent (2 cycles for Novice, per the earlier difficulty scaling). Win = Serpents Hive complete.
7. **Completion.** Pending §7's still-open question: this either promotes to Warrior outright, or contributes toward promotion alongside the existing streak system. Either way, it unlocks the Frozen Ascent map to start the same loop again at Warrior's threshold reset.

## 10. Build phasing recommendation

This is a large feature (map UI + two distinct camera-ML mechanics + ~9 mini-bosses + a multi-phase main boss + side quests) × 4 maps. Recommend building **one map end-to-end first** — Novice/Serpents Hive, since it's the entry-point everyone sees — including both camera mechanics fully working, before replicating the map/station/boss content to the other three ranks. The other three maps' art is already done, so replication should be mostly content/config once the engine works once.

## 11. Next step

Once the two open questions in §7 are answered, this doc is ready to drive a proper implementation plan (EnterPlanMode) — touches enough files/systems that it shouldn't start as ad-hoc edits.
