---
name: video-prompt
description: Video prompt specification — generates a time-segmented video-generation prompt from storyboard-segment content, with cuts allowed within a segment
---

# Video Prompt (storyboard segment → video_prompt)

From a single storyboard segment's description (containing the 【镜头N】 sub-shot structure and dialogue/narration) / atmosphere / duration, generate the `video_prompt` that drives AI video generation. **One storyboard segment = one 8-15-second video, with cuts allowed inside it**: consecutive segments may be different shots, joined with hard cuts; but the whole segment **never crosses scenes** and never uses flashbacks. **A cut must clear an admission test** — it has to introduce new information; if only the shot size or a slight angle changes, use camera motion instead (see "Cut admission" under Within-Segment Structure).

## Format

The **first line of the `video_prompt` is the header**: first introduce which characters and scene appear in this video, then follow with the time segments. Characters and scenes are always referenced with @ (during generation they are replaced with the corresponding reference-image markers, so the video model first locks onto "who" and "where").

```
Characters: @Xiaoming, @Xiaohong; Scene: @Coffee Shop.
0-3s: @Coffee Shop, close shot, static camera; @Xiaoming looks down at his phone, fingers repeatedly tapping the table, expression anxious.
3-6s: Cut to a wide shot of the doorway; the doorbell rings as @Xiaohong pushes the door open and walks in, bringing in a gust of cold air.
6-9s: Cut back to a medium shot; @Xiaohong walks over with a smile and sits down across from Xiaoming; Xiaoming says: "You finally made it."
```

Header rules:
- Only list the characters who actually appear in this storyboard segment and the bound scene — do not list those who do not appear
- When a prop has a notable appearance, it may be appended to the header (e.g. `; Props: @Letter`)
- The header is its own line, ending with a period, followed by the time segments

Split into 3-second segments, each segment on its own line separated by newlines, with time ranges continuous and adjoining (no overlaps, no gaps).

## Mapping to the Storyboard Description

The `description` is the sole content source of the video_prompt (visuals, actions, dialogue, and narration are all in it). Conversion rules:

- Each `【镜头N】` in the `description` maps to **1-2 consecutive 3-second segments** — same order, no omissions, no merging, no new sub-shots
- Dialogue/narration is extracted from the "CharacterName says: "..."" / "Narration: ..." entries inside the corresponding `【镜头N】` and assigned to that sub-shot's mapped segments; **do not invent new dialogue beyond the description**
- Visual actions follow the `description`; `atmosphere` is only used to supplement each segment's lighting, color tone, and mood descriptions

## Within-Segment Structure

Organize each segment's content in this order (items with no content may be omitted, but action/visuals are mandatory):

**Time range + scene @reference + shot size/camera move + character @reference + blocking·main action·expression + dialogue/narration + mood and lighting**

- **The first segment must establish the space**: scene + camera position + each character's screen side (who is on the left, who is on the right) and state, so the audience knows at a glance where we are and whom to watch
- **Blocking holds across segments**: every segment states which side of frame each character is on; if someone was on the left and no movement is written, they must not appear on the right in the next segment
- **Cuts**: start a post-cut segment with a transition word such as "cut to / cut back", and restate the shot size and subject; cut points should align with the `【镜头N】` structure in the storyboard `description`
- **Cut admission (hard rule, MiniMax H3 official §4.2)**: a cut must **introduce new information** — a new subject, space, state, viewpoint, or time. **If only the distance (shot size) or a slight angle needs to change, do not cut — use camera motion**: write `medium shot → close-up` as `The camera pushes in with small amplitude at slow speed...`, not as a cut between two segments. Cutting back and forth between shot sizes on the same subject, the same space, at the same moment is "cutting for the sake of cutting" — the model complies and the result is meaningless jumping
- **Shot size/camera move**: one camera state per segment (close shot / medium shot / wide shot / close-up; camera moves use the official vocabulary in the full-reference section below); the camera move is continuous within a single sub-shot and may change after a cut
- **Action**: one main action per segment, with concrete visible verbs (walk, turn around, look up, clench, pause)
- **All emotion must become visible description**: no abstract words like "he is very sad / the mood is tense" — write it as "he lowers his head, fingers clench the rim of the cup, breathing grows heavier"
- **Dialogue/narration**: write "CharacterName says: "line""; narration as "Narration: content"; a long line that cannot be spoken within 3 seconds is split across multiple segments; a segment without dialogue may note ambient/action sounds (e.g. "machines keep roaring")

