/* @flow */

import { cached } from 'shared/util'
import { parseFilters } from './filter-parser'

const defaultTagRE = /\{\{((?:.|\r?\n)+?)\}\}/g
const regexEscapeRE = /[-.*+?^${}()|[\]\/\\]/g

const buildRegex = cached(delimiters => {
  const open = delimiters[0].replace(regexEscapeRE, '\\$&')
  const close = delimiters[1].replace(regexEscapeRE, '\\$&')
  return new RegExp(open + '((?:.|\\n)+?)' + close, 'g')
})

type TextParseResult = {
  expression: string,
  tokens: Array<string | { '@binding': string }>
}

export function parseText(
  text: string,
  delimiters?: [string, string] // delimiters = undefined
): TextParseResult | void {
  // 如 {{ a }} b {{ c }}
  const tagRE = delimiters ? buildRegex(delimiters) : defaultTagRE
  if (!tagRE.test(text)) {
    return
  }
  const tokens = []
  const rawTokens = []
  let lastIndex = (tagRE.lastIndex = 0)
  let match, index, tokenValue
  while ((match = tagRE.exec(text))) {
    // match = ["{{a}}", "a"]
    index = match.index // 0
    // push text token
    if (index > lastIndex) {
      // 执行到  [:{{c}}", "c"]
      // index = 9, lastIndex = 5
      // 那么在其间的为 tokenValue ' b '
      rawTokens.push((tokenValue = text.slice(lastIndex, index)))
      // 这是字符串
      tokens.push(JSON.stringify(tokenValue))
    }
    // tag token
    // match[1] = a
    const exp = parseFilters(match[1].trim())
    // 这里 _s -> toString
    tokens.push(`_s(${exp})`)
    // 声明是 @binding: 值是 exp
    rawTokens.push({ '@binding': exp })

    lastIndex = index + match[0].length
  }
  // 遗留的字符
  if (lastIndex < text.length) {
    rawTokens.push((tokenValue = text.slice(lastIndex)))
    tokens.push(JSON.stringify(tokenValue))
  }
  return {
    expression: tokens.join('+'), // 拼接字符串
    tokens: rawTokens
  }
}
