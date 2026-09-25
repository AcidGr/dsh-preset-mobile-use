import assert from "node:assert/strict";
import { findTargetCoordinates } from "./preset/mobile-use/mobile_plugin.js";

const mockDump = `
status display=3 1080x2400 420dpi mode=background
id type label bounds flags extra
1 DecorView 0,0,1080,2400
146 Button "搜索" 100,200,300,400 c id=search_btn
147 TextView "热搜条目" 110,210,290,390 target=146@200,300
148 Button "10,20,30,40" 10,20,110,120 c
149 View -50,100,50,300 c
150 Button "引号 \\"包含\\" 字符" 500,600,700,800 c
`;

// 1. Direct node bounds center calculation: (100+300)/2=200, (200+400)/2=300
const res146 = findTargetCoordinates(mockDump, 146);
assert.deepEqual(res146, { x: 200, y: 300, id: "146" });

// 2. String target with 'node:' prefix
const resNode146 = findTargetCoordinates(mockDump, "node:146");
assert.deepEqual(resNode146, { x: 200, y: 300, id: "146" });

// 3. Ancestor target resolution: inherits target=146@200,300
const res147 = findTargetCoordinates(mockDump, "147");
assert.deepEqual(res147, { x: 200, y: 300, id: "147" });

// 4. Quoted text containing commas/numbers does not confuse bounds parser
const res148 = findTargetCoordinates(mockDump, 148);
assert.deepEqual(res148, { x: 60, y: 70, id: "148" });

// 5. Negative coordinate handling: (-50+50)/2=0, (100+300)/2=200
const res149 = findTargetCoordinates(mockDump, "149");
assert.deepEqual(res149, { x: 0, y: 200, id: "149" });

// 6. Escaped quotes in label
const res150 = findTargetCoordinates(mockDump, "150");
assert.deepEqual(res150, { x: 600, y: 700, id: "150" });

// 7. Non-existent target returns null
assert.equal(findTargetCoordinates(mockDump, "999"), null);

// 8. Invalid target formats return null
assert.equal(findTargetCoordinates(mockDump, null), null);
assert.equal(findTargetCoordinates(mockDump, ""), null);
assert.equal(findTargetCoordinates(mockDump, "abc"), null);

console.log("ALL 8 TARGET RESOLUTION TESTS PASSED");