## Reference Rules

- `@SceneName` — scene reference; the name must exactly match the location in the scene list
- `@CharacterName` — character reference; the name must exactly match the name in the character list
- `@PropName` — prop reference; the name must exactly match the name in the prop list; reference a prop when it is clearly visible in frame, used, or shown in close-up
- During generation, each `@name` is automatically replaced with the corresponding reference-image marker (e.g. `@Xiaoming` → `@Image1Xiaoming`), so names must match exactly — do not abbreviate or add extra symbols
- **Every segment must have at least one @ reference anchoring the frame**; any segment in which a character appears must @ that character; only reference scenes/characters/props already bound to this storyboard segment

## Timeline Rules

- Number of segments = storyboard-segment duration ÷ 3 seconds (rounded up); the segment time ranges must add up exactly to the total segment duration
- Content pacing: the first segment establishes → middle segments advance the action/conflict → the final segment lands on the result or emotional beat

## Prohibitions

- Cross-scene switching, flashbacks (a segment takes place in a single scene only)
- **Cutting just to change the shot size or a slight angle** (use camera motion instead); cutting back and forth between shot sizes on the same subject, the same space, at the same moment
- Referencing scene/character names outside the lists
- Abstract psychological description, literary metaphor (the model only recognizes visible imagery)
- Language that does not match the session language directive

## Saving

Call `update_storyboard` to update only this storyboard segment's `video_prompt` field; do not modify any other field, and do not re-breakdown the whole episode.


## Six-Section English Full Reference (video_prompt_full_ref)

`video_prompt` is the human-facing Chinese prompt. `video_prompt_full_ref` is the **model-facing** prompt actually sent to the ComfyUI/MiniMax bridge, and it **must be six-section English** (the template is always English, independent of session language; only the line inside `<d>` keeps its original language).

Six-section template (the agent fills in real content):
```
subject_definitions:
<Subject 1> is [角色名] from <Picture 1>, on the left of frame by the [固定陈设].
<Subject 2> is [角色名] from <Picture 2>, on the right of frame.
<Subject 3> is the [场景名] scene from <Picture 3>, an interior bedroom with a window on the right.
summary:
[Shot 1] is a [片长]-second reference-generation video of [场景]. <Subject 1> and <Subject 2> interact; <Subject 3> is a storyboard reference for [Shot 1], defining its viewpoint, subject placement, and shot order.
retention_analysis:
<Subject 1> fully_preserved
<Subject 2> fully_preserved
<Subject 3> fully_preserved   # 场景锁定
detailed_description:
[Shot 1] a medium-wide shot frames... The camera [motion] as <Subject 1> [action] — no `<d>` in this first second (the chain window is carried from the previous shot and must stay silent). [Shot 2] At 00:01.500, <Subject 1> (S1) says: <d>[Chinese] dialogue original</d> [Shot 3] At 00:03.000, the camera cuts to...
overall_soundscape:
[环境音描述]
non_diegetic_music:
[BGM 描述]
```

