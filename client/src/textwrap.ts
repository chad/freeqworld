// Speech bubble text layout (spec §9.2): at most three lines, word wrap,
// long messages abbreviated with an ellipsis — the transcript shows the
// full content.

export interface WrappedBubble {
  lines: string[]
  truncated: boolean
}

const MAX_LINES = 3

export function wrapBubble(text: string, width: number): WrappedBubble {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  let truncated = false

  for (let wi = 0; wi < words.length; wi++) {
    let word = words[wi]!
    while (word.length > width) {
      // hard-break oversized words
      const head = word.slice(0, current ? width - current.length - 1 : width)
      const attempt = current ? `${current} ${head}` : head
      if (attempt.length <= width && head.length > 0) {
        lines.push(attempt)
        current = ''
        word = word.slice(head.length)
      } else {
        if (current) lines.push(current)
        current = ''
        lines.push(word.slice(0, width))
        word = word.slice(width)
      }
      if (lines.length >= MAX_LINES) break
    }
    if (lines.length >= MAX_LINES) {
      truncated = true
      break
    }
    if (!word) continue
    const attempt = current ? `${current} ${word}` : word
    if (attempt.length <= width) {
      current = attempt
    } else {
      lines.push(current)
      current = word
      if (lines.length >= MAX_LINES) {
        truncated = true
        break
      }
    }
    if (wi === words.length - 1 && current) {
      lines.push(current)
      current = ''
    }
  }
  if (current && lines.length < MAX_LINES) lines.push(current)

  if (lines.length > MAX_LINES) {
    lines.length = MAX_LINES
    truncated = true
  }
  if (truncated && lines.length > 0) {
    const last = lines[lines.length - 1]!
    lines[lines.length - 1] = (last.length >= width ? last.slice(0, width - 1) : last) + '…'
  }
  return { lines, truncated }
}
