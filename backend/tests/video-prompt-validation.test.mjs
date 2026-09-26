import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isVideoPromptFullRefFull } from '../src/services/video-prompt-validation.ts'

const GOOD = [
  'subject_definitions:',
  '<Subject 1> is a young woman with short black hair and a white blouse, from <Picture 1>.',
  '<Subject 2> is a man in a dark suit, from <Picture 2>.',
  '<Subject 3> is a 1980s hospital corridor with a long window row on the left, an establishing storyboard reference for [Shot 1], defining its viewpoint, subject placement, and shot order.',
  'summary:',
  '[Shot 1] is a 5.2-second reference-generation video. <Subject 1> and <Subject 2> argue in the corridor; <Subject 3> is the scene anchor.',
  'retention_analysis:',
  '<Subject 1> fully_preserved',
  '<Subject 2> fully_preserved',
  '<Subject 3> fully_preserved',
  'detailed_description:',
  '[Shot 1] 00:00.000 Static medium shot: <Subject 1> paces near the window, says: <d>[English] You were supposed to be here an hour ago.</d> ' +
  '00:02.000 Cut to a close-up: <Subject 2> presses the door, face tense.',
  'overall_soundscape:',
  'Echoing footsteps, distant beeper.',
  'non_diegetic_music:',
  'Sparse low piano.',
].join('\n')

test('complete six-section English full-ref passes', () => assert.equal(isVideoPromptFullRefFull(GOOD), true))
test('missing subject_definitions header fails', () =>
  assert.equal(isVideoPromptFullRefFull(GOOD.replace(/^subject_definitions:\n/, '')), false))
test('missing <Subject> tag fails', () =>
  assert.equal(isVideoPromptFullRefFull(GOOD.replace(/<Subject \d+>/g, 'the subject')), false))
test('missing <Picture> tag fails', () =>
  assert.equal(isVideoPromptFullRefFull(GOOD.replace(/<Picture \d+>/g, 'the image')), false))
test('missing fully_preserved fails', () =>
  assert.equal(isVideoPromptFullRefFull(GOOD.replace(/fully_preserved/g, 'weak_reference')), false))
test('missing <d> dialogue fails', () =>
  assert.equal(isVideoPromptFullRefFull(GOOD.replace(/<d>.*?<\/d>/, '')), false))
test('empty string fails', () => assert.equal(isVideoPromptFullRefFull(''), false))
