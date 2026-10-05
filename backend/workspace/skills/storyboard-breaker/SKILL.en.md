---
name: storyboard-breaker
description: Professional rules for storyboard breakdown — splitting a script into storyboard segments that each carry multiple sub-shots
---

# Storyboard Breakdown Guide

## Core Definition: Storyboard Segment

One storyboard = one **storyboard segment** = one video-generation task.

- Each segment is **8-15 seconds** long and internally carries **2-4 sub-shots**
- Cuts between sub-shots **are allowed**, joined with hard cuts — but a cut has an **admission test** (MiniMax H3 official §4.2): it must introduce new information — a new subject, space, state, viewpoint, or time. **If you only want to push the shot size in or out, or shift the angle slightly, do not cut — write it as camera motion**: "medium shot → close-up" is one push-in, not a cut. Cutting back and forth between shot sizes on the same subject, the same space, at the same moment only yields cut-together footage that jumps around with no information
- Sub-shots **never cross scenes**: a segment takes place in a single scene (`scene_id` is a segment-level binding)
- Each sub-shot is 2-6 seconds, focused on one visual unit (one action, one reaction, one close-up)

## Breakdown Process (Four Steps)

1. Call `read_storyboard_context` to read the script, characters, scenes, props, and existing storyboard summaries
2. **Beat identification**: first identify the script's narrative beats — markers such as [Opening] [Trigger] [Climax] [Resolution], or narrative turning points (location changes, rule reveals, emotional eruptions, reversals). **Beat boundaries force a segment cut**; group sub-shots within the same beat into the same segment where possible, and do not scatter a causal chain (setup-event-reaction) across different segments
3. **Total-volume anchoring**: target total duration = script character count ÷ 500 characters/minute; segment count ≈ target total duration ÷ 12 seconds, with ±20% tolerance. Do not significantly overshoot or undershoot
4. **Split sub-shots within each segment**: cut sub-shots at action-change points, viewpoint-change points, and subject-change points; after filling in all fields for each segment, call `save_storyboards` to save them in one go

## Pacing-Tier Durations

Determine duration by the segment's function — do not use one size for all:

| Segment type | Duration | Notes |
|---|---|---|
| Transition segment | 8-10 s | Traveling, empty shots, environment establishment, transitions |
| Narrative segment | 10-15 s | Regular plot advancement, dialogue |
| Payoff segment | 12-15 s | Close-ups, rule reveals, emotional eruptions, reversals; slower sub-shot pacing, a single sub-shot may hold for 4-6 s |

## Dialogue Duration Floor (Hard Rule)

**Segment duration ≥ total character count of dialogue and narration within the segment (the part written in description) ÷ 4.5 characters/second + 2 seconds of performance headroom**

Dialogue that does not fit must be moved to the next segment; cramming unperformable dialogue into one segment is not allowed.

## Shot Elements

1. **Shot title**: a 3-5-character summary of the segment's core content (e.g. "Nightmare Awakening")
2. **Time**: specific time of day + lighting description
3. **Location**: full scene description + spatial layout + environmental details
4. **Shot size**: the dominant shot size of the segment; for multi-size segments write a combination, e.g. "medium shot + close-up"
5. **Angle**: eye-level / low angle / high angle / side / back
6. **Camera move**: static / push-in / pull-back / pan / tracking / dolly (different sub-shots within a segment may differ). **When only the shot size or a slight angle changes, use camera motion instead of a cut** — these map one-to-one onto the official camera terms used on the video-prompt side (`Static` / `Push In` / `Pull Out` / `Pan` / `Truck` / `Tracking` etc.)
7. **Visual description** `description`: describe sub-shot by sub-shot as `【镜头1】…【镜头2】…` what the audience actually sees and hears — the visuals (who + which side of frame + specific action + body-language details + expression) come first; when a sub-shot has dialogue, write it inside the corresponding `【镜头N】` as "CharacterName says: "line"", and narration as "Narration: content"
8. **Visual result** `result`: the immediate consequence at the end of the segment + visual details
9. **Atmosphere** `atmosphere`: lighting + color tone + sound + overall mood
10. **Duration** `duration`: total segment duration 8-15 seconds, and it must satisfy the dialogue duration floor
11. **Scene binding**: if it can be matched to an existing scene, `scene_id` must be filled in
12. **Continuity** `continuity`: the relationship to the **previous segment**. Same camera, same shot size, same space continuing (one shot split into two segments) → `same_shot`; introducing new information (new subject, new space, new state, new viewpoint, or new time — the §4.2 cut gate above) → `cut`. The first segment of an episode is `same_shot` (there is no previous segment). This decides how generation chains: `same_shot` + same scene → the previous segment's last frame is both a reference and anchored at frame 0; `cut` + same scene → reference only (match lighting and colour, not camera position); different scene → no last-frame carry
12. **Character binding**: fill in `character_ids`, binding 0 to multiple characters involved in this segment
13. **Prop binding**: fill in `prop_ids`, binding 0 to multiple key props appearing in this segment

