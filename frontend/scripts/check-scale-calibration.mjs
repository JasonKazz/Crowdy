import assert from "node:assert/strict";
import {calibrationPreview, measurementPoint} from "../src/lib/scale-calibration.ts";

const image={width_px:2000,height_px:1200};
const start={x:100,y:100},end={x:600,y:100};
const preview=(distance,unit="m",a=start,b=end,source=image)=>calibrationPreview(source,a,b,distance,unit);
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} should equal ${expected}`);

// The same measured wall must produce the same physical image size in every unit.
for(const [distance,unit] of [[10,"m"],[1000,"cm"],[10000,"mm"],[10/.3048,"ft"],[10/.0254,"in"]]){
  const result=preview(distance,unit);
  assert.equal(result.ok,true);
  close(result.meters_per_pixel,.02);
  close(result.width_m,40);
  close(result.height_m,24);
}
const diagonal=preview(10,"m",{x:10,y:10},{x:310,y:410});
assert.equal(diagonal.ok,true);
close(diagonal.width_m,40);

// Full-image-width calibration includes the margins and preserves aspect ratio.
const fullWidth=preview(80,"m",{x:0,y:0},{x:image.width_px,y:0});
assert.equal(fullWidth.ok,true);
close(fullWidth.width_m,80);
close(fullWidth.height_m,48);

assert.equal(measurementPoint({x:"",y:"0"}),undefined);
assert.equal(measurementPoint({x:"0",y:" "}),undefined);
assert.deepEqual(measurementPoint({x:"0",y:"0"}),{x:0,y:0});
assert.equal(calibrationPreview(image,measurementPoint({x:"100",y:""}),end,10,"m").ok,false);
for(const point of [{x:-1,y:10},{x:2001,y:10},{x:10,y:1201},{x:NaN,y:10},{x:Infinity,y:10}])
  assert.match(preview(10,"m",point).reason,/inside/);
for(const point of [start,{x:104.99,y:100}])assert.match(preview(10,"m",start,point).reason,/5 pixels/);
assert.equal(preview(1,"m",start,{x:105,y:100}).ok,true,"Five pixels is the backend's inclusive minimum span.");
for(const distance of [0,-1,NaN,Infinity,-Infinity])assert.equal(preview(distance).ok,false);
for(const unit of ["yards","toString","__proto__"])assert.equal(preview(10,unit).ok,false);
assert.equal(preview(Number.MAX_VALUE).ok,false,"Overflowing physical dimensions cannot be submitted.");
assert.equal(preview(251).ok,false,"The longest physical image dimension must not exceed 1000 m.");
assert.equal(preview(250).ok,true);
assert.equal(preview(800,"m",{x:0,y:0},{x:1200,y:0},{width_px:1200,height_px:2000}).ok,false,
  "A valid-looking full width must also respect the height limit for portrait images.");
for(const source of [{width_px:0,height_px:1200},{width_px:NaN,height_px:1200}])assert.equal(preview(10,"m",start,end,source).ok,false);
console.log("Scale calibration checks passed: unit conversion, diagonal measurement, full-image dimensions, incomplete inputs, endpoint bounds, minimum span, finite lengths, and service scale limits.");
