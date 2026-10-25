import DOMPurify from 'dompurify'
import { marked } from 'marked'

export default function renderMarkdown(markdown: string) {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false }), {
    ALLOWED_TAGS: [
      'p',
      'br',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'ul',
      'ol',
      'li',
      'strong',
      'em',
      'del',
      'a',
      'blockquote',
      'pre',
      'code',
      'hr',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
    ],
    ALLOWED_ATTR: ['href', 'title', 'start'],
    ALLOW_DATA_ATTR: false,
  })
}
