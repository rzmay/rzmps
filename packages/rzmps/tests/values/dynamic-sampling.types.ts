import { Color, Vector3 } from 'three';
import sampleDynamicValue from '../../src/values/sampleDynamicValue';
import maxDynamicNumber from '../../src/values/maxDynamicNumber';
import minDynamicNumber from '../../src/values/minDynamicNumber';
import maxDynamicVector from '../../src/values/maxDynamicVector';
import minDynamicVector from '../../src/values/minDynamicVector';
import maxDynamicColor from '../../src/values/maxDynamicColor';
import minDynamicColor from '../../src/values/minDynamicColor';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
const longest = sampleDynamicValue(new Set(['short', 'longest']), (a,b) => a.length>b.length?a:b);
export type SampledString = Expect<Equal<typeof longest, string | undefined>>;
const converted = sampleDynamicValue(new Set(['2', '3']), Math.max, 16, Number);
export type ConvertedNumber = Expect<Equal<typeof converted, number | undefined>>;
const numbers: number[] = [maxDynamicNumber(() => [-2, 3]), minDynamicNumber(new Set([2, 3]))];
const vectors: Vector3[] = [maxDynamicVector(() => [2, new Vector3()]), minDynamicVector(2)];
const colors: Color[] = [maxDynamicColor(() => new Set(['red', 'blue'])), minDynamicColor(0xff0000)];
void [numbers, vectors, colors];
