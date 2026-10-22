export const chroma = `
uniform vec3 u_key;
uniform float u_tolerance, u_softness, u_spill, u_choke, u_matte;
vec2 chroma(vec3 c) { return vec2(dot(c, vec3(-0.168736,-0.331264,0.5)), dot(c, vec3(0.5,-0.418688,-0.081312))); }
float matte(vec2 uv) { return smoothstep(u_tolerance, u_tolerance + max(u_softness, 0.00001), distance(chroma(straight(src(uv))), chroma(u_key))); }
vec4 effect(vec2 uv) {
  vec4 c = src(uv);
  float m = matte(uv);
  if (u_choke > 0.0) for (int x=-1; x<=1; x++) for (int y=-1; y<=1; y++) m = min(m, matte(uv + vec2(float(x),float(y))*u_choke/u_resolution));
  if (u_matte > 0.5) return vec4(vec3(m)*c.a, c.a);
  vec3 rgb = straight(c);
  vec3 dominant = step(u_key.gbr, u_key) * step(u_key.brg, u_key);
  vec3 limit = max(rgb.gbr, rgb.brg);
  rgb = mix(rgb, min(rgb, limit), dominant * u_spill);
  return vec4(rgb*c.a*m, c.a*m);
}`

export const luma = `
uniform float u_threshold, u_softness, u_invert;
vec4 effect(vec2 uv) {
  vec4 c = src(uv);
  float y = dot(srgbToLinear(straight(c)), vec3(0.2126,0.7152,0.0722));
  float m = smoothstep(u_threshold, u_threshold + max(u_softness,0.00001), y);
  if (u_invert > 0.5) m = 1.0-m;
  return c*m;
}`

export const liftGammaGain = `
uniform vec3 u_lift, u_gamma, u_gain;
vec4 effect(vec2 uv) {
  vec4 c = src(uv);
  vec3 rgb = srgbToLinear(straight(c));
  rgb = pow(max((rgb + u_lift*(1.0-rgb))*u_gain,vec3(0.0)), 1.0/max(u_gamma,vec3(0.01)));
  return vec4(linearToSrgb(rgb)*c.a,c.a);
}`

export const exposure = `
uniform float u_exposure, u_temperature, u_tint, u_contrast, u_saturation;
vec4 effect(vec2 uv) {
  vec4 c = src(uv);
  vec3 rgb = srgbToLinear(straight(c));
  rgb *= exp2(u_exposure) * exp2(vec3(u_temperature-u_tint*0.5, u_tint, -u_temperature-u_tint*0.5));
  rgb = max((rgb-0.18)*u_contrast+0.18,vec3(0.0));
  float y = dot(rgb,vec3(0.2126,0.7152,0.0722));
  rgb = mix(vec3(y),rgb,u_saturation);
  return vec4(linearToSrgb(rgb)*c.a,c.a);
}`

export const lut = `
uniform sampler3D u_lut;
uniform float u_intensity;
vec3 entry(ivec3 p) { return texelFetch(u_lut, p+ivec3(2,0,0),0).rgb; }
vec4 effect(vec2 uv) {
  vec4 c = src(uv);
  vec3 rgb = straight(c);
  vec3 low = texelFetch(u_lut,ivec3(0),0).rgb;
  vec3 high = texelFetch(u_lut,ivec3(1,0,0),0).rgb;
  float n = float(textureSize(u_lut,0).y-1);
  vec3 p = clamp((rgb-low)/(high-low),0.0,1.0)*n;
  ivec3 a = ivec3(floor(p)); ivec3 b = min(a+1,ivec3(int(n)));
  vec3 f = fract(p);
  vec3 r = mix(mix(mix(entry(a),entry(ivec3(b.x,a.y,a.z)),f.x),mix(entry(ivec3(a.x,b.y,a.z)),entry(ivec3(b.x,b.y,a.z)),f.x),f.y),
               mix(mix(entry(ivec3(a.x,a.y,b.z)),entry(ivec3(b.x,a.y,b.z)),f.x),mix(entry(ivec3(a.x,b.y,b.z)),entry(b),f.x),f.y),f.z);
  return vec4(mix(rgb,r,u_intensity)*c.a,c.a);
}`
