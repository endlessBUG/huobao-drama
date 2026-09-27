---
name: character-prompt
description: Final character prompt specification — front-face close-up + three-view turnaround (front / 90-degree side / back), serving as the appearance anchor for all subsequent generation
---

# Final Character Prompt (left: front-face close-up + right: three-view turnaround)

What is generated is a character reference sheet with a fixed composition:

- **Left: front-face close-up** — a frontal close view of head and shoulders, with facial features, hairstyle, and skin texture clearly visible, serving as the anchor for facial recognizability
- **Right: three equal-height full-body views side by side — front, 90-degree side, and back** — three full-body views of the same character at equal height, with the tops of the heads and the soles of the feet aligned

**Core principle: consistency > beauty.** This image is the appearance anchor for all subsequent character images and video references; it must be neutral, clear, and reusable — do not pursue the artistry of a single image.

**When a reference image is supplied, the reference is the appearance authority.** The person in that image is the only source of appearance: the prompt's job is to **point at it** ("the same person as in the reference image") and to **specify the composition** (how the turnaround is laid out), not to redesign the character. Measured result: when the text conflicts with the reference image, the output **follows the text** — the reference shows a white-and-gold fantasy gown, the text says "beige loungewear", and the result is beige loungewear on that face. In reference mode every appearance or clothing sentence is a **competitor** to the reference image, not a supplement.

## Faithful reproduction of the original design (primary constraint)

A character's `appearance` (looks) and `styling` (hair/clothing/makeup) ARE that character's original design, derived from the user's reference image or the script. **The final prompt must transcribe that original appearance and clothing item by item — never summarise, substitute, beautify, or redesign it.** The turnaround is the appearance anchor for the whole pipeline: change one garment here and every later image and video inherits the error.

**Precedence: reference image > `appearance` / `styling` text.** When the two agree, transcribe item by item as above; when they conflict, the reference image wins and the conflicting item must **not** be written (writing it means overwriting the reference with text). With no reference image, the text is the only source and must be written out in full.

- **Facial features / hairstyle**: write out face shape, eye shape, brow shape, hair length and style individually — do not compress them into generic words like "refined features" or "long flowing hair"
- **Makeup / skin**: write out skin tone and texture, blush, lip color and finish, eye makeup (liner / shadow / lashes), and brow shape individually. **This is the most commonly omitted item** — leave it out and the defaults take over, producing a bare face or generic heavy makeup whose lip color, skin tone, and look no longer match the original design
- **Clothing**: write out style + color + material + layering (inner layer / outer robe / waist sash, etc.) + condition. E.g. "a sheer white gauze outer robe over a white strapless bodice, a gold chest ornament, a gold waist sash" — not just "a white hanfu top"
- **Accessories**: keep every ear, neck, hair, and forehead ornament that appears in the original design, individually — do not omit or merge them
- **Do not invent**: do not add details the original design does not contain; when unsure, keep the original wording rather than overwriting it with a different outfit

## Output Structure (assemble a single coherent passage in this order, following the session language directive)

**With a reference image**, use this version — the first line pins the reference image as the appearance authority, and the slots carry only recognizable points visible in the reference image, not an itemised list:

```
Anchor to the same person as in the reference image: face shape, features, hairstyle, skin tone, makeup,
clothing, and accessories all kept exactly as shown in the reference image; only the angle and framing change;
Character reference sheet, left side a front-face close-up, right side three equal-height full-body views
side by side showing front, 90-degree side, and back;
the close-up and the full-body views are the same character, full body in frame, neutral A-pose,
the three full-body views equal in height, side by side, tops of heads and soles of feet aligned;
[only the recognizable points actually visible in the reference image and worth stressing: age impression + physique + signature features / hairstyle / clothing highlights];
the face, hairstyle, and clothing of the front-face close-up and the three views are completely identical, and so are the makeup and accessories, all matching the reference image;
pure white background, soft even lighting, cinematic quality
```

**Without a reference image**, use this version — the text is the only source, so every slot must be written out:

```
Character reference sheet, left side a front-face close-up, right side three equal-height full-body views
side by side showing front, 90-degree side, and back;
the close-up and the full-body views are the same character, full body in frame, neutral A-pose,
the three full-body views equal in height, side by side, tops of heads and soles of feet aligned;
[age impression + gender impression + physique], [facial features], [makeup and skin], [hairstyle];
[clothing: style + color + material + layering + condition], [accessories: listed one by one, not merged];
the face, hairstyle, and clothing of the front-face close-up and the three views are completely identical, and so are the makeup and accessories;
pure white background, soft even lighting, cinematic quality
```

