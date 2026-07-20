import { describe, expect, it } from 'vitest'
import { wrapBubble } from './textwrap'

describe('speech bubble wrapping (spec 9.2)', () => {
  it('keeps short messages on one line', () => {
    expect(wrapBubble('hi there', 24)).toEqual({ lines: ['hi there'], truncated: false })
  })

  it('wraps at word boundaries to at most three lines', () => {
    const { lines } = wrapBubble('one two three four five six seven eight nine ten eleven twelve', 12)
    expect(lines.length).toBeLessThanOrEqual(3)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(12)
  })

  it('abbreviates long messages with an ellipsis and flags truncation (spec 6.5)', () => {
    const long = 'word '.repeat(60).trim()
    const res = wrapBubble(long, 20)
    expect(res.truncated).toBe(true)
    expect(res.lines[res.lines.length - 1]!.endsWith('…')).toBe(true)
  })

  it('hard-breaks single words longer than the line width', () => {
    const res = wrapBubble('supercalifragilisticexpialidocious', 10)
    expect(res.lines[0]!.length).toBeLessThanOrEqual(10)
  })
})
