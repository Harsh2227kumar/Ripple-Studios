/*
 * Ripple Studios — loader shaders.
 *
 * Three passes:
 *  scene  ray-marched splash, rendered at reduced resolution into a half-float target
 *         (linear colour in rgb, hit distance in alpha)
 *  bloom  bright-pass + downsample of the scene
 *  post   depth of field, bloom, filmic shoulder, vignette, the wordmark, grain
 *
 * Colours are calibrated in sRGB against the reference footage and converted to linear light
 * when they are read, so lighting maths (Fresnel, coverage, motion blur) happens in linear.
 * The post shoulder is the identity below the calibrated range, so the grade is unchanged.
 */
window.RIPPLE_SHADERS = {
  vert: /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`,

  /* ================================================================== scene */
  scene: /* glsl */ `#version 300 es
precision highp float;
precision highp int;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform float uTanH;
uniform float uShift;     // vertical framing offset (portrait screens)
uniform int   uQ;         // quality tier: 0 low, 1 mid, 2 high
uniform float uEnc;       // 1 = 8-bit target: gamma-encode colour and normalise depth
// Always 0. Added to every loop bound so the bounds aren't compile-time constants: otherwise
// the Direct3D shader compiler on Windows unrolls everything and takes ~45 s, freezing the GPU.
uniform int   uZ;

uniform vec4  uImp[2];    // xy: impact xz, z: t0, w: strength (0 = inactive)
uniform vec4  uCrown[2];  // x: base radius, y: sheet height, z: finger length, w: scale (0 = off)
uniform vec4  uCrownB[2]; // x: thickness, y: tip bead radius, z: flare, w: crater depth
uniform vec4  uJet[2];    // x: height, y: radius, z: bulb radius, w: scale (0 = off)
uniform vec4  uBox[2];    // x: radius, y: top  (bounding box of crown + jet, x = 0 -> none)
uniform vec4  uArmA[14];  // crown arms: xy tip (radial, height), z: thickness, w: angle jitter
uniform vec4  uArmB[14];  // x: tip bead radius, y: how much of the arm is still unbroken (0..1)
uniform vec4  uSph[64];   // xyz centre, w radius
uniform vec4  uSphV[64];  // xyz: half the distance travelled while the shutter is open
uniform int   uSphN;
uniform vec4  uDrip[24];  // xy: landing point, z: time, w: strength  (spray falling back)
uniform sampler2D uSim;   // live wave-equation height field (pointer ripples)
uniform vec4  uSimBox;    // xy: world xz of the sim's corner, z: size, w: 1 = on
uniform int   uDripN;

const vec3  CAM    = vec3(0.0, 3.45, 13.83);
const float PITCH  = 0.2147;           // 12.3 deg down
const float ZFAR   = -10.7;            // far edge of the water
const float FOCUS  = 14.25;
// seamless backdrop: picks up the water's brightest tone at the edge and eases cooler upward
const vec3  SKY_LO = vec3(196.0, 201.0, 214.0) / 255.0;
const vec3  SKY_HI = vec3(184.0, 190.0, 204.0) / 255.0;
const vec3  STUDIO = vec3(22.0, 26.0, 32.0) / 255.0;
const float NF     = 14.0;
const float PI     = 3.14159265;

vec3 toLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 toGam(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }

/* ---------------------------------------------------------------- environment */

// Reflected colour by elevation (deg). Stops measured row-by-row from the footage (sRGB).
// Written as a sum of clamped ramps (same piecewise-linear curve as a lookup table), because a
// constant table is rebuilt at every call site by the Windows shader compiler and slows it a lot.
vec3 envBase(float e) {
  vec3 c = vec3(214.0, 217.0, 228.0);
  c += vec3(-12.0, -11.0, -8.0) * clamp((e - 0.0) / 5.0000, 0.0, 1.0);
  c += vec3(-12.0, -11.0, -10.0) * clamp((e - 5.0) / 3.3700, 0.0, 1.0);
  c += vec3(-17.0, -15.0, -13.0) * clamp((e - 8.37) / 1.5400, 0.0, 1.0);
  c += vec3(-28.0, -26.0, -23.0) * clamp((e - 9.91) / 2.1500, 0.0, 1.0);
  c += vec3(-34.0, -33.0, -31.0) * clamp((e - 12.06) / 2.3900, 0.0, 1.0);
  c += vec3(-32.0, -33.0, -38.0) * clamp((e - 14.45) / 2.3800, 0.0, 1.0);
  c += vec3(-26.0, -28.0, -33.0) * clamp((e - 16.83) / 2.3600, 0.0, 1.0);
  c += vec3(-11.0, -10.0, -12.0) * clamp((e - 19.19) / 1.4100, 0.0, 1.0);
  c += vec3(-15.0, -17.0, -19.0) * clamp((e - 20.6) / 9.4000, 0.0, 1.0);
  c += vec3(-9.0, -11.0, -13.0) * clamp((e - 30.0) / 20.0000, 0.0, 1.0);
  return c / 255.0;
}

// The soft light lives behind the scene; anything facing back toward camera sees a dark studio.
vec3 envS(vec3 d) {
  float e = degrees(asin(clamp(d.y, -1.0, 1.0)));
  vec3 c = envBase(abs(e));
  if (e < 0.0) c *= 0.8;
  float hl = max(length(d.xz), 1e-4);
  float fwd = -d.z / hl;
  float lat = d.x / hl;
  c *= 1.0 - 0.32 * clamp(lat, -1.0, 1.0) * smoothstep(0.0, 0.5, fwd);
  return mix(STUDIO, c, smoothstep(-0.15, 0.75, fwd));
}
vec3 env(vec3 d) { return toLin(envS(d)); }

// Two softboxes behind the splash. Only glossy splash surfaces see them (the calibrated water
// gradient already contains their soft glow), so they give the drops their window-shaped glints.
float panel(vec2 a, vec2 c, vec2 hs) {
  vec2 q = abs(a - c) / hs - 1.0;
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  return 1.0 - smoothstep(-0.35, 0.25, sd);
}
vec3 studio(vec3 d) {
  vec2 a = vec2(atan(d.x, -d.z), atan(d.y, length(d.xz)));
  return vec3(1.0, 0.97, 0.93) * 7.0 * panel(a, vec2(-0.57, 0.58), vec2(0.13, 0.085))
       + vec3(0.92, 0.96, 1.0) * 2.2 * panel(a, vec2(0.62, 0.34), vec2(0.08, 0.15));
}

float hitWater(vec3 ro, vec3 rd);
vec3 waterN(vec2 xz, float e);

vec3 skyS(vec3 d) {
  float e = degrees(asin(clamp(d.y, -1.0, 1.0)));
  vec3 c = mix(SKY_LO, SKY_HI, smoothstep(-9.5, 6.0, e));
  float lat = d.x / max(length(d.xz), 1e-3);
  return c * (1.0 - 0.18 * clamp(lat, -1.0, 1.0));
}

// What light refracted through water sees: flat water, or the dim studio wall beyond the tank.
// (The bright backdrop on screen is a soft seamless sweep; the wall behind it is mid-grey,
// which is what keeps drops and the jet dark-bodied with bright rims, as in the footage.)
const vec3 WALL = vec3(112.0, 117.0, 128.0) / 255.0;
vec3 wallCol(vec3 d);
vec3 bgCol(vec3 p, vec3 d) {
  // the water and the wall behind it meet in a soft band, not a hard line: a drop is a tiny
  // lens that squeezes the whole horizon into a few pixels, so any hard edge shows as a crease
  float w = smoothstep(0.03, -0.09, d.y);
  vec3 c = wallCol(d);
  if (w > 0.0) c = mix(c, env(reflect(d, vec3(0.0, 1.0, 0.0))), w);
  return c;
}
vec3 wallCol(vec3 d) {
  float f = -d.z / max(length(d.xz), 1e-3);
  float e = degrees(asin(clamp(d.y, -1.0, 1.0)));
  vec3 wall = WALL * (1.0 - 0.18 * clamp(d.x / max(length(d.xz), 1e-3), -1.0, 1.0));
  wall = mix(wall, STUDIO, smoothstep(10.0, 40.0, e));
  return toLin(mix(STUDIO, wall, smoothstep(-0.2, 0.6, f)));
}

/* ---------------------------------------------------------------- water surface */

float tScale(float s) { return 0.5 + 0.5 * s; }

float ripple(float r, float tw, float s, float k) {
  if (tw <= 0.0) return 0.0;
  float d = 1.1 * tw + 0.7 * s - r;
  if (d <= 0.0) return 0.0;
  float en = smoothstep(0.0, 0.45, d) * (0.15 + 0.85 * exp(-d * 0.75));
  float amp = s * 0.0075 / (0.5 + 0.4 * r) * exp(-tw * 0.32);
  // capillary dispersion: the short waves run out ahead of the long ones
  float ph = k * (d + 0.175 * (1.0 - exp(-d / 0.35)));
  return amp * en * sin(ph);
}

float waterH(vec2 xz) {
  float h = 0.0;
  for (int i = 0; i < 2 + uZ; i++) {
    vec4 im = uImp[i];
    if (im.w <= 0.0) continue;
    float tr = uTime - im.z;
    if (tr < 0.0) continue;
    float s = im.w;
    float tau = tr / tScale(s);
    float r = length(xz - im.xy);
    float Rc = s * (0.28 + 0.42 * (1.0 - exp(-tau / 0.15)) + 0.25 * min(tau, 1.2));
    float D = s * 0.5 * smoothstep(0.0, 0.16, tau) * (1.0 - smoothstep(0.75, 1.5, tau));
    float x = r / Rc;
    float x2 = x * x;
    h -= D * exp(-x2 * x2 * 1.4);
    float rimH = s * 0.06 * smoothstep(0.0, 0.08, tau) * (1.0 - smoothstep(0.5, 1.3, tau));
    float dr = (r - Rc) / (0.05 + 0.12 * s);
    h += rimH * exp(-dr * dr);
    // real rings are never perfect circles: a slow angular wobble that grows as they travel
    vec2 dv = xz - im.xy;
    float a = atan(dv.y, dv.x);
    // (zero at the centre, where an angular term would pinch the rings into a seam; and the radius
    // is rounded off at r = 0 so the rings' middle is a smooth dome, not a sharp point)
    float rs = sqrt(r * r + 0.0036);
    float rw = rs + 0.032 * r * smoothstep(0.4, 1.6, r) * (sin(3.0 * a + 1.1) * 0.6 + sin(7.0 * a + 2.3) * 0.3 + sin(12.0 * a + 0.4) * 0.15);
    h += ripple(rw, tr - 0.35, s, 15.7) + ripple(rw, tr - 1.2, 0.35 * s, 18.0);
  }
  return h;
}

// Tiny rings where spray and finger beads fall back. Too small to matter for the
// height-field search, so they only perturb the normal.
float dripH(vec2 xz) {
  float h = 0.0;
  for (int i = 0; i < 24 + uZ; i++) {
    if (i >= uDripN) break;
    vec4 dp = uDrip[i];
    float tw = uTime - dp.z;
    if (tw <= 0.0 || tw > 1.8) continue;
    float r = length(xz - dp.xy);
    float d = 0.3 * tw + 0.02 - r;
    if (d <= 0.0 || d > 0.5) continue;
    float en = smoothstep(0.0, 0.05, d) * exp(-d * 6.0);
    float amp = dp.w * exp(-tw * 1.8) / (1.0 + 10.0 * r);
    h += amp * en * sin(34.0 * (d + 0.05 * (1.0 - exp(-d / 0.1))));
  }
  return h;
}

float surfH(vec2 xz) { return waterH(xz) + dripH(xz); }

// slope of the simulated waves, by central differences one cell apart
vec2 simSlope(vec2 xz) {
  if (uSimBox.w <= 0.0) return vec2(0.0);
  vec2 uv = (xz - uSimBox.xy) / uSimBox.z;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec2(0.0);
  float c = 1.0 / 320.0, dw = 2.0 * c * uSimBox.z;
  // explicit LOD: no derivatives needed, so the D3D compiler isn't forced to unroll callers
  return vec2(textureLod(uSim, uv + vec2(c, 0.0), 0.0).r - textureLod(uSim, uv - vec2(c, 0.0), 0.0).r,
              textureLod(uSim, uv + vec2(0.0, c), 0.0).r - textureLod(uSim, uv - vec2(0.0, c), 0.0).r) / dw;
}

vec3 waterN(vec2 xz, float e) {
  // central differences, written as a loop so the heavy height function is compiled once
  vec2 g = vec2(0.0);
  for (int i = 0; i < 4 + uZ; i++) {
    vec2 ax = i < 2 ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    float sg = (i == 0 || i == 2) ? 1.0 : -1.0;
    g += ax * sg * surfH(xz + ax * sg * e);
  }
  g = g / (2.0 * e) + simSlope(xz);
  return normalize(vec3(-g.x, 1.0, -g.y));
}

bool craterNear(vec2 xz) {
  for (int i = 0; i < 2 + uZ; i++) {
    vec4 im = uImp[i];
    if (im.w <= 0.0) continue;
    float tr = uTime - im.z;
    if (tr < 0.0) continue;
    float tau = tr / tScale(im.w);
    if (tau > 1.6) continue;
    if (length(xz - im.xy) < im.w * 2.4 + 0.4) return true;
  }
  return false;
}

// Plane hit everywhere; a proper height-field search only around an open crater.
float hitWater(vec3 ro, vec3 rd) {
  float tp = -ro.y / rd.y;
  vec3 p = ro + rd * tp;
  if (!craterNear(p.xz)) return tp;
  float t0 = max((0.15 - ro.y) / rd.y, 0.0);
  float t1 = (-0.7 - ro.y) / rd.y;
  float dt = (t1 - t0) / 56.0;
  float ta = t0;
  for (int i = 0; i < 56 + uZ; i++) {
    float tb = ta + dt;
    vec3 q = ro + rd * tb;
    if (q.y - waterH(q.xz) < 0.0) {
      for (int j = 0; j < 6 + uZ; j++) {
        float tm = 0.5 * (ta + tb);
        vec3 m = ro + rd * tm;
        if (m.y - waterH(m.xz) < 0.0) tb = tm; else ta = tm;
      }
      return 0.5 * (ta + tb);
    }
    ta = tb;
  }
  return t1;
}

/* ---------------------------------------------------------------- splash SDFs */

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float sdSeg2(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float sdTaper(vec3 p, vec3 a, vec3 b, float ra, float rb) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - mix(ra, rb, h);
}

// scalloped, slightly uneven rim: lobes peak where the fingers rise
float crownTop(int i, float ang) {
  return uCrown[i].y * (0.8 + 0.06 * sin(ang * 3.0 + 0.4) + 0.045 * sin(ang * 5.0 + 2.1)
                        + 0.03 * sin(ang * 8.0 + 4.3) + 0.12 * cos(NF * (ang + PI) - PI));
}

float sheetSDF(vec3 p, int i) {
  vec4 c = uCrown[i];
  if (c.w <= 0.0) return 1e5;
  float ang = atan(p.z, p.x);
  float top = crownTop(i, ang);
  if (top <= 0.004) return 1e5;
  float q = length(p.xz);
  float u = clamp(p.y / top, 0.0, 1.0);
  float th = uCrownB[i].x * (1.0 + 0.3 * sin(ang * 4.0 + 1.3) * sin(ang * 2.0 + 0.2));
  // thin wall, gathering into a thicker beaded rim along its top edge
  float rim = smoothstep(0.72, 1.0, u) * (0.9 + 0.35 * sin(ang * 23.0 + 1.7));
  return sdSeg2(vec2(q, p.y), vec2(c.x, -0.1 * c.w), vec2(c.x + top * uCrownB[i].z, top)) - th * (mix(1.0, 0.45, u) + rim);
}

float crownSDF(vec3 p, int i) {
  vec4 c = uCrown[i];
  if (c.w <= 0.0) return 1e5;
  float Rb = c.x, sc = c.w;
  float fl = uCrownB[i].z;
  float ang = atan(p.z, p.x);
  float d = sheetSDF(p, i);
  float a = 2.0 * PI / NF;
  float cell = floor((ang + PI) / a);
  for (int k = -1; k <= 1 + uZ; k++) {
    float ci = mod(cell + float(k), NF);
    int fi = int(ci);
    vec4 A = uArmA[fi], Bq = uArmB[fi];
    float u1 = Bq.y;
    if (u1 <= 0.0) continue;
    float ac = -PI + (ci + 0.5) * a + A.w;
    float ca = cos(ac), sa = sin(ac);
    vec3 lp = vec3(ca * p.x + sa * p.z, p.y, -sa * p.x + ca * p.z);
    float tc = crownTop(i, ac);
    vec2 b = vec2(Rb + tc * fl, tc - 0.02 * sc);
    vec2 dv = A.xy - b;
    if (dot(dv, dv) < 1e-4) continue;
    // a ligament flung from the rim lobe: a quadratic curve bowed inward-up, out to its tip
    vec2 cc = 0.5 * (b + A.xy) + vec2(-dv.y, dv.x) * 0.35;
    float th = A.z * sc;
    // three tapered segments along the curve, built incrementally (no local arrays)
    vec3 B3 = vec3(b, 0.0), E3 = B3, P0 = B3;
    float r0 = 0.032 * th, df = 1e5;
    for (int j = 1; j < 4 + uZ; j++) {
      float u = u1 * float(j) / 3.0, v = 1.0 - u;
      vec3 P1 = vec3(v * v * b + 2.0 * u * v * cc + u * u * A.xy, 0.0);
      float r1 = mix(0.032, 0.008, u) * th;
      df = min(df, sdTaper(lp, P0, P1, r0, r1));
      P0 = P1; r0 = r1; E3 = P1;
    }
    df -= 0.004 * th * sin(length(lp - B3) * 55.0 / sc + A.w * 40.0);    // uneven beading
    if (Bq.x > 0.0) df = smin(df, length(lp - E3) - Bq.x, 0.015 * sc);
    d = smin(d, df, 0.03 * sc);
  }
  return d;
}

float jetSDF(vec3 p, int i) {
  vec4 j = uJet[i];
  if (j.w <= 0.0) return 1e5;
  float H = j.x, rj = j.y, rb = j.z, sc = j.w;
  float q = length(p.xz);
  float y = p.y;
  float yb = -uCrownB[i].w;                       // crater floor under the jet
  // conical base flowing into the crater, then an irregular pearl-chain column (Rayleigh-Plateau)
  float r = rj + 0.32 * sc * exp(-max(y - yb, 0.0) / (0.16 * sc));
  float chain = smoothstep(0.35 * H, 0.6 * H, y);
  float yy = (y - H) / sc;
  float ph = yy * 34.0 + 1.2 + 0.55 * sin(yy * 12.0 + 0.7);
  float amp = 0.45 * (0.8 + 0.35 * sin(yy * 9.0 + 2.0));
  r *= 1.0 + amp * chain * sin(ph);
  float d = max(q - r, y - H);
  d = max(d, yb - 0.05 - y);
  d = smin(d, length(p - vec3(0.0, H, 0.0)) - rb, 0.05 * sc);
  return d;
}

float mapObj(vec3 p) {
  float d = 1e5;
  for (int i = 0; i < 2 + uZ; i++) {
    if (uBox[i].x <= 0.0) continue;
    vec3 lp = p - vec3(uImp[i].x, 0.0, uImp[i].y);
    d = min(d, crownSDF(lp, i));
    d = min(d, jetSDF(lp, i));
  }
  return d;
}


vec3 tetra(int i) {
  return i == 0 ? vec3(1.0, -1.0, -1.0) : i == 1 ? vec3(-1.0, -1.0, 1.0) : i == 2 ? vec3(-1.0, 1.0, -1.0) : vec3(1.0);
}

// Sphere-trace the splash. cov < 1 on a near miss gives an anti-aliased silhouette.
// The same loop then takes four more SDF samples around the hit for the normal, so the
// (big) splash SDF is compiled exactly once.
bool marchObj(vec3 ro, vec3 rd, float tmax, float pixA, float tBase, out float tHit, out float cov, out vec3 nrm) {
  cov = 0.0;
  tHit = 0.0;
  nrm = vec3(0.0, 1.0, 0.0);
  float tn = 1e9, tf = -1e9;
  for (int i = 0; i < 2 + uZ; i++) {
    if (uBox[i].x <= 0.0) continue;
    vec3 c = vec3(uImp[i].x, 0.0, uImp[i].y);
    vec3 bmin = c + vec3(-uBox[i].x, -0.6, -uBox[i].x);
    vec3 bmax = c + vec3(uBox[i].x, uBox[i].y, uBox[i].x);
    vec3 inv = 1.0 / rd;
    vec3 ta = (bmin - ro) * inv, tb = (bmax - ro) * inv;
    vec3 t1 = min(ta, tb), t2 = max(ta, tb);
    float n = max(max(t1.x, t1.y), t1.z), f = min(min(t2.x, t2.y), t2.z);
    if (f > max(n, 0.0)) { tn = min(tn, max(n, 0.0)); tf = max(tf, f); }
  }
  if (tf < tn) return false;
  tf = min(tf, tmax);
  float t = tn;
  float best = 1e9, tb = 0.0;
  bool found = false;
  int ni = 0;
  vec3 ph = vec3(0.0), acc = vec3(0.0);
  const float e = 0.0015;
  for (int k = 0; k < 100 + uZ; k++) {
    if (!found && (t > tf || k >= 96)) {
      if (best >= 1.0) return false;
      tHit = tb; cov = 1.0 - best; ph = ro + rd * tb; found = true;
    }
    vec3 q = found ? ph + tetra(ni) * e : ro + rd * t;
    float d = mapObj(q);
    if (found) {
      acc += tetra(ni) * d;
      ni++;
      if (ni == 4) break;
      continue;
    }
    float px = (tBase + t) * pixA;
    float ratio = d / px;
    if (ratio < best) { best = ratio; tb = t; }
    if (d < 0.35 * px) { tHit = t; cov = 1.0; ph = ro + rd * t; found = true; continue; }
    t += max(d * 0.8, 0.002);
  }
  if (!found) return false;
  nrm = normalize(acc + vec3(0.0, 1e-6, 0.0));
  return true;
}

// Fraction of the shutter interval (s in [0,1]) during which a disc of radius r, moving
// from the origin of q along D, covers the ray. q, D lie in the plane perpendicular to the ray.
float sweep(vec3 q, vec3 D, float r) {
  float a = dot(D, D);
  float b = dot(q, D), c = dot(q, q) - r * r;
  float disc = b * b - a * c;
  if (disc <= 0.0) return 0.0;
  float sq = sqrt(disc);
  return clamp((b + sq) / a, 0.0, 1.0) - clamp((b - sq) / a, 0.0, 1.0);
}

// Drops and spray, motion-blurred analytically: each one is a sphere swept along its
// velocity for a 180-degree shutter at 24 fps, and coverage is the time it spends on the ray.
int hitSph(vec3 ro, vec3 rd, float tmax, float pixA, float tBase, out float tH, out float cov, out vec3 cen) {
  int best = -1;
  float bt = tmax;
  cov = 0.0;
  cen = vec3(0.0);
  for (int i = 0; i < 64 + uZ; i++) {
    if (i >= uSphN) break;
    vec4 s = uSph[i];
    vec3 m = s.xyz - ro;
    float tca = dot(m, rd);
    if (tca < 0.0) continue;
    vec3 h = uSphV[i].xyz;
    vec3 mp = m - rd * tca;
    vec3 hp = h - rd * dot(h, rd);
    float px = (tBase + tca) * pixA * 1.15;
    float hl = length(hp);
    float dist = length(mp);
    if (dist > s.w + px + hl) continue;
    float c;
    vec3 ce = s.xyz;
    if (hl < 0.25 * px) {
      c = smoothstep(s.w + px, s.w - px, dist);
    } else {
      vec3 q = hp - mp;            // the ray, relative to where the drop was when the shutter opened
      vec3 D = 2.0 * hp;
      c = 0.0;
      for (int j = 0; j < 3 + uZ; j++) c += sweep(q, D, max(s.w + 0.7 * px * float(1 - j), 0.0));
      c /= 3.0;
      float u = clamp(dot(q, D) / dot(D, D), 0.0, 1.0);
      ce = s.xyz - h + 2.0 * h * u;
    }
    if (c <= 0.002) continue;
    vec3 m2 = ce - ro;
    float tc2 = dot(m2, rd);
    float d2 = dot(m2, m2) - tc2 * tc2;
    float t = tc2 - sqrt(max(s.w * s.w - min(d2, s.w * s.w * 0.97), 0.0));
    if (t < bt) { bt = t; best = i; cov = c; cen = ce; }
  }
  tH = bt;
  return best;
}

/* ---------------------------------------------------------------- shading */


const vec3 TINT_DROP  = vec3(0.6121, 0.6994, 0.8323);   // (0.80, 0.85, 0.92) in linear
const vec3 TINT_JET   = vec3(0.3492, 0.4143, 0.5156);   // (0.62, 0.67, 0.74)
const vec3 TINT_SHEET = vec3(0.6994, 0.7550, 0.8323);   // (0.85, 0.88, 0.92)

vec3 glass(vec3 n, vec3 rd, vec3 trans) {
  float ci = clamp(dot(n, -rd), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - ci, 5.0);
  vec3 rr = reflect(rd, n);
  return mix(trans * TINT_DROP, env(rr), F) + studio(rr) * F;
}

// light refracted through the whole drop (enters, crosses, exits)
vec3 thruSphere(vec3 p, vec3 rd, vec3 n, vec4 s, float eta) {
  vec3 d1 = refract(rd, n, 1.0 / eta);
  vec3 m = p - s.xyz;
  float b = dot(m, d1);
  float c = dot(m, m) - s.w * s.w;
  vec3 pe = p + d1 * (-b + sqrt(max(b * b - c, 0.0)));
  vec3 ne = normalize(pe - s.xyz);
  vec3 d2 = refract(d1, -ne, eta);
  if (dot(d2, d2) < 0.01) d2 = reflect(d1, -ne);
  return bgCol(pe, d2);
}

vec3 shadeSphere(vec3 ro, vec3 rd, vec4 s, float t, bool disp) {
  vec3 p = ro + rd * t;
  vec3 n = normalize(p - s.xyz);
  // a touch of dispersion: red bends least, blue most (a loop, so it compiles to one trace)
  vec3 tr = vec3(0.0);
  int nc = disp ? 3 : 1;
  for (int c = 0; c < 3 + uZ; c++) {
    if (c >= nc) break;
    float eta = disp ? 1.326 + 0.008 * float(c) : 1.333;
    vec3 v = thruSphere(p, rd, n, s, eta);
    if (!disp) { tr = v; break; }
    tr += v * (c == 0 ? vec3(1.0, 0.0, 0.0) : c == 1 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));
  }
  return glass(n, rd, tr);
}

