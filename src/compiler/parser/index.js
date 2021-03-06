/* @flow */

import he from 'he'
import { parseHTML } from './html-parser'
import { parseText } from './text-parser'
import { parseFilters } from './filter-parser'
import { genAssignmentCode } from '../directives/model'
import { extend, cached, no, camelize } from 'shared/util'
import { isIE, isEdge, isServerRendering } from 'core/util/env'

import {
  addProp,
  addAttr,
  baseWarn,
  addHandler,
  addDirective,
  getBindingAttr,
  getAndRemoveAttr,
  pluckModuleFunction
} from '../helpers'

export const onRE = /^@|^v-on:/
export const dirRE = /^v-|^@|^:/
export const forAliasRE = /([\s\S]*?)\s+(?:in|of)\s+([\s\S]*)/
export const forIteratorRE = /,([^,\}\]]*)(?:,([^,\}\]]*))?$/
const stripParensRE = /^\(|\)$/g

const argRE = /:(.*)$/
export const bindRE = /^:|^v-bind:/
const modifierRE = /\.[^.]+/g

const decodeHTMLCached = cached(he.decode)

// configurable state
export let warn: any
let delimiters
let transforms
let preTransforms
let postTransforms
let platformIsPreTag
let platformMustUseProp
let platformGetTagNamespace

type Attr = { name: string, value: string }

export function createASTElement(
  tag: string,
  attrs: Array<Attr>,
  parent: ASTElement | void
): ASTElement {
  return {
    type: 1,
    tag,
    attrsList: attrs,
    attrsMap: makeAttrsMap(attrs),
    parent,
    children: []
  }
}

/**
 * Convert HTML string to AST.
 */
