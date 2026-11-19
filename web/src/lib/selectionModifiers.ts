/** Shared by canvas hits and the two trees; drag constraints remain independent. */
export function isAdditiveSelection(event: {
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}): boolean {
  return event.shiftKey || event.ctrlKey || event.metaKey
}