## Reference-image mode rules (when the user has supplied a reference image)

The reference image already carries the person's complete appearance; the text's job is to **not cover it up**:

- **Write only what is visible in the reference image**: every slot item must be pointable in the reference image; styles, colors, and hairstyles that are not there must not be written
- **Never pick from alternatives**: when the original design offers a choice ("or / such as / either", e.g. "soft loungewear in warm tones (such as beige, light pink, or dark grey)"), **do not pick one and write it down** — picking one overwrites the reference image with text. Drop that detail entirely and let the reference image decide
- **Skip conflicting items outright**: the parts of `appearance` / `styling` that disagree with the reference image (hairstyle, garment style, color) are omitted — do not "compromise" into a third option
- **Shorter beats wrong**: in reference mode a longer list of details scores nothing while one wrong item is a hard defect. Age impression, physique, and signature features are enough — **leave clothing and accessories to the reference image** unless a specific detail must be stressed

## Description Order Rules

Put the **most recognizable features first**, covering every key element of `appearance` (looks) and `styling` (hair/clothing/makeup) in this order, with no omissions:

1. Identity anchors: age impression (e.g. "early twenties"), gender impression, physique (height and build, posture habits)
2. Facial features: face shape, eyes, other notable features (scars, moles, glasses, etc.) — the front-face close-up depends on this part especially
3. Makeup and skin: skin tone and texture, blush, lip color and finish, eye makeup (liner / shadow / lashes), brow shape — half of the close-up's recognizability comes from here
4. Hairstyle: color, length, style
5. Clothing: style, color, material, layering, condition (e.g. "a wrinkled work uniform with solder marks on the cuffs") — write every piece out, do not summarise
6. Accessories: write only the recognizable ones; do not pile them on

Convert the character's personality traits into outward bearing and expression descriptions (e.g. "haggard" → "weary eyes, slightly slumped shoulders"); personality words must not appear directly.

## Composition & Consistency

- Left front-face close-up: facing the camera directly, neutral expression, head to shoulders fully in frame
- Right three full-body views: front, 90-degree side, and back of the same character, **equal in height, side by side, evenly spaced**, tops of heads and soles of feet on the same horizontal lines
- The close-up and the three full-body views must have the same face, the same hairstyle, and the same clothing — explicitly state "the face, hairstyle, and clothing of the front-face close-up and the three full-body views are completely identical"
- Neutral stance, natural expression — easy to reuse as a reference image
- Soft, even studio lighting; no dramatic light and shadow (the reference image must work in every kind of scene)
- Do not mix unrelated words into the output

## Prohibitions

- Dynamic poses, exaggerated expressions, props in hand, being in frame with other people
- Cropping the body (full-body views must be full body, head to soles fully in frame; the close-up must have head and shoulders fully in frame)
- Text, labels, watermarks, signatures
- Heavy shadows, colored background lighting, background props

## Output

**Output the prompt body and nothing else**: one plain-text passage — no explanation, no preamble, no markdown code fence, no "optimized prompt:" heading, and do not call any tool to store it: the user saves character prompts themselves on the detail page.
The body carries no style words: **the project's visual style is prepended automatically at generation time**, so writing it in is duplication.

**The skeleton is mandatory (measured, 2026-09-27)**: whatever the upstream text is — empty, or a couple of scattered words — these lines must be kept verbatim:

- `Character reference sheet, left side a front-face close-up, right side three equal-height full-body views side by side showing front, 90-degree side, and back;`
- `the close-up and the full-body views are the same character, full body in frame, neutral A-pose, the three full-body views equal in height, side by side, tops of heads and soles of feet aligned;`
- `the face, hairstyle, and clothing of the front-face close-up and the three views are completely identical, and so are the makeup and accessories` (in reference mode it continues `, all matching the reference image`)
- `pure white background, soft even lighting, cinematic quality`
- in reference mode the opening anchor `Anchor to the same person as in the reference image: face shape, features, hairstyle, skin tone, makeup, clothing, and accessories all kept exactly as shown in the reference image; only the angle and framing change;`

The entire sheet layout comes from these lines. Measured consequence of dropping them: given only style words plus a reference image, the model has no layout to execute and repaints the reference image as a single portrait.

When asked to optimize raw `appearance` / `styling` text: rewrite it item by item following the "Description Order" rules below, keep the facts the user already established, and invent nothing new.