// splash sheets read darker than drops in the footage: they mostly refract the dark crater
float sheetness(vec3 p) {
  float ds = 1e5;
  for (int i = 0; i < 2 + uZ; i++) {
    if (uBox[i].x <= 0.0) continue;
    ds = min(ds, sheetSDF(p - vec3(uImp[i].x, 0.0, uImp[i].y), i));
  }
  return 1.0 - smoothstep(0.0, 0.02, ds);   // p is on the surface, so mapObj(p) ~ 0
}

// Splash surface shading, split as colour = A * trans + B so the light coming through the
// sheet (trans, along ray tro/trd) can be resolved later by the one shared water search.
// refl: seen in the water's mirror. Seen from below, what the splash reflects downward is the
// shadowed water right under it, not the bright open surface, so it reads dark as in the footage.
void shadeObj(vec3 p, vec3 rd, vec3 n, bool refl, out vec3 A, out vec3 B, out vec3 trd) {
  vec3 d1 = refract(rd, n, 1.0 / 1.33);
  vec3 d2 = normalize(rd + 2.2 * (d1 - rd));
  float sh = sheetness(p);
  // a thin sheet barely bends light: see straight through it, slightly dimmed
  d2 = normalize(mix(d2, normalize(rd + 0.25 * (d1 - rd)), sh));
  float ci = clamp(dot(n, -rd), 0.0, 1.0);
  float F = 0.04 + 0.96 * pow(1.0 - ci, 4.0);
  vec3 rr = reflect(rd, n);
  vec3 er = env(rr) * 1.23;
  vec3 tint = mix(TINT_JET, TINT_SHEET, sh);
  if (refl) { tint *= 0.45; if (rr.y < 0.0) er *= 0.25; }
  A = tint * (1.0 - F);
  B = er * F + studio(rr) * F;
  trd = d2;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * uRes.y);
  float sp = sin(PITCH), cp = cos(PITCH);
  vec3 fw = vec3(0.0, -sp, -cp), up = vec3(0.0, cp, -sp), rt = vec3(1.0, 0.0, 0.0);
  vec3 rd = normalize(fw + uTanH * (uv.x * rt + (uv.y + uShift) * up));
  vec3 ro = CAM;
  float pixA = 2.0 * uTanH / uRes.y;

  // the far edge of the water is a horizontal line on screen; soften it like the lens does
  vec3 e = normalize(vec3(0.0, -CAM.y, ZFAR - CAM.z));
  float edgeY = dot(e, up) / dot(e, fw) / uTanH - uShift;
  float ew = 0.17;                                  // very wide, so the edge melts into the backdrop
  float wMix = smoothstep(edgeY + ew, edgeY - ew, uv.y);

  vec3 sky = skyS(rd);
  vec3 col = toLin(sky);
  float depth = 60.0;
  float tw = 1e9;
  bool hasW = rd.y < -1e-4 && wMix > 0.0;
  vec3 wp = vec3(0.0), wr = vec3(0.0), wc = vec3(0.0);

  // The water is searched twice per pixel at most: w = 0 along the camera ray, w = 1 along the
  // ray that comes through a splash sheet. One loop = one compiled copy of the (heavy) water.
  // Light through the sheet enters the final colour linearly: col = X + Y * trans.
  vec3 qo = ro, qd = rd, Y = vec3(0.0);
  bool needT = false;
  for (int w = 0; w < 2 + uZ; w++) {
    bool on = w == 0 ? hasW : needT;
    vec3 h = vec3(0.0), n = vec3(0.0, 1.0, 0.0);
    float tq = 0.0;
    if (on) {
      tq = hitWater(qo, qd);
      h = qo + qd * max(tq, 0.0);
      // the post pass does the real depth of field; this only pre-filters ripples below a pixel
      float fe = w == 0 ? 0.006 + 0.012 * abs(tq - FOCUS) / FOCUS + tq * pixA * 0.5 : 0.01;
      n = waterN(h.xz, fe);
    }
    if (w == 1) {
      if (needT) col += Y * (h.z > ZFAR ? env(reflect(qd, n)) : bgCol(qo, qd));
      break;
    }
    if (hasW) {
      tw = tq; wp = h;
      wr = reflect(rd, n);
      wc = env(wr);
      if (wMix > 0.5) depth = tw;
    }

    // Pass 0: the splash mirrored in the water.  Pass 1: the splash seen directly.
    for (int pass = 0; pass < 2 + uZ; pass++) {
      bool refl = pass == 0;
      if (refl && !hasW) continue;
      vec3 o = refl ? wp + vec3(0.0, 0.004, 0.0) : ro;
      vec3 d = refl ? wr : rd;
      float tB = refl ? tw : 0.0;
      float tmax = refl ? 60.0 : tw;
      float k = refl ? 0.88 : 1.0;
      vec3 c = refl ? wc : col;

      float to, co;
      vec3 on2;
      bool ho = marchObj(o, d, tmax, pixA, tB, to, co, on2);
      vec3 Yp = vec3(0.0);
      bool deferT = false;
      if (ho) {
        vec3 A, Bc, trd;
        vec3 ph = o + d * to;
        shadeObj(ph, d, on2, refl, A, Bc, trd);
        // what shows through the sheet: real water (resolved below) or just the backdrop
        deferT = !refl && trd.y < -1e-3 && ph.y > -0.65;
        vec3 trans = deferT ? vec3(0.0) : bgCol(ph, trd);
        c = mix(c, A * trans + Bc, k * co);
        Yp = A * (k * co);
        if (deferT) { qo = ph; qd = trd; }
      } else to = 1e9;
      float ts, cs;
      vec3 cen;
      int si = hitSph(o, d, min(tmax, to), pixA, tB, ts, cs, cen);
      if (si >= 0) {
        c = mix(c, shadeSphere(o, d, vec4(cen, uSph[si].w), ts, !refl && uQ >= 1), k * cs);
        Yp *= 1.0 - k * cs;
      }

      if (refl) {
        // blend the far edge in display space, exactly as calibrated
        col = toLin(mix(sky, toGam(c), wMix));
      } else {
        col = c;
        Y = Yp;
        needT = deferT;
        if (ho && co > 0.5) depth = to;
        if (si >= 0 && cs > 0.5) depth = ts;
      }
    }
  }

  if (uEnc > 0.5) fragColor = vec4(sqrt(clamp(col, 0.0, 1.0)), depth / 64.0);
  else fragColor = vec4(col, depth);
}`,

  /* ================================================================== bloom */
  bloom: /* glsl */ `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uScene;
