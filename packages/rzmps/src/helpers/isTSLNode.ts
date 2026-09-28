export default function isTSLNode(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'isNode' in value);
}
