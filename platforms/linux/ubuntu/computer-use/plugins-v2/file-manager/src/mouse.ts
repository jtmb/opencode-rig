/**
 * Mouse events can be hit-tested to a row container or to one of its text
 * children depending on the terminal renderable, and they bubble up the tree.
 * Mark the first activation so exactly one handler acts per physical click.
 */
export interface MouseActivation {
  button?: number
  preventDefault?: () => void
  __rigHandled?: boolean
}

/** Returns true for the first left-button activation of an event, false otherwise. */
export function consumeMouseActivation(event: MouseActivation): boolean {
  if (event.__rigHandled) return false
  event.__rigHandled = true
  return event.button === undefined || event.button === 0
}