export function parse(template: string, options: CompilerOptions): ASTElement | void {
  warn = options.warn || baseWarn

  platformIsPreTag = options.isPreTag || no
  platformMustUseProp = options.mustUseProp || no
  platformGetTagNamespace = options.getTagNamespace || no

  transforms = pluckModuleFunction(options.modules, 'transformNode')
  preTransforms = pluckModuleFunction(options.modules, 'preTransformNode')
  postTransforms = pluckModuleFunction(options.modules, 'postTransformNode')

  delimiters = options.delimiters

  const stack = []
  const preserveWhitespace = options.preserveWhitespace !== false
  let root
  let currentParent
  let inVPre = false
  let inPre = false
  let warned = false

  function warnOnce(msg) {
    if (!warned) {
      warned = true
      warn(msg)
    }
  }

  // 调用 postTransform
  function closeElement(element) {
    // check pre state
    if (element.pre) {
      inVPre = false
    }
    if (platformIsPreTag(element.tag)) {
      inPre = false
    }
    // apply post-transforms
    for (let i = 0; i < postTransforms.length; i++) {
      postTransforms[i](element, options)
    }
  }

  parseHTML(template, {
    warn,
    expectHTML: options.expectHTML,
    isUnaryTag: options.isUnaryTag,
    canBeLeftOpenTag: options.canBeLeftOpenTag,
    shouldDecodeNewlines: options.shouldDecodeNewlines,
    shouldDecodeNewlinesForHref: options.shouldDecodeNewlinesForHref,
    shouldKeepComment: options.comments,
    start(tag, attrs, unary) {
      // check namespace.
      // inherit parent ns if there is one
      const ns = (currentParent && currentParent.ns) || platformGetTagNamespace(tag)

      // handle IE svg bug
      /* istanbul ignore if */
      if (isIE && ns === 'svg') {
        attrs = guardIESVGBug(attrs)
      }

      let element: ASTElement = createASTElement(tag, attrs, currentParent)
      if (ns) {
        element.ns = ns
      }

      if (isForbiddenTag(element) && !isServerRendering()) {
        element.forbidden = true
        process.env.NODE_ENV !== 'production' &&
          warn(
            'Templates should only be responsible for mapping the state to the ' +
              'UI. Avoid placing tags with side-effects in your templates, such as ' +
              `<${tag}>` +
              ', as they will not be parsed.'
          )
      }

      // apply pre-transforms
      // 比如: 在 web 平台中, modules/model 中会对 使用了 v-model 的element, 并处理
      // 还使用了 v-on, v-if, v-for等等这些 directives 的情况
      for (let i = 0; i < preTransforms.length; i++) {
        element = preTransforms[i](element, options) || element
      }

      // 处理 v-pre 的情况

      if (!inVPre) {
        // 设置 element.pre = true
        processPre(element)
        if (element.pre) {
          inVPre = true
        }
      }
      // 当前在解析的是 <pre> 标签
      if (platformIsPreTag(element.tag)) {
        inPre = true
      }

      if (inVPre) {
        processRawAttrs(element)
      }
      // 在 preTransforms 中已经对 节点的 attrs 进行了 directives 处理
      // 则不再处理
      else if (!element.processed) {
        // structural directives
        processFor(element)
        processIf(element)
        processOnce(element)
        // element-scope stuff
        processElement(element, options)
      }

      function checkRootConstraints(el) {
        if (process.env.NODE_ENV !== 'production') {
          if (el.tag === 'slot' || el.tag === 'template') {
            warnOnce(
              `Cannot use <${el.tag}> as component root element because it may ` +
                'contain multiple nodes.'
            )
          }
          if (el.attrsMap.hasOwnProperty('v-for')) {
            warnOnce(
              'Cannot use v-for on stateful component root element because ' +
                'it renders multiple elements.'
            )
          }
        }
      }

      // tree management
      if (!root) {
        root = element
        checkRootConstraints(root)
      } else if (!stack.length) {
        // allow root elements with v-if, v-else-if and v-else
        // 允许 在 root 节点上
        // <template>
        //  <div v-if></div>
        //  <div v-else-if></div>
        //  <div v-else></div>
        // </template>
        if (root.if && (element.elseif || element.else)) {
          checkRootConstraints(element)
          addIfCondition(root, {
            exp: element.elseif,
            block: element
          })
        } else if (process.env.NODE_ENV !== 'production') {
          warnOnce(
            `Component template should contain exactly one root element. ` +
              `If you are using v-if on multiple elements, ` +
              `use v-else-if to chain them instead.`
          )
        }
      }

      if (currentParent && !element.forbidden) {
        if (element.elseif || element.else) {
          // 当前有设置 v-elseif 或是 v-else
          // 检查 prev child, 如果有设置 v-if,
          processIfConditions(element, currentParent)
        } else if (element.slotScope) {
          // scoped slot
          currentParent.plain = false
          const name = element.slotTarget || '"default"'
          ;(currentParent.scopedSlots || (currentParent.scopedSlots = {}))[name] = element
        } else {
          // 将当前处理的 element 放入 父 element 中
          currentParent.children.push(element)
          element.parent = currentParent
        }
      }
      // 不是以 /> 结尾的, 之后进行解析的就是 它的 child 了
      if (!unary) {
        currentParent = element
        stack.push(element)
      } else {
        closeElement(element)
      }
    },
    // 只有在匹配到 </tag> 时会触发
    end() {
      // remove trailing whitespace
      const element = stack[stack.length - 1]
      const lastNode = element.children[element.children.length - 1]
      // 将 whitespace child 移除
      if (lastNode && lastNode.type === 3 && lastNode.text === ' ' && !inPre) {
        element.children.pop()
      }
      // pop stack
      stack.length -= 1
      currentParent = stack[stack.length - 1]
      closeElement(element)
    },
    // 解析 > 之中的 </
    chars(text: string) {
      if (!currentParent) {
        if (process.env.NODE_ENV !== 'production') {
          if (text === template) {
            warnOnce('Component template requires a root element, rather than just text.')
          } else if ((text = text.trim())) {
            warnOnce(`text "${text}" outside root element will be ignored.`)
          }
        }
        return
      }
      // IE textarea placeholder bug
      /* istanbul ignore if */
      if (
        isIE &&
        currentParent.tag === 'textarea' &&
        currentParent.attrsMap.placeholder === text
      ) {
        return
      }
      const children = currentParent.children

      text =
        inPre || text.trim()
          ? isTextTag(currentParent)
            ? text
            : decodeHTMLCached(text)
          : // only preserve whitespace if its not right after a starting tag
            preserveWhitespace && children.length
            ? ' '
            : ''

      if (text) {
        let res
        if (!inVPre && text !== ' ' && (res = parseText(text, delimiters))) {
          // text-element
          children.push({
            type: 2,
            expression: res.expression,
            tokens: res.tokens,
            text
          })
        } else if (
          text !== ' ' ||
          !children.length ||
          children[children.length - 1].text !== ' '
        ) {
          // 直接渲染字符
          children.push({
            type: 3,
            text
          })
        }
      }
    },
    comment(text: string) {
      currentParent.children.push({
        type: 3,
        text,
        isComment: true
      })
    }
  })
  return root
}

