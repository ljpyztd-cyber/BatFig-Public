import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

function inspect(path: string) {
  const source = ts.createSourceFile(path, readFileSync(resolve(process.cwd(), 'src', path), 'utf8'), ts.ScriptTarget.Latest, true)
  const imported: string[] = []
  const calls: string[] = []
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /(?:^|\/)namedSave$/.test(node.moduleSpecifier.text)) {
      const names = node.importClause?.namedBindings
      if (names && ts.isNamedImports(names)) imported.push(...names.elements.map((name) => name.name.text))
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node.expression.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { imported, calls }
}

describe('native close and browser unload use the same named-file predicate', () => {
  it.each(['lib/closeGuard.ts', 'store/documentStore.ts'])('%s imports and calls the shared predicate', (path) => {
    const { imported, calls } = inspect(path)
    expect(imported).toContain('hasPendingDocumentChanges')
    expect(calls).toContain('hasPendingDocumentChanges')
  })
})
