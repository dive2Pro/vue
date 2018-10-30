/**
 * Not type-checking this file because it's mostly vendor code.
 */

/*!
 * HTML Parser By John Resig (ejohn.org)
 * Modified by Juriy "kangax" Zaytsev
 * Original code by Erik Arvidsson, Mozilla Public License
 * http://erik.eae.net/simplehtmlparser/simplehtmlparser.js
 */

import { makeMap, no } from "shared/util";
import { isNonPhrasingTag } from "web/compiler/util";

// Regular Expressions for parsing tags and attributes
const attribute = /^\s*([^\s"'<>\/=]+)(?:\s*(=)\s*(?:"([^"]*)"+|'([^']*)'+|([^\s"'=<>`]+)))?/;
// could use https://www.w3.org/TR/1999/REC-xml-names-19990114/#NT-QName
// but for Vue templates we can enforce a simple charset
const ncname = "[a-zA-Z_][\\w\\-\\.]*";
const qnameCapture = `((?:${ncname}\\:)?${ncname})`;
const startTagOpen = new RegExp(`^<${qnameCapture}`);
const startTagClose = /^\s*(\/?)>/;
const endTag = new RegExp(`^<\\/${qnameCapture}[^>]*>`);
const doctype = /^<!DOCTYPE [^>]+>/i;
// #7298: escape - to avoid being pased as HTML comment when inlined in page
const comment = /^<!\--/;
const conditionalComment = /^<!\[/;

let IS_REGEX_CAPTURING_BROKEN = false;
"x".replace(/x(.)?/g, function(m, g) {
  IS_REGEX_CAPTURING_BROKEN = g === "";
});

// Special Elements (can contain anything)
export const isPlainTextElement = makeMap("script,style,textarea", true);
const reCache = {};

const decodingMap = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&amp;": "&",
  "&#10;": "\n",
  "&#9;": "\t"
};
const encodedAttr = /&(?:lt|gt|quot|amp);/g;
const encodedAttrWithNewLines = /&(?:lt|gt|quot|amp|#10|#9);/g;

// #5992
const isIgnoreNewlineTag = makeMap("pre,textarea", true);
const shouldIgnoreFirstNewline = (tag, html) =>
  tag && isIgnoreNewlineTag(tag) && html[0] === "\n";

/**
 * decoding, 防止一些意外, 比如 渗透攻击
 * @param {*} value
 * @param {*} shouldDecodeNewlines
 */
function decodeAttr(value, shouldDecodeNewlines) {
  const re = shouldDecodeNewlines ? encodedAttrWithNewLines : encodedAttr;
  return value.replace(re, match => decodingMap[match]);
}

export function parseHTML(html, options) {
  const stack = [];
  const expectHTML = options.expectHTML;
  const isUnaryTag = options.isUnaryTag || no;
  const canBeLeftOpenTag = options.canBeLeftOpenTag || no;
  let index = 0;
  let last, lastTag; // 记录当前解析的 tag
  while (html) {
    last = html;
    // Make sure we're not in a plaintext content element like script/style
    if (!lastTag || !isPlainTextElement(lastTag)) {
      let textEnd = html.indexOf("<"); // 拿到 < , 正常的 html element 的标记开始位  <div> ... </div>
      // 如果定格是 <
      if (textEnd === 0) {
        // Comment:
        if (comment.test(html)) {
          const commentEnd = html.indexOf("-->"); // 找到 comment 的结点位置

          // 如果节点位置存在
          if (commentEnd >= 0) {
            // 设置中有保留 comment 的选项的话
            if (options.shouldKeepComment) {
              // 截取 comment 的值, 并回传 callback中
              options.comment(html.substring(4, commentEnd));
            }
            // 移动坐标
            advance(commentEnd + 3);
            // 下一循环
            continue;
          }
        }

        // http://en.wikipedia.org/wiki/Conditional_comment#Downlevel-revealed_conditional_comment
        // 遇上 conditionalComment 直接略过
        if (conditionalComment.test(html)) {
          const conditionalEnd = html.indexOf("]>");

          if (conditionalEnd >= 0) {
            advance(conditionalEnd + 2);
            continue;
          }
        }

        // 如是匹配到<!DOCTYPE ... > , 略过
        const doctypeMatch = html.match(doctype);
        if (doctypeMatch) {
          advance(doctypeMatch[0].length);
          continue;
        }

        // End tag:
        const endTagMatch = html.match(endTag);
        // 如果匹配到是结尾tag
        if (endTagMatch) {
          const curIndex = index;
          // 移动坐标
          advance(endTagMatch[0].length);
          // 处理该字符
          parseEndTag(endTagMatch[1], curIndex, index);
          continue;
        }

        // Start tag:
        const startTagMatch = parseStartTag();
        // 匹配到的match, 证明已经截取了字符到 startTagMatch.end 的位置
        if (startTagMatch) {
          handleStartTag(startTagMatch);
          if (shouldIgnoreFirstNewline(lastTag, html)) {
            advance(1);
          }
          continue;
        }
      }

      let text, rest, next;
      if (textEnd >= 0) {
        // 截掉不是 < 起点的字符
        rest = html.slice(textEnd);
        while (
          !endTag.test(rest) &&
          !startTagOpen.test(rest) &&
          !comment.test(rest) &&
          !conditionalComment.test(rest)
        ) {
          // < in plain text, be forgiving and treat it as text
          next = rest.indexOf("<", 1);
          if (next < 0) break;
          textEnd += next;
          rest = html.slice(textEnd);
        }
        // 获取节点的内容
        text = html.substring(0, textEnd);
        advance(textEnd);
      }
      // 此时已经没有html标记了
      if (textEnd < 0) {
        text = html;
        html = "";
      }
      // chars 回调
      if (options.chars && text) {
        options.chars(text);
      }
    } else {
      // 在解析某个节点中的 startTag 或是  endTag后 会执行到这里

      let endTagLength = 0;
      const stackedTag = lastTag.toLowerCase();

      // 匹配 >(  )(</${stackedTag}  >)这样一段字符
      const reStackedTag =
        reCache[stackedTag] ||
        (reCache[stackedTag] = new RegExp(
          "([\\s\\S]*?)(</" + stackedTag + "[^>]*>)",
          "i"
        ));

      const rest = html.replace(reStackedTag, function(all, text, endTag) {
        endTagLength = endTag.length;
        if (!isPlainTextElement(stackedTag) && stackedTag !== "noscript") {
          text = text
            .replace(/<!\--([\s\S]*?)-->/g, "$1") // #7298
            .replace(/<!\[CDATA\[([\s\S]*?)]]>/g, "$1");
        }
        if (shouldIgnoreFirstNewline(stackedTag, text)) {
          text = text.slice(1);
        }
        // content 回调
        if (options.chars) {
          options.chars(text);
        }
        return "";
      });
      index += html.length - rest.length;
      html = rest;
      parseEndTag(stackedTag, index - endTagLength, index);
    }

    // 上面的截取过程完成后, 如果 last === html, 证明已经不能在被解析了
    if (html === last) {
      options.chars && options.chars(html);
      if (
        process.env.NODE_ENV !== "production" &&
        !stack.length &&
        options.warn
      ) {
        options.warn(`Mal-formatted tag at end of template: "${html}"`);
      }
      break;
    }
  }

  // Clean up any remaining tags
  parseEndTag();

  /**
   * 移动坐标
   * 截断 html 的 前 n 位置的字符
   * @param {number} n
   */
  function advance(n) {
    index += n;
    html = html.substring(n);
  }

  function parseStartTag() {
    const start = html.match(startTagOpen);
    if (start) {
      const match = {
        tagName: start[1], // 拿到 tagName
        attrs: [], // 初始化 attrs []
        start: index // start为当前的 index
      };
      // 移动到tagName结尾
      advance(start[0].length);

      let end, attr;
      while (
        // 没有匹配到 startTagClose
        !(end = html.match(startTagClose)) &&
        // 匹配到 attribute
        (attr = html.match(attribute))
      ) {
        // 移动游标
        advance(attr[0].length);
        // 将匹配的 attr 放入 match.attrs 中
        match.attrs.push(attr);
      }
      // 匹配到startTagClose
      if (end) {
        match.unarySlash = end[1];
        // 移动游标
        advance(end[0].length);
        // 记录end
        match.end = index;
        return match;
      }
    }
  }

  function handleStartTag(match) {
    const tagName = match.tagName;
    const unarySlash = match.unarySlash;

    if (expectHTML) {
      // 必须有结束标签, 但 p 有什么不同?
      if (lastTag === "p" && isNonPhrasingTag(tagName)) {
        parseEndTag(lastTag);
      }
      // 是否属于可被同tag组件结束
      if (canBeLeftOpenTag(tagName) && lastTag === tagName) {
        parseEndTag(tagName);
      }
    }

    const unary = isUnaryTag(tagName) || !!unarySlash;

    // 处理 attrs
    const l = match.attrs.length;
    const attrs = new Array(l);
    for (let i = 0; i < l; i++) {
      const args = match.attrs[i];
      // hackish work around FF bug https://bugzilla.mozilla.org/show_bug.cgi?id=369778
      if (IS_REGEX_CAPTURING_BROKEN && args[0].indexOf('""') === -1) {
        if (args[3] === "") {
          delete args[3];
        }
        if (args[4] === "") {
          delete args[4];
        }
        if (args[5] === "") {
          delete args[5];
        }
      }
      const value = args[3] || args[4] || args[5] || "";
      const shouldDecodeNewlines =
        tagName === "a" && args[1] === "href"
          ? options.shouldDecodeNewlinesForHref
          : options.shouldDecodeNewlines;
      attrs[i] = {
        // 将attr 获取后放入 attrs 中
        name: args[1],

        value: decodeAttr(value, shouldDecodeNewlines)
      };
    }

    // 如果 结尾不是以  /> 这样的形式, 则将其置入 stack中
    if (!unary) {
      stack.push({
        tag: tagName,
        lowerCasedTag: tagName.toLowerCase(),
        attrs: attrs
      });
      lastTag = tagName;
    }
    // call start 回调
    if (options.start) {
      options.start(tagName, attrs, unary, match.start, match.end);
    }
  }

  function parseEndTag(tagName, start, end) {
    let pos, lowerCasedTagName;
    if (start == null) start = index;
    if (end == null) end = index;

    if (tagName) {
      lowerCasedTagName = tagName.toLowerCase();
    }

    // Find the closest opened tag of the same type
    if (tagName) {
      lowerCasedTagName = tagName.toLowerCase();
      for (pos = stack.length - 1; pos >= 0; pos--) {
        if (stack[pos].lowerCasedTag === lowerCasedTagName) {
          break;
        }
      }
    } else {
      // If no tag name is provided, clean shop
      pos = 0;
    }
    // stacks 中如果有对应的 startTag
    if (pos >= 0) {
      // 结束这一段中的所有 unary 的节点
      // Close all the open elements, up the stack
      for (let i = stack.length - 1; i >= pos; i--) {
        if (
          process.env.NODE_ENV !== "production" &&
          (i > pos || !tagName) &&
          options.warn
        ) {
          options.warn(`tag <${stack[i].tag}> has no matching end tag.`);
        }
        if (options.end) {
          options.end(stack[i].tag, start, end);
        }
      }

      // Remove the open elements from the stack
      stack.length = pos;
      // 移动到结束标签的父标签
      lastTag = pos && stack[pos - 1].tag;
    } else if (lowerCasedTagName === "br") {
      //
      if (options.start) {
        options.start(tagName, [], true, start, end);
      }
    } else if (lowerCasedTagName === "p") {
      // 结束 p
      if (options.start) {
        options.start(tagName, [], false, start, end);
      }
      // 执行 end
      if (options.end) {
        options.end(tagName, start, end);
      }
    }
  }
}