function processPre(el) {
  if (getAndRemoveAttr(el, 'v-pre') != null) {
    el.pre = true
  }
}

/**
 * 将 attrs 的值设置为字符
 * @param {ASTElement} el
 */
function processRawAttrs(el) {
  const l = el.attrsList.length
  if (l) {
    const attrs = (el.attrs = new Array(l))
    for (let i = 0; i < l; i++) {
      attrs[i] = {
        name: el.attrsList[i].name,
        value: JSON.stringify(el.attrsList[i].value)
      }
    }
  } else if (!el.pre) {
    // non root node in pre blocks with no attributes
    el.plain = true
  }
}

/**
 *  el ->
 *    {
 *    ...el,
 *     key: exp,
 *
 *   }
 */
export function processElement(element: ASTElement, options: CompilerOptions) {
  processKey(element)
  // determine whether this is a plain element after
  // removing structural attributes
  // 只有 v-if, v-for 等 命令, 没有传入其他的 props
  // 如 : <custom-comp  v-if="bool" v-bind:key="" />
  element.plain = !element.key && !element.attrsList.length

  processRef(element)
  processSlot(element)
  processComponent(element)

  // transform
  // 比如 web/compiler/modules/ class | style
  // 这些会处理 额外的 attrs
  for (let i = 0; i < transforms.length; i++) {
    element = transforms[i](element, options) || element
  }
  // 处理到 attrs 中
  processAttrs(element)
}

function processKey(el) {
  const exp = getBindingAttr(el, 'key')
  if (exp) {
    if (process.env.NODE_ENV !== 'production' && el.tag === 'template') {
      warn(`<template> cannot be keyed. Place the key on real elements instead.`)
    }
    el.key = exp
  }
}

function processRef(el) {
  const ref = getBindingAttr(el, 'ref')
  if (ref) {
    el.ref = ref
    el.refInFor = checkInFor(el)
  }
}

/**
 * el: {
 *  attrsList: [{
 *      name: 'v-for',
 *      value: '(item, index) in ary'
 *  }]
 * }
 * @param {ASTElement} el
 */
export function processFor(el: ASTElement) {
  let exp
  if ((exp = getAndRemoveAttr(el, 'v-for'))) {
    const res = parseFor(exp)
    if (res) {
      extend(el, res)
    } else if (process.env.NODE_ENV !== 'production') {
      warn(`Invalid v-for expression: ${exp}`)
    }
  }
}

type ForParseResult = {
  for: string,
  alias: string,
  iterator1?: string,
  iterator2?: string
}