**Label rules**:
- **No style words**: `detailed_description` must not contain any medium/style word (`Live-action` / `photoreal` / `anime` / `2D` / `3D`). The style preset is prepended by the caller; writing your own contradicts it.
- `<Subject N>`: for a character write **two things** — who it is in `<Picture N>` (the character's name) and where it sits in the frame (e.g. `on the left of frame by the nightstand lamp` — side plus a fixed furnishing, write both). **Never styling**: hair, makeup, clothing and accessories all come straight from the reference image, and no styling adjectives either (`elegant` / `beautiful` / `in a silk dress` all count as styling). You **cannot see** that image, so anything you invent will contradict the character sheet. Same for scenes/props: describe only what the reference actually carries; never add people to it.
- `<Picture N>`: the reference-image index, the same N set as the Chinese `@Image N` (characters 1..k, scene k+1, props k+2..).
- If the scene `<Picture k+1>` uses a nine-grid image, it **must** read "is a storyboard reference for [Shot N], defining its viewpoint, subject placement, and shot order" (the essence of scene anchoring); when one reference anchors several shots, list them the official way: "is a storyboard reference for [Shot 1] and [Shot 2], defining their viewpoint, subject placement, and shot order".

**Numbering rules:** the `<Subject N>` and `<Picture N>` in the six-section prompt share the **same N set** (Nth asset = character 1..k, scene, prop 1..m), one-to-one. Just number in "character -> scene -> prop" order; you do not need to know any URLs.

**Blocking rules** (every video is one standalone generation — unwritten blocking gets re-rolled every time):
- Always use screen-relative sides (`left / right of frame`), never the character's own left or right hand; also carry an anchor **relative to a fixed furnishing** (e.g. `at the bed edge by the nightstand lamp`) — the screen side is this shot's fact, the furnishing anchor is the fact that survives a camera change (cut to reverse angles and left/right flips, "the lamp side" does not), so write both
- Source of truth: the blocking already written in the storyboard `description` wins; if `description` has none, pin it by the character's `<Picture N>` index — No.1 on the left of frame, No.2 on the right, No.3 and later further back and to the sides — and **keep that same set across the whole episode** (no side-swapping between storyboards of one scene)
- Every `[Shot N]` restates the blocking (e.g. `<Subject 1> (left) …`); after a cut, restate it once more — never swap sides
- **State both hands**: for every character in frame, write where each of their two hands is (or explicitly that the other hand is out of frame / occluded). An unassigned hand gets filled in from the reference image's pose — the character sheets hold both hands clasped at the waist — so the frame grows an extra hand
- A character moving within a shot (standing up, stepping closer, leaving) needs the visible process written out; never relocate them silently
- **Inherit the previous shot's ending state**: if the call message carries it ("上一镜末态"), your first segment must pick up exactly from that state (same blocking, facing, hand placement, held prop, eyeline); any position change needs a visible action process
- **Reuse the scene anchor verbatim**: within one scene, repeat the same spatial anchor (which side each fixed furnishing is on, where the light comes from) word-for-word in every prompt — paraphrasing is where the drift starts

**Retention rules:** each subject in `retention_analysis` takes one state word — `fully_preserved` (strong retention; **scenes always use it**) / `partially_preserved` / `attribute_transfer` / `weak_reference`.

**Shot vocabulary** (official §4.3, all 13 types): `Zoom In` / `Zoom Out`, `Push In` / `Pull Out`, `Pan Left` / `Pan Right`, `Truck Left` / `Truck Right`, `Tilt Up` / `Tilt Down`, `Pedestal Up` / `Pedestal Down`, `Arc Shot`, `Tracking Shot`, `Static Shot`, `Shake Slightly` / `Shake Strongly`, `POV`, `Roll Clockwise` / `Roll Counterclockwise`.

**Writing camera motion**: three dimensions = motion type + `with small amplitude` / `with large amplitude` + `at slow speed` / `at fast speed` (medium amplitude and normal speed are usually omitted). It must read as a **natural English action inside the shot sentence**, never stacked as labels at the end of a sentence. Official examples:
`The camera pushes in with small amplitude at slow speed toward the folded letter in her hands.`
`The camera holds a static shot as the runner exits the frame.`

**Writing cuts (official §4.2, hard rules)**:
- **`[Shot 1]` carries no timestamp**; later shots use `[Shot N] At MM:SS.mmm, ...`, with cut times **strictly increasing and within the video duration**
- **Spread the anchors across the whole duration — do not copy the example's spacing**: 12s → `At 00:01.500 / 00:04.000 / 00:07.000 / 00:10.000`; 15s → `At 00:01.500 / 00:05.000 / 00:09.000 / 00:13.000`. The last anchor must be ≤ duration − 1.5s and must say **what happens in the final 1.5 seconds**; the tail may not idle or repeat the previous beat (measured 1006: 15s shots whose anchors stopped at 00:07-00:11 spent the second half grinding in place)
- For ordinary cuts use only one of these five: `the camera cuts to`, `the shot cuts to`, `the shot transitions to`, `the shot changes to`, `the shot switches to`. **Cross-dissolve / fade / wipe only when the user explicitly asks**; default to hard cuts
- "Cut back" has **no official equivalent** — never render it literally as `cuts back to`. Instead **refer back to the previous shot** while restating the subject, e.g.:
  `[Shot 2] At 00:03.000, the shot cuts to a close-up of <Subject 4> (S2), the young man in the dark-grey hoodie from Shot 1, ...`
- **Never cut just to change distance or a slight angle — use camera motion** (see "Cut admission" above)
- Dialogue crossing a cut: mark `<scenetrans>` at **both** connecting points and state explicitly that the audio continues — `continues seamlessly across the cut` / `continues uninterrupted into the next shot` / `carries over from the previous shot` / `remains audible across the transition`; use `<cutoff>` when speech is truncated by the end of the video

**Shot & dialogue rules**:
- `detailed_description` is written shot by shot via `[Shot N]`, covering the shot, camera motion (terms above), **each character's screen side**, character actions, speaker IDs (e.g. `(S1)`), and `<d>` dialogue.
- **Speaker rules (official §4.4)**: give `(Sx)` only to subjects who actually vocalize; subjects who never vocalize get **no** speaker ID. When multiple already-numbered speakers speak or sing **together**, use a compound ID such as `(S1,S2)`. A speaker keeps the same ID across shots. If it is unclear who is speaking, the model fills in the gap and both characters open their mouths at once.
- On a speaker's **first appearance**, establish a stable identity (character type, age, gender, on-screen or off-screen, pitch, timbre, speaking rate, accent). Place the identifying phrase, ID, action and delivery **outside** `<d>`; inside `<d>` put only the language tag and the user's actual spoken content.
- **The first 1 second of every segment must contain no `<d>` dialogue of any kind** (spoken line, voiceover, inner monologue all count) — the earliest dialogue timestamp is ≥ 1s; only visuals/ambience/action may occupy that second. The chain window (22 frames ≈ 0.92 s) is exactly this span — dialogue inside it collides with the previous segment's audio.
- **Dialogue timing**: estimate at natural pace (Chinese ≈4–5 chars/sec, English ≈2–3 words/sec, including pauses) and make sure the shot lasts long enough to contain ALL of its dialogue. If it does not fit, extend that `[Shot N]`'s timestamp or split the line across adjacent shots with `<scenetrans>`. NEVER cram a long line into a too-short shot (breaks lip-sync and rhythm).
- `AUDIO_INSTRUCTION.slots` order by **speaking order in this segment**: the first speaker is item 1 (= `<Audio 1>` = `ref_audio_0`), the second is item 2. NEVER order by slot name A/B/C. Write `<Audio N>` only when someone actually speaks in the segment.
- **Never invent** lines; pull them verbatim from the `description`'s [Shot N] and drop them into `<d>` with a language tag (e.g. `<d>[Chinese] …</d>`).
- The template's remaining text is always English, whatever the session language is; the line inside `<d>` keeps its **original language**.

**Saving:** after generating the Chinese `video_prompt`, fill in `video_prompt_full_ref` per the template above; save both fields in one `update_storyboard` call (`storyboard_id`, `video_prompt`, `video_prompt_full_ref`).