uniform vec2 uTexel;      // one scene texel
uniform vec2 uRes;        // bloom target size
uniform float uEnc;
vec3 S(vec2 uv) { vec3 c = texture(uScene, uv).rgb; return uEnc > 0.5 ? c * c : c; }
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  // four bilinear taps = a 4x4 box: a clean 4x downsample
  vec3 c = 0.25 * (S(uv + vec2(-1.0, -1.0) * uTexel) + S(uv + vec2(1.0, -1.0) * uTexel) +
                   S(uv + vec2(-1.0, 1.0) * uTexel) + S(uv + vec2(1.0, 1.0) * uTexel));
  float l = max(c.r, max(c.g, c.b));
  fragColor = vec4(c * smoothstep(0.78, 1.7, l), 1.0);
}`,

  /* ================================================================== post */
  post: /* glsl */ `#version 300 es
precision highp float;
precision highp int;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uText;
uniform vec2  uOut;        // output size (px)
uniform vec2  uBloomTexel;
uniform float uEnc;
uniform float uDofK;       // circle of confusion scale (output px)
uniform float uDofMax;
uniform float uSoft;       // minimum blur radius: lens softness, even in focus
uniform int   uTaps;
uniform float uBloomK;
uniform float uSeed;
uniform float uTime;
uniform float uExit;       // 0..1 ripple dissolve into the site
uniform vec3  uBg;         // page background (sRGB) the dissolve settles on
uniform float uDpr;
uniform vec4  uLetA[20];   // logo parts: xy cell bottom-left on screen (px), zw cell size (px)
uniform vec4  uLetB[20];   // xy: cell top-left in the atlas (px), z: progress 0..1, w: kind (0 ring, 1 divider, 2 letter)
uniform int   uLetN;
uniform int   uZ;          // always 0: keeps loops from being unrolled by the D3D compiler
uniform vec4  uTextBox;    // xy: atlas size, z: rise distance (px), w: reflection axis y (px)
uniform vec4  uLogo;       // xy: centre of the ring mark (px), z: bounds bottom, w: bounds top