export function parseFor(exp: string): ?ForParseResult {
  const inMatch = exp.match(forAliasRE)
  if (!inMatch) return
  // 以上面的为例:  inMatch = [ "(item, index)", "ary"]
  const res = {}
  res.for = inMatch[2].trim()
  // 将 (item,index) 的 大括号移除
  const alias = inMatch[1].trim().replace(stripParensRE, '')

  // 匹配 [index]
  // 如果是这样 item, index, some
  // 则是 [index, some]
  const iteratorMatch = alias.match(forIteratorRE)
  if (iteratorMatch) {
    // alias = item
    res.alias = alias.replace(forIteratorRE, '').trim()
    // iteration1 = index
    res.iterator1 = iteratorMatch[1].trim()
    // 如果有 则是 some
    if (iteratorMatch[2]) {
      res.iterator2 = iteratorMatch[2].trim()
    }
  } else {
    // 直接返回 如 item in ary ,则返回 item
    res.alias = alias
  }
  return res
}

/**
 *  el: {
 *  attrsList: [ {
 *      name: 'v-if',
 *     value: 'ary'
 *    }]
 * }
 *
 * el ->
 *    {
 *    ...el,
 *    ifConditions: exp,
 *    else: Boolean,
 *     elseif: exp
 * }
 */

function processIf(el) {
  // exp = 'ary'
  const exp = getAndRemoveAttr(el, 'v-if')
  if (exp) {
    el.if = exp
    addIfCondition(el, {
      exp: exp,
      block: el
    })
  } else {
    if (getAndRemoveAttr(el, 'v-else') != null) {
      el.else = true
    }
    const elseif = getAndRemoveAttr(el, 'v-else-if')
    if (elseif) {
      el.elseif = elseif
    }
  }
}

function processIfConditions(el, parent) {
  const prev = findPrevElement(parent.children)
  if (prev && prev.if) {
    addIfCondition(prev, {
      exp: el.elseif,
      block: el
    })
  } else if (process.env.NODE_ENV !== 'production') {
    warn(
      `v-${el.elseif ? 'else-if="' + el.elseif + '"' : 'else'} ` +
        `used on element <${el.tag}> without corresponding v-if.`
    )
  }
}

function findPrevElement(children: Array<any>): ASTElement | void {
  let i = children.length
  while (i--) {
    if (children[i].type === 1) {
      return children[i]
    } else {
      if (process.env.NODE_ENV !== 'production' && children[i].text !== ' ') {
        warn(
          `text "${children[i].text.trim()}" between v-if and v-else(-if) ` +
            `will be ignored.`
        )
      }
      children.pop()
    }
  }
}

export function addIfCondition(el: ASTElement, condition: ASTIfCondition) {
  if (!el.ifConditions) {
    el.ifConditions = []
  }
  el.ifConditions.push(condition)
}
/**
 *
 * el -> {...el, once: Boolean}
 */
function processOnce(el) {
  const once = getAndRemoveAttr(el, 'v-once')
  if (once != null) {
    el.once = true
  }
}

/**
 *  el ->
 *   {...el,
 *    slotName: exp,   <slot name="header"
 *    slotScope: exp    <template scope,
 *    slotTarget: exp,   <tempalte slot="header"
 *    slot: slotTarget, 如果只是具名的 非 template 节点
 * }
 */