## Space and Blocking (Hard Rule)

Each segment is **generated as its own standalone video**, and the model has no memory of the previous segment. If the space is not written down, every segment re-arranges it from scratch — concatenated, characters jump left and right and props drift (measured: two clips of the same scene put the two people on opposite sides). Treat space as a fact that **exists only once it is written**:

- **Spatial anchors**: the first time a scene appears, pin the fixed furnishings down once (which side of frame the bed / table / window / door / lamp sits on, foreground or background). Use only furnishings the scene already has — never invent new furniture; every later segment in the same scene reuses the same set, unchanged
- **Character blocking**: each character holds a fixed position in that scene, written as "**which fixed furnishing it is relative to** + screen left/right + foreground/background + facing", e.g. "女生A on the left of frame at the bed edge on the nightstand-lamp side, facing right". **Write both**: screen left/right is this shot's fact, the furnishing anchor is the fact that survives a camera change (cut to reverse angles and left/right flips, "the lamp side" does not). Constant across segments within one scene: unless you write them moving, position, facing and what they rest on must not change
- **Restate in every shot**: every `【镜头N】` must say who is where, who they look at, where their hands rest; after a cut, restate the blocking — never write "same as above" or "unchanged"
- **Movement needs a visible process**: sitting-to-standing, table-to-door, turning and exiting all need the action written out; without the process no position change is allowed. A character who exits and re-enters must have the entry written (e.g. "walks in through the door on frame left, back to the bed edge")
- **Assign gaze**: a sub-shot with dialogue must say who the speaker looks at, or the model will have them look at the camera or at a prop
- **Position only, never styling**: no clothing, hair, makeup or accessories — those come from the character reference image, and anything invented will contradict it (how a character looks is not the storyboard's business)
- State space **positively** ("on the left of frame"), never as a negation ("do not move to the right") — sampling has no negative branch, so negations do nothing

## Scene Binding Rules

- Prefer the `scenes` returned by `read_storyboard_context`
- When `location + time` can be clearly matched, the correct `scene_id` must be filled in
- Do not fabricate scene IDs that do not exist
- If the script content clearly falls within an existing scene, do not create a duplicate new scene description

## Character Binding Rules

- `character_ids` must be chosen from the character list returned by `read_storyboard_context`
- A segment may have no characters, or may bind multiple characters
- Any character with a clear appearance in the segment — seen, acting, or speaking — should be bound
- Pure-environment segments, empty shots, and object close-ups may pass an empty array

## Prop Binding Rules

- `prop_ids` must be chosen from the prop list (`props`) returned by `read_storyboard_context`
- When a prop is used by a character, handed over, shown in close-up, or clearly visible in frame and meaningful to the narrative, it must be bound to that segment
- Prop close-up segments (without characters) should also bind the prop; `character_ids` may be empty
- Do not bind background items or set dressing irrelevant to the plot; segments with no props pass an empty array
- Bound props serve as reference images for video generation (white-background product shots), keeping the prop's appearance consistent across segments

## Quality Requirements

- `description` should be human-readable, describing sub-shot by sub-shot what the audience actually sees and hears; dialogue/narration is written directly inside the corresponding `【镜头N】`
- `image_prompt` should highlight the single-frame composition, character appearance, environment, and lighting (corresponding to the segment's first sub-shot)
- `bgm_prompt` and `sound_effect` may be concise phrases, but must not be as vague as just "tense" or "sad"
- To make adjustments, call `update_storyboard` to modify the specific segment
