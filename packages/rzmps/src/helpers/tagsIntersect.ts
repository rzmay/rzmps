import { Tag } from "../types/Tag";

export default function tagsIntersect(a: Tag[], b: Tag[]) {
  const intersection = new Set(a).intersection(new Set(b));
  return intersection.size !== 0;
}