function processSlot(el) {
  if (el.tag === 'slot') {
    el.slotName = getBindingAttr(el, 'name')
    if (process.env.NODE_ENV !== 'production' && el.key) {
      warn(
        `\`key\` does not work on <slot> because slots are abstract outlets ` +
          `and can possibly expand into multiple elements. ` +
          `Use the key on a wrapping element instead.`
      )
    }
  } else {
    let slotScope
    if (el.tag === 'template') {
      // 如果是 template 可以使用  <template scope=""></template>
      slotScope = getAndRemoveAttr(el, 'scope')
      /* istanbul ignore if */
      if (process.env.NODE_ENV !== 'production' && slotScope) {
        warn(
          `the "scope" attribute for scoped slots have been deprecated and ` +
            `replaced by "slot-scope" since 2.5. The new "slot-scope" attribute ` +
            `can also be used on plain elements in addition to <template> to ` +
            `denote scoped slots.`,
          true
        )
      }

      // 也可以使用  <template slot-scope=""></template>
      el.slotScope = slotScope || getAndRemoveAttr(el, 'slot-scope')
    } else if ((slotScope = getAndRemoveAttr(el, 'slot-scope'))) {
      /* istanbul ignore if */
      if (process.env.NODE_ENV !== 'production' && el.attrsMap['v-for']) {
        warn(
          `Ambiguous combined usage of slot-scope and v-for on <${el.tag}> ` +
            `(v-for takes higher priority). Use a wrapper <template> for the ` +
            `scoped slot to make it clearer.`,
          true
        )
      }
      // 其他的tag , 则可以在节点上使用 <a slot-scope=""></a>
      el.slotScope = slotScope
    }
    const slotTarget = getBindingAttr(el, 'slot')
    // 给该 slot 设置一个目的地
    if (slotTarget) {
      // 默认是 default
      el.slotTarget = slotTarget === '""' ? '"default"' : slotTarget
      // preserve slot as an attribute for native shadow DOM compat
      // only for non-scoped slots.
      // 如果是 形如 <a slot="footer" ></a>
      if (el.tag !== 'template' && !el.slotScope) {
        addAttr(el, 'slot', slotTarget)
      }
    }
  }
}

/**
 *  el ->
 *    {...el,
 *    component: is's exp,
 *    inlineTemplate: Boolean
 *   }
 */
function processComponent(el) {
  let binding
  if ((binding = getBindingAttr(el, 'is'))) {
    el.component = binding
  }
  if (getAndRemoveAttr(el, 'inline-template') != null) {
    el.inlineTemplate = true
  }
}

/**
 *  el ->
 *         { ...el,
 *        hasBindings: Boolean,
 *        modifiers: exp
 *        events: [],
 *        attrs:[],
 *        directives: []
 *    }
 */

function processAttrs(el) {
  const list = el.attrsList
  let i, l, name, rawName, value, modifiers, isProp
  for (i = 0, l = list.length; i < l; i++) {
    name = rawName = list[i].name
    value = list[i].value
    if (dirRE.test(name)) {
      // mark element as dynamic
      el.hasBindings = true
      // modifiers
      // 如果形如 v-qwe.a.b.c
      // modifiers = {b:true, c: true}
      modifiers = parseModifiers(name)
      if (modifiers) {
        // name = v-qwe
        name = name.replace(modifierRE, '')
      }
      if (bindRE.test(name)) {
        // v-bind
        // name = qwe
        name = name.replace(bindRE, '')
        value = parseFilters(value)
        isProp = false
        if (process.env.NODE_ENV !== 'production' && value.trim().length === 0) {
          warn(
            `The value for a v-bind expression cannot be empty. Found in "v-bind:${name}"`
          )
        }
        if (modifiers) {
          // 如果该 modifiers 有 prop字段, 那么该attr 会添加到该 element 的root 组件上
          if (modifiers.prop) {
            isProp = true
            name = camelize(name)
            if (name === 'innerHtml') name = 'innerHTML'
          }
          // 将 qwe.q-w  转成 qwe.qW
          if (modifiers.camel) {
            name = camelize(name)
          }
          // 添加额外的 update: name 到 el.events 中
          // el ->
          //    {...el,
          //     events: [{ value: }]
          //
          // }
          if (modifiers.sync) {
            addHandler(el, `update:${camelize(name)}`, genAssignmentCode(value, `$event`))
          }
        }
        if (
          isProp ||
          (!el.component && platformMustUseProp(el.tag, el.attrsMap.type, name))
        ) {
          addProp(el, name, value)
        } else {
          // (el.attrs = []).push({name, value})
          addAttr(el, name, value)
        }
      } else if (onRE.test(name)) {
        // v-on
        // 添加到 events 中
        name = name.replace(onRE, '')
        addHandler(el, name, value, modifiers, false, warn)
      } else {
        // 以 v-qwe , v-bind.prop 等形式的
        //  这样的形式的, 即是 directive
        // normal directives
        // name = qwe
        name = name.replace(dirRE, '')
        // parse arg
        // 如果是  qwe:ee
        // argMatch = [ee]
        const argMatch = name.match(argRE)
        const arg = argMatch && argMatch[1]
        if (arg) {
          // 如果是 qwe:ee
          // "qwe.ee"slice(0, -3) 会是:
          // qwe
          name = name.slice(0, -(arg.length + 1))
        }
        addDirective(el, name, rawName, value, arg, modifiers)
        if (process.env.NODE_ENV !== 'production' && name === 'model') {
          checkForAliasModel(el, value)
        }
      }
    } else {
      //   字面量 props
      // literal attribute
      if (process.env.NODE_ENV !== 'production') {
        const res = parseText(value, delimiters)
        if (res) {
          warn(
            `${name}="${value}": ` +
              'Interpolation inside attributes has been removed. ' +
              'Use v-bind or the colon shorthand instead. For example, ' +
              'instead of <div id="{{ val }}">, use <div :id="val">.'
          )
        }
      }
      // \"value\"
      addAttr(el, name, JSON.stringify(value))
      // #6887 firefox doesn't update muted state if set via attribute
      // even immediately after element creation
      if (
        !el.component &&
        name === 'muted' &&
        platformMustUseProp(el.tag, el.attrsMap.type, name)
      ) {
        addProp(el, name, 'true')
      }
    }
  }
}

