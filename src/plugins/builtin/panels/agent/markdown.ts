/** Minimal, escape-first markdown → HTML for agent replies (code, lists, headings, emphasis, links). */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(s: string): string {
  const code: string[] = []
  let out = esc(s).replace(/`([^`]+)`/g, (_, c: string) => `\u0000${code.push(c) - 1}\u0000`)
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${code[Number(i)]}</code>`)
}

export function markdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let list: 'ul' | 'ol' | null = null
  let para: string[] = []
  const flushPara = () => { if (para.length) html.push(`<p>${para.map(inline).join('<br>')}</p>`); para = [] }
  const flushList = () => { if (list) html.push(`</${list}>`); list = null }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^\s*```(\S*)/)
    if (fence) {
      flushPara(); flushList()
      const body: string[] = []
      while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i])
      html.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)/)
    const bullet = line.match(/^\s*[-*+]\s+(.*)/)
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)/)
    if (heading) { flushPara(); flushList(); html.push(`<h${Math.min(6, heading[1].length + 2)}>${inline(heading[2])}</h${Math.min(6, heading[1].length + 2)}>`) }
    else if (bullet || numbered) {
      flushPara()
      const kind = bullet ? 'ul' : 'ol'
      if (list !== kind) { flushList(); html.push(`<${kind}>`); list = kind }
      html.push(`<li>${inline((bullet ?? numbered)![1])}</li>`)
    } else if (!line.trim()) { flushPara(); flushList() }
    else { flushList(); para.push(line) }
  }
  flushPara(); flushList()
  return html.join('')
}