const float FOCUS = 14.25;

vec4 S(vec2 uv) {
  vec4 s = texture(uScene, uv);
  if (uEnc > 0.5) { s.rgb *= s.rgb; s.a *= 64.0; }
  return s;
}
float coc(float d) { return clamp(uDofK * abs(d - FOCUS) / max(d, 0.1), uSoft, uDofMax); }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// identity up to the calibrated range, then a soft filmic roll-off into white
vec3 shoulder(vec3 x) {
  const float k = 0.8;
  vec3 e = k + (1.0 - k) * (1.0 - exp(-(x - k) / (1.0 - k)));
  return mix(x, e, step(k, x));
}

vec3 over(vec3 col, vec4 t, float a) { return col * (1.0 - t.a * a) + t.rgb * a; }

// One logo part at screen point fp: the rings grow out from the mark's centre like a ripple,
// the divider draws outward from its middle, the letters rise (wobbling as if seen through water).
// Returns premultiplied colour, already scaled by the part's opacity.
vec4 logoPart(int i, vec2 fp, float lodAdd) {
  vec4 A = uLetA[i], Bq = uLetB[i];
  float p = Bq.z;
  if (p <= 0.001) return vec4(0.0);
  int kind = int(Bq.w + 0.5);
  float q = 1.0 - p;
  float alpha = p;
  float lod = log2(1.0 + q * 12.0 * uDpr);
  vec2 lp = fp - A.xy;
  if (kind == 0) {
    float sc = mix(0.55, 1.0, p);
    lp = uLogo.xy + (fp - uLogo.xy) / sc - A.xy;
  } else if (kind == 1) {
    float hh = 0.5 * A.w;
    float reach = hh * p;
    alpha = smoothstep(reach + 1.5 * uDpr, reach - 1.5 * uDpr, abs(lp.y - hh)) * min(1.0, p * 4.0);
    lod = 0.0;
  } else {
    lp.y += q * uTextBox.z;
    lp.x += q * q * 6.0 * uDpr * sin(lp.y * 0.05 / uDpr + uTime * 5.0 + float(i) * 1.7);
  }
  if (lp.x < 0.0 || lp.y < 0.0 || lp.x > A.z || lp.y > A.w || alpha <= 0.0) return vec4(0.0);
  vec2 auv = vec2(Bq.x + lp.x, Bq.y + (A.w - lp.y)) / uTextBox.xy;
  return textureLod(uText, auv, lod + lodAdd) * alpha;
}