function checkInFor(el: ASTElement): boolean {
  let parent = el
  while (parent) {
    if (parent.for !== undefined) {
      return true
    }
    parent = parent.parent
  }
  return false
}

/**
 *  a.b.c -> {
 *     b: true,
 *     c: true
 *   }
 */
function parseModifiers(name: string): Object | void {
  const match = name.match(modifierRE)
  if (match) {
    const ret = {}
    match.forEach(m => {
      ret[m.slice(1)] = true
    })
    return ret
  }
}

function makeAttrsMap(attrs: Array<Object>): Object {
  const map = {}
  for (let i = 0, l = attrs.length; i < l; i++) {
    if (process.env.NODE_ENV !== 'production' && map[attrs[i].name] && !isIE && !isEdge) {
      warn('duplicate attribute: ' + attrs[i].name)
    }
    map[attrs[i].name] = attrs[i].value
  }
  return map
}

// for script (e.g. type="x/template") or style, do not decode content
function isTextTag(el): boolean {
  return el.tag === 'script' || el.tag === 'style'
}

function isForbiddenTag(el): boolean {
  return (
    el.tag === 'style' ||
    (el.tag === 'script' && (!el.attrsMap.type || el.attrsMap.type === 'text/javascript'))
  )
}

const ieNSBug = /^xmlns:NS\d+/
const ieNSPrefix = /^NS\d+:/

/* istanbul ignore next */
function guardIESVGBug(attrs) {
  const res = []
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i]
    if (!ieNSBug.test(attr.name)) {
      attr.name = attr.name.replace(ieNSPrefix, '')
      res.push(attr)
    }
  }
  return res
}

function checkForAliasModel(el, value) {
  let _el = el
  while (_el) {
    if (_el.for && _el.alias === value) {
      warn(
        `<${el.tag} v-model="${value}">: ` +
          `You are binding v-model directly to a v-for iteration alias. ` +
          `This will not be able to modify the v-for source array because ` +
          `writing to the alias is like modifying a function local variable. ` +
          `Consider using an array of objects and use v-model on an object property instead.`
      )
    }
    _el = _el.parent
  }
}
