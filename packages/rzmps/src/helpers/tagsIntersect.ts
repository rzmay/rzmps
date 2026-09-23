import type { Tag } from "../types/Tag";

export default function tagsIntersect(a: Tag[], b: Tag[]) {
  for (let i = 0; i < a.length; i += 1) {
    if (b.includes(a[i])) return true;
  }

  return false;
}
