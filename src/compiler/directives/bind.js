/* @flow */

export default function bind(el: ASTElement, dir: ASTDirective) {
  el.wrapData = (code: string) => {
    // -b -> bindObjectProps
    // data, tag, ...
    return `_b(${code},'${el.tag}',${dir.value},${
      dir.modifiers && dir.modifiers.prop ? 'true' : 'false'
    }${dir.modifiers && dir.modifiers.sync ? ',true' : ''})`
  }
}