vec3 wordmark(vec3 col, vec2 fp) {
  if (fp.y < uLogo.z || fp.y > uLogo.w) return col;
  float axis = uTextBox.w;
  float span = max(axis - uLogo.z, 1.0);
  // faint mirror image on the water, broken up by ripples
  bool refl = fp.y < axis;
  vec2 rp = vec2(fp.x + 2.2 * uDpr * sin(fp.y * 0.42 / uDpr + uTime * 2.3) + 1.2 * uDpr * sin(fp.y * 0.13 / uDpr - uTime * 1.4),
                 2.0 * axis - fp.y);
  float rf = 0.13 * (1.0 - (axis - fp.y) / span);
  for (int i = 0; i < 20 + uZ; i++) {
    if (i >= uLetN) break;
    vec4 t = logoPart(i, fp, 0.0);
    col = col * (1.0 - t.a) + t.rgb;
    if (refl) {
      vec4 r = logoPart(i, rp, 1.2) * rf;
      col = col * (1.0 - r.a) + r.rgb;
    }
  }
  return col;
}

void main() {
  vec2 fp = gl_FragCoord.xy;
  vec2 uv = fp / uOut;

  if (uExit > 0.0) {
    // a ring wave runs out from the centre and carries the scene away
    vec2 c = (fp - 0.5 * uOut) / uOut.y;
    float r = length(c);
    float R = uExit * 1.4;
    float w = sin((r - R) * 26.0) * exp(-abs(r - R) * 8.0) * 0.03 * (1.0 - uExit);
    vec2 off = (c / max(r, 1e-3)) * w;
    fp += off * uOut.y;
    uv = fp / uOut;
  }

  // depth of field: scatter-as-gather over a golden-angle disc
  vec4 c0 = S(uv);
  float cc = coc(c0.a);
  vec3 acc = c0.rgb;
  float wsum = 1.0;
  float R = min(max(cc, 2.0 * uSoft + 0.8), uDofMax);
  float rot = hash12(floor(fp)) * 6.2831853;
  for (int i = 0; i < 12 + uZ; i++) {
    if (i >= uTaps) break;
    float fi = float(i) + 0.5;
    float rr = sqrt(fi / float(uTaps)) * R;
    float an = fi * 2.3999632 + rot;
    vec4 s = S(uv + vec2(cos(an), sin(an)) * rr / uOut);
    float cs = coc(s.a);
    if (s.a > c0.a) cs = min(cs, cc);       // what is behind can't spill over something sharper
    float w = clamp(cs - rr + 0.5, 0.0, 1.0);
    acc += s.rgb * w;
    wsum += w;
  }
  vec3 col = acc / wsum;

  if (uBloomK > 0.0) {
    vec3 b = texture(uBloom, uv).rgb * 0.25;
    vec2 o1 = uBloomTexel * 1.5, o2 = uBloomTexel * 4.0;
    b += 0.125 * (texture(uBloom, uv + vec2(o1.x, 0.0)).rgb + texture(uBloom, uv - vec2(o1.x, 0.0)).rgb +
                  texture(uBloom, uv + vec2(0.0, o1.y)).rgb + texture(uBloom, uv - vec2(0.0, o1.y)).rgb);
    b += 0.0625 * (texture(uBloom, uv + o2).rgb + texture(uBloom, uv - o2).rgb +
                   texture(uBloom, uv + vec2(o2.x, -o2.y)).rgb + texture(uBloom, uv + vec2(-o2.x, o2.y)).rgb);
    col += b * uBloomK;
  }

  vec2 vc = (uv - 0.5) * 2.0;
  col *= 1.0 - 0.045 * dot(vc, vc);

  col = pow(shoulder(col), vec3(1.0 / 2.2));
  if (uLetN > 0) col = wordmark(col, fp);

  col = mix(col, uBg, smoothstep(0.25, 0.9, uExit));

  // gentle grain + dither so the long gradient never bands
  float g = hash12(gl_FragCoord.xy + fract(uSeed) * 917.0) - 0.5;
  col += g * (2.2 / 255.0);
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`,

  /* ================================================================== wave sim */
  // Damped 2-D wave equation on a 320² height field (r: now, g: previous step).
  sim: /* glsl */ `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uPrev;
uniform float uK;          // (c·dt/dx)²
uniform float uDamp;
uniform vec4  uPoke;       // xy: uv, z: radius (uv), w: strength (0 = none)
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 s = texelFetch(uPrev, p, 0).rg;
  float l = texelFetch(uPrev, clamp(p + ivec2(1, 0), ivec2(0), ivec2(319)), 0).r
          + texelFetch(uPrev, clamp(p - ivec2(1, 0), ivec2(0), ivec2(319)), 0).r
          + texelFetch(uPrev, clamp(p + ivec2(0, 1), ivec2(0), ivec2(319)), 0).r
          + texelFetch(uPrev, clamp(p - ivec2(0, 1), ivec2(0), ivec2(319)), 0).r - 4.0 * s.r;
  float h = (2.0 * s.r - s.g + uK * l) * uDamp;
  vec2 uv = (gl_FragCoord.xy) / 320.0;
  if (uPoke.w != 0.0) { vec2 d = (uv - uPoke.xy) / uPoke.z; h -= uPoke.w * exp(-dot(d, d)); }
  // soak up waves near the border so nothing bounces back off an invisible wall
  float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  h *= mix(0.94, 1.0, smoothstep(0.0, 0.08, edge));
  fragColor = vec4(h, s.r, 0.0, 1.0);
}`
};
