export type GenerationToken = {
  key: string
  value: number
}

export function beginGeneration(generations: Map<string, number>, key: string): GenerationToken {
  const value = (generations.get(key) ?? 0) + 1
  generations.set(key, value)
  return { key, value }
}

export function isCurrentGeneration(generations: ReadonlyMap<string, number>, token: GenerationToken): boolean {
  return generations.get(token.key) === token.value
}

export function invalidateGeneration(generations: Map<string, number>, key: string): GenerationToken {
  return beginGeneration(generations, key)
}
