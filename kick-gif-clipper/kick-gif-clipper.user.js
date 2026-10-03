// ==UserScript==
// @name         Kick GIF Clipper
// @namespace    https://github.com/itsavibecode/userscripts
// @version      0.1.0
// @description  Turn a moment of a live Kick stream into a GIF without leaving the tab: record (or grab the last N seconds from an optional rewind buffer), trim / cut / crop in a small editor, and download. Everything runs in the browser; nothing is uploaded.
// @author       itsavibecode
// @match        https://kick.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// @homepageURL  https://github.com/itsavibecode/userscripts/tree/main/kick-gif-clipper
// @supportURL   https://github.com/itsavibecode/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/itsavibecode/userscripts/main/kick-gif-clipper/kick-gif-clipper.user.js
// @downloadURL  https://raw.githubusercontent.com/itsavibecode/userscripts/main/kick-gif-clipper/kick-gif-clipper.user.js
// ==/UserScript==

/*
 * HOW THIS WORKS
 * --------------
 * Kick's live player is an ordinary <video> fed by Media Source Extensions
 * (srcObject is a MediaSourceHandle). Its pixels are readable: drawImage()
 * onto a canvas does not taint it. So a timer samples the video at the
 * capture fps, downscales each frame onto an OffscreenCanvas and stores it as
 * a small WebP blob. That gives random access for trim / cut / scrub.
 *
 * requestVideoFrameCallback never fired on this player when it was measured,
 * so sampling is a plain timer that skips ticks where currentTime did not
 * move (paused / stalled). rVFC is still used opportunistically if it fires.
 *
 * The GIF is encoded in a Blob-URL Worker with gifenc (vendored below, MIT)
 * plus our own ordered / Floyd-Steinberg dithering. If the Worker cannot be
 * built, the same code runs on the main thread in small chunks.
 *
 * The pure parts (gifenc, timeline, crop, dither, GIF writer) live in
 * makeCore(). That one function is (1) used here, (2) stringified into the
 * Worker and (3) exported to Node for the unit tests in test/.
 */

(function () {
  'use strict';

  const VERSION = '0.1.0';
  const TAG = '[GIF Clipper]';

  // Selectors and limits that depend on Kick's page. Kept together so a Kick
  // player change is a one-place fix.
  const CFG = {
    minVideoArea: 160 * 90,   // ignore tiny / 0x0 videos (Kick keeps a hidden static one that taints the canvas)
    webpQuality: 0.82,
    maxEditorFrames: 600,     // warn before exporting more than this
    sizeWarnBytes: 10 * 1024 * 1024,
    // GIF bytes per output pixel per frame, measured on a live IRL stream
    // (2026-10-02, 161 frames 360x360, global palette). Full frames, no
    // inter-frame transparency, so busy camera footage is expensive.
    bytesPerPixel: { none: 0.35, ordered: 0.48, fs: 0.45 },
    paletteSampleFrames: 12,
    decodeCache: 48,
    thumbs: 24,
    fpsSteps: [24, 20, 15, 12, 10],
  };

  /* ==================================================================== *
   * CORE - pure code. No DOM, no closure references: it is stringified    *
   * into the Worker and loaded by node --test.                            *
   * ==================================================================== */
  function makeCore() {
    'use strict';

    /* ------------------------------------------------------------------
     * gifenc 1.0.3 - https://github.com/mattdesl/gifenc
     * Vendored verbatim from the npm package file dist/gifenc.esm.js
     * (sha256 217761244379253ba5815510d3048a4fb1f4c4dbe9fb51a5cfbfe26f34eec093).
     * The only change: its trailing ES `export {...}` became the
     * `return {...}` below so it can live inside a function.
     *
     * The MIT License (MIT)
     * Copyright (c) 2017 Matt DesLauriers
     *
     * Permission is hereby granted, free of charge, to any person obtaining a copy
     * of this software and associated documentation files (the "Software"), to deal
     * in the Software without restriction, including without limitation the rights
     * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
     * copies of the Software, and to permit persons to whom the Software is
     * furnished to do so, subject to the following conditions:
     *
     * The above copyright notice and this permission notice shall be included in all
     * copies or substantial portions of the Software.
     *
     * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
     * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
     * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
     * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
     * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
     * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
     * OR OTHER DEALINGS IN THE SOFTWARE.
     * ------------------------------------------------------------------ */
    const gifenc = (function () {
var X={signature:"GIF",version:"89a",trailer:59,extensionIntroducer:33,applicationExtensionLabel:255,graphicControlExtensionLabel:249,imageSeparator:44,signatureSize:3,versionSize:3,globalColorTableFlagMask:128,colorResolutionMask:112,sortFlagMask:8,globalColorTableSizeMask:7,applicationIdentifierSize:8,applicationAuthCodeSize:3,disposalMethodMask:28,userInputFlagMask:2,transparentColorFlagMask:1,localColorTableFlagMask:128,interlaceFlagMask:64,idSortFlagMask:32,localColorTableSizeMask:7};function F(t=256){let e=0,s=new Uint8Array(t);return{get buffer(){return s.buffer},reset(){e=0},bytesView(){return s.subarray(0,e)},bytes(){return s.slice(0,e)},writeByte(r){n(e+1),s[e]=r,e++},writeBytes(r,o=0,i=r.length){n(e+i);for(let c=0;c<i;c++)s[e++]=r[c+o]},writeBytesView(r,o=0,i=r.byteLength){n(e+i),s.set(r.subarray(o,o+i),e),e+=i}};function n(r){var o=s.length;if(o>=r)return;var i=1024*1024;r=Math.max(r,o*(o<i?2:1.125)>>>0),o!=0&&(r=Math.max(r,256));let c=s;s=new Uint8Array(r),e>0&&s.set(c.subarray(0,e),0)}}var O=12,J=5003,lt=[0,1,3,7,15,31,63,127,255,511,1023,2047,4095,8191,16383,32767,65535];function at(t,e,s,n,r=F(512),o=new Uint8Array(256),i=new Int32Array(J),c=new Int32Array(J)){let x=i.length,a=Math.max(2,n);o.fill(0),c.fill(0),i.fill(-1);let l=0,f=0,g=a+1,h=g,b=!1,w=h,_=(1<<w)-1,u=1<<g-1,k=u+1,B=u+2,p=0,A=s[0],z=0;for(let y=x;y<65536;y*=2)++z;z=8-z,r.writeByte(a),I(u);let d=s.length;for(let y=1;y<d;y++){t:{let m=s[y],v=(m<<O)+A,M=m<<z^A;if(i[M]===v){A=c[M];break t}let V=M===0?1:x-M;for(;i[M]>=0;)if(M-=V,M<0&&(M+=x),i[M]===v){A=c[M];break t}I(A),A=m,B<1<<O?(c[M]=B++,i[M]=v):(i.fill(-1),B=u+2,b=!0,I(u))}}return I(A),I(k),r.writeByte(0),r.bytesView();function I(y){for(l&=lt[f],f>0?l|=y<<f:l=y,f+=w;f>=8;)o[p++]=l&255,p>=254&&(r.writeByte(p),r.writeBytesView(o,0,p),p=0),l>>=8,f-=8;if((B>_||b)&&(b?(w=h,_=(1<<w)-1,b=!1):(++w,_=w===O?1<<w:(1<<w)-1)),y==k){for(;f>0;)o[p++]=l&255,p>=254&&(r.writeByte(p),r.writeBytesView(o,0,p),p=0),l>>=8,f-=8;p>0&&(r.writeByte(p),r.writeBytesView(o,0,p),p=0)}}}var $=at;function D(t,e,s){return t<<8&63488|e<<2&992|s>>3}function G(t,e,s,n){return t>>4|e&240|(s&240)<<4|(n&240)<<8}function j(t,e,s){return t>>4<<8|e&240|s>>4}function R(t,e,s){return t<e?e:t>s?s:t}function T(t){return t*t}function tt(t,e,s){var n=0,r=1e100;let o=t[e],i=o.cnt,c=o.ac,x=o.rc,a=o.gc,l=o.bc;for(var f=o.fw;f!=0;f=t[f].fw){let h=t[f],b=h.cnt,w=i*b/(i+b);if(!(w>=r)){var g=0;s&&(g+=w*T(h.ac-c),g>=r)||(g+=w*T(h.rc-x),!(g>=r)&&(g+=w*T(h.gc-a),!(g>=r)&&(g+=w*T(h.bc-l),!(g>=r)&&(r=g,n=f))))}}o.err=r,o.nn=n}function Q(){return{ac:0,rc:0,gc:0,bc:0,cnt:0,nn:0,fw:0,bk:0,tm:0,mtm:0,err:0}}function ut(t,e){let s=e==="rgb444"?4096:65536,n=new Array(s),r=t.length;if(e==="rgba4444")for(let o=0;o<r;++o){let i=t[o],c=i>>24&255,x=i>>16&255,a=i>>8&255,l=i&255,f=G(l,a,x,c),g=f in n?n[f]:n[f]=Q();g.rc+=l,g.gc+=a,g.bc+=x,g.ac+=c,g.cnt++}else if(e==="rgb444")for(let o=0;o<r;++o){let i=t[o],c=i>>16&255,x=i>>8&255,a=i&255,l=j(a,x,c),f=l in n?n[l]:n[l]=Q();f.rc+=a,f.gc+=x,f.bc+=c,f.cnt++}else for(let o=0;o<r;++o){let i=t[o],c=i>>16&255,x=i>>8&255,a=i&255,l=D(a,x,c),f=l in n?n[l]:n[l]=Q();f.rc+=a,f.gc+=x,f.bc+=c,f.cnt++}return n}function H(t,e,s={}){let{format:n="rgb565",clearAlpha:r=!0,clearAlphaColor:o=0,clearAlphaThreshold:i=0,oneBitAlpha:c=!1}=s;if(!t||!t.buffer)throw new Error("quantize() expected RGBA Uint8Array data");if(!(t instanceof Uint8Array)&&!(t instanceof Uint8ClampedArray))throw new Error("quantize() expected RGBA Uint8Array data");let x=new Uint32Array(t.buffer),a=s.useSqrt!==!1,l=n==="rgba4444",f=ut(x,n),g=f.length,h=g-1,b=new Uint32Array(g+1);for(var w=0,u=0;u<g;++u){let C=f[u];if(C!=null){var _=1/C.cnt;l&&(C.ac*=_),C.rc*=_,C.gc*=_,C.bc*=_,f[w++]=C}}T(e)/w<.022&&(a=!1);for(var u=0;u<w-1;++u)f[u].fw=u+1,f[u+1].bk=u,a&&(f[u].cnt=Math.sqrt(f[u].cnt));a&&(f[u].cnt=Math.sqrt(f[u].cnt));var k,B,p;for(u=0;u<w;++u){tt(f,u,!1);var A=f[u].err;for(B=++b[0];B>1&&(p=B>>1,!(f[k=b[p]].err<=A));B=p)b[B]=k;b[B]=u}var z=w-e;for(u=0;u<z;){for(var d;;){var I=b[1];if(d=f[I],d.tm>=d.mtm&&f[d.nn].mtm<=d.tm)break;d.mtm==h?I=b[1]=b[b[0]--]:(tt(f,I,!1),d.tm=u);var A=f[I].err;for(B=1;(p=B+B)<=b[0]&&(p<b[0]&&f[b[p]].err>f[b[p+1]].err&&p++,!(A<=f[k=b[p]].err));B=p)b[B]=k;b[B]=I}var y=f[d.nn],m=d.cnt,v=y.cnt,_=1/(m+v);l&&(d.ac=_*(m*d.ac+v*y.ac)),d.rc=_*(m*d.rc+v*y.rc),d.gc=_*(m*d.gc+v*y.gc),d.bc=_*(m*d.bc+v*y.bc),d.cnt+=y.cnt,d.mtm=++u,f[y.bk].fw=y.fw,f[y.fw].bk=y.bk,y.mtm=h}let M=[];var V=0;for(u=0;;++V){let L=R(Math.round(f[u].rc),0,255),C=R(Math.round(f[u].gc),0,255),Y=R(Math.round(f[u].bc),0,255),E=255;if(l){if(E=R(Math.round(f[u].ac),0,255),c){let st=typeof c=="number"?c:127;E=E<=st?0:255}r&&E<=i&&(L=C=Y=o,E=0)}let K=l?[L,C,Y,E]:[L,C,Y];if(xt(M,K)||M.push(K),(u=f[u].fw)==0)break}return M}function xt(t,e){for(let s=0;s<t.length;s++){let n=t[s],r=n[0]===e[0]&&n[1]===e[1]&&n[2]===e[2],o=n.length>=4&&e.length>=4?n[3]===e[3]:!0;if(r&&o)return!0}return!1}function U(t,e){var s=0,n;for(n=0;n<t.length;n++){let r=t[n]-e[n];s+=r*r}return s}function P(t,e){return e>1?Math.round(t/e)*e:t}function et(t,{roundRGB:e=5,roundAlpha:s=10,oneBitAlpha:n=null}={}){let r=new Uint32Array(t.buffer);for(let o=0;o<r.length;o++){let i=r[o],c=i>>24&255,x=i>>16&255,a=i>>8&255,l=i&255;if(c=P(c,s),n){let f=typeof n=="number"?n:127;c=c<=f?0:255}l=P(l,e),a=P(a,e),x=P(x,e),r[o]=c<<24|x<<16|a<<8|l<<0}}function nt(t,e,s="rgb565"){if(!t||!t.buffer)throw new Error("quantize() expected RGBA Uint8Array data");if(!(t instanceof Uint8Array)&&!(t instanceof Uint8ClampedArray))throw new Error("quantize() expected RGBA Uint8Array data");if(e.length>256)throw new Error("applyPalette() only works with 256 colors or less");let n=new Uint32Array(t.buffer),r=n.length,o=s==="rgb444"?4096:65536,i=new Uint8Array(r),c=new Array(o),x=s==="rgba4444";if(s==="rgba4444")for(let a=0;a<r;a++){let l=n[a],f=l>>24&255,g=l>>16&255,h=l>>8&255,b=l&255,w=G(b,h,g,f),_=w in c?c[w]:c[w]=gt(b,h,g,f,e);i[a]=_}else{let a=s==="rgb444"?j:D;for(let l=0;l<r;l++){let f=n[l],g=f>>16&255,h=f>>8&255,b=f&255,w=a(b,h,g),_=w in c?c[w]:c[w]=bt(b,h,g,e);i[l]=_}}return i}function gt(t,e,s,n,r){let o=0,i=1e100;for(let c=0;c<r.length;c++){let x=r[c],a=x[3],l=q(a-n);if(l>i)continue;let f=x[0];if(l+=q(f-t),l>i)continue;let g=x[1];if(l+=q(g-e),l>i)continue;let h=x[2];l+=q(h-s),!(l>i)&&(i=l,o=c)}return o}function bt(t,e,s,n){let r=0,o=1e100;for(let i=0;i<n.length;i++){let c=n[i],x=c[0],a=q(x-t);if(a>o)continue;let l=c[1];if(a+=q(l-e),a>o)continue;let f=c[2];a+=q(f-s),!(a>o)&&(o=a,r=i)}return r}function rt(t,e,s=5){if(!t.length||!e.length)return;let n=t.map(i=>i.slice(0,3)),r=s*s,o=t[0].length;for(let i=0;i<e.length;i++){let c=e[i];c.length<o?c=[c[0],c[1],c[2],255]:c.length>o?c=c.slice(0,3):c=c.slice();let x=N(n,c.slice(0,3),U),a=x[0],l=x[1];l>0&&l<=r&&(t[a]=c)}}function q(t){return t*t}function W(t,e,s=U){let n=Infinity,r=-1;for(let o=0;o<t.length;o++){let i=t[o],c=s(e,i);c<n&&(n=c,r=o)}return r}function N(t,e,s=U){let n=Infinity,r=-1;for(let o=0;o<t.length;o++){let i=t[o],c=s(e,i);c<n&&(n=c,r=o)}return[r,n]}function ot(t,e,s=U){return t[W(t,e,s)]}function ct(t={}){let{initialCapacity:e=4096,auto:s=!0}=t,n=F(e),r=5003,o=new Uint8Array(256),i=new Int32Array(r),c=new Int32Array(r),x=!1;return{reset(){n.reset(),x=!1},finish(){n.writeByte(X.trailer)},bytes(){return n.bytes()},bytesView(){return n.bytesView()},get buffer(){return n.buffer},get stream(){return n},writeHeader:a,writeFrame(l,f,g,h={}){let{transparent:b=!1,transparentIndex:w=0,delay:_=0,palette:u=null,repeat:k=0,colorDepth:B=8,dispose:p=-1}=h,A=!1;if(s?x||(A=!0,a(),x=!0):A=Boolean(h.first),f=Math.max(0,Math.floor(f)),g=Math.max(0,Math.floor(g)),A){if(!u)throw new Error("First frame must include a { palette } option");pt(n,f,g,u,B),it(n,u),k>=0&&dt(n,k)}let z=Math.round(_/10);wt(n,p,z,b,w);let d=Boolean(u)&&!A;ht(n,f,g,d?u:null),d&&it(n,u),yt(n,l,f,g,B,o,i,c)}};function a(){ft(n,"GIF89a")}}function wt(t,e,s,n,r){t.writeByte(33),t.writeByte(249),t.writeByte(4),r<0&&(r=0,n=!1);var o,i;n?(o=1,i=2):(o=0,i=0),e>=0&&(i=e&7),i<<=2;let c=0;t.writeByte(0|i|c|o),S(t,s),t.writeByte(r||0),t.writeByte(0)}function pt(t,e,s,n,r=8){let o=1,i=0,c=Z(n.length)-1,x=o<<7|r-1<<4|i<<3|c,a=0,l=0;S(t,e),S(t,s),t.writeBytes([x,a,l])}function dt(t,e){t.writeByte(33),t.writeByte(255),t.writeByte(11),ft(t,"NETSCAPE2.0"),t.writeByte(3),t.writeByte(1),S(t,e),t.writeByte(0)}function it(t,e){let s=1<<Z(e.length);for(let n=0;n<s;n++){let r=[0,0,0];n<e.length&&(r=e[n]),t.writeByte(r[0]),t.writeByte(r[1]),t.writeByte(r[2])}}function ht(t,e,s,n){if(t.writeByte(44),S(t,0),S(t,0),S(t,e),S(t,s),n){let r=0,o=0,i=Z(n.length)-1;t.writeByte(128|r|o|0|i)}else t.writeByte(0)}function yt(t,e,s,n,r=8,o,i,c){$(s,n,e,r,t,o,i,c)}function S(t,e){t.writeByte(e&255),t.writeByte(e>>8&255)}function ft(t,e){for(var s=0;s<e.length;s++)t.writeByte(e.charCodeAt(s))}function Z(t){return Math.max(Math.ceil(Math.log2(t)),1)}var Bt=ct;
      return { GIFEncoder: ct, quantize: H, applyPalette: nt, nearestColorIndex: W };
    })();
    /* ----------------------------- end gifenc ---------------------------- */

    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    const even = (v) => Math.max(2, Math.round(v / 2) * 2);

    /* ---------------- timeline: kept segments over frame indices ----------
     * segments = [{from, to}] half-open [from, to), sorted, non-overlapping. */
    const timeline = {
      reset(n) { return n > 0 ? [{ from: 0, to: n }] : []; },
      normalize(segs) {
        const s = segs.filter((x) => x.to > x.from).map((x) => ({ from: x.from, to: x.to }))
          .sort((a, b) => a.from - b.from);
        const out = [];
        for (const x of s) {
          const last = out[out.length - 1];
          if (last && x.from <= last.to) last.to = Math.max(last.to, x.to);
          else out.push(x);
        }
        return out;
      },
      sel(a, b) { return { from: Math.min(a, b), to: Math.max(a, b) }; },
      keep(segs, sel) {
        const s = timeline.sel(sel.from, sel.to);
        return timeline.normalize(segs.map((x) => ({ from: Math.max(x.from, s.from), to: Math.min(x.to, s.to) })));
      },
      remove(segs, sel) {
        const s = timeline.sel(sel.from, sel.to);
        const out = [];
        for (const x of segs) {
          if (x.to <= s.from || x.from >= s.to) { out.push(x); continue; }
          if (x.from < s.from) out.push({ from: x.from, to: s.from });
          if (x.to > s.to) out.push({ from: s.to, to: x.to });
        }
        return timeline.normalize(out);
      },
      count(segs) { let n = 0; for (const x of segs) n += x.to - x.from; return n; },
      keptIndices(segs) { const out = []; for (const x of segs) for (let i = x.from; i < x.to; i++) out.push(i); return out; },
      isKept(segs, i) { for (const x of segs) if (i >= x.from && i < x.to) return true; return false; },
      durationMs(segs, fps) { return timeline.count(segs) * 1000 / fps; },
      // Pick output frames from kept source frames when the output fps is
      // lower than the capture fps (15 -> 10 keeps every 1.5th frame).
      resample(indices, srcFps, outFps) {
        if (!(outFps < srcFps)) return indices.slice();
        const step = srcFps / outFps;
        const out = [];
        for (let k = 0; ; k++) {
          const j = Math.floor(k * step + 1e-9);
          if (j >= indices.length) break;
          out.push(indices[j]);
        }
        return out;
      },
    };

    /* ---------------- crop: rectangles in source pixels ------------------- */
    const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    const crop = {
      MIN: 32,
      HANDLES,
      full(W, H) { return { x: 0, y: 0, w: W, h: H }; },
      clamp(r, W, H, min) {
        min = min == null ? crop.MIN : min;
        const w = Math.round(clamp(r.w, Math.min(min, W), W));
        const h = Math.round(clamp(r.h, Math.min(min, H), H));
        return { x: Math.round(clamp(r.x, 0, W - w)), y: Math.round(clamp(r.y, 0, H - h)), w, h };
      },
      // Largest rect of `aspect` (w/h) centred on r's centre that fits the frame.
      fitAspect(r, aspect, W, H, min) {
        if (!aspect) return crop.clamp(r, W, H, min);
        min = min == null ? crop.MIN : min;
        let w = r.w, h = r.h;
        if (w / h > aspect) w = h * aspect; else h = w / aspect;
        const s = Math.min(1, W / w, H / h); w *= s; h *= s;
        const g = Math.max(1, min / w, min / h); w = Math.min(W, w * g); h = Math.min(H, h * g);
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        return crop.clamp({ x: cx - w / 2, y: cy - h / 2, w, h }, W, H, min);
      },
      // Biggest centred rect of the aspect inside the frame (preset on no crop).
      centered(aspect, W, H) {
        let w = W, h = H;
        if (aspect) { if (W / H > aspect) w = H * aspect; else h = W / aspect; }
        return crop.clamp({ x: (W - w) / 2, y: (H - h) / 2, w, h }, W, H);
      },
      // Drag a handle ('move' or one of HANDLES) of the start rect by dx/dy.
      drag(s, handle, dx, dy, W, H, aspect, min) {
        min = min == null ? crop.MIN : min;
        if (handle === 'move') {
          return crop.clamp({ x: s.x + dx, y: s.y + dy, w: s.w, h: s.h }, W, H, min);
        }
        const hw = handle.indexOf('w') >= 0, he = handle.indexOf('e') >= 0;
        const hn = handle.indexOf('n') >= 0, hs = handle.indexOf('s') >= 0;
        let l = s.x, t = s.y, r = s.x + s.w, b = s.y + s.h;
        if (hw) l = clamp(l + dx, 0, r - min);
        if (he) r = clamp(r + dx, l + min, W);
        if (hn) t = clamp(t + dy, 0, b - min);
        if (hs) b = clamp(b + dy, t + min, H);
        if (!aspect) return crop.clamp({ x: l, y: t, w: r - l, h: b - t }, W, H, min);
        let w = r - l, h = b - t;
        if ((hw || he) && (hn || hs)) { if (w / h > aspect) h = w / aspect; else w = h * aspect; }
        else if (hw || he) h = w / aspect;
        else w = h * aspect;
        // Anchor: the opposite edge, or the centre on the free axis.
        const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
        const ax = hw ? s.x + s.w : he ? s.x : cx;
        const ay = hn ? s.y + s.h : hs ? s.y : cy;
        const maxW = hw ? ax : he ? W - ax : 2 * Math.min(ax, W - ax);
        const maxH = hn ? ay : hs ? H - ay : 2 * Math.min(ay, H - ay);
        const k = Math.min(1, maxW / w, maxH / h); w *= k; h *= k;
        const g = Math.max(1, min / w, min / h); w *= g; h *= g;
        const x = hw ? ax - w : he ? ax : ax - w / 2;
        const y = hn ? ay - h : hs ? ay : ay - h / 2;
        return crop.clamp({ x, y, w, h }, W, H, min);
      },
      // Rectangle drawn from (x0,y0) toward (x1,y1).
      fromPoints(x0, y0, x1, y1, W, H, aspect, min) {
        min = min == null ? crop.MIN : min;
        x0 = clamp(x0, 0, W); y0 = clamp(y0, 0, H); x1 = clamp(x1, 0, W); y1 = clamp(y1, 0, H);
        const sx = x1 >= x0 ? 1 : -1, sy = y1 >= y0 ? 1 : -1;
        let w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
        if (aspect) {
          if (h === 0 || w / h > aspect) h = w / aspect; else w = h * aspect;
          const maxW = sx > 0 ? W - x0 : x0, maxH = sy > 0 ? H - y0 : y0;
          const k = Math.min(1, maxW / (w || 1), maxH / (h || 1)); w *= k; h *= k;
          const g = Math.max(1, min / (w || 1), min / (h || 1)); w *= g; h *= g;
        } else { w = Math.max(w, min); h = Math.max(h, min); }
        return crop.clamp({ x: sx > 0 ? x0 : x0 - w, y: sy > 0 ? y0 : y0 - h, w, h }, W, H, min);
      },
      // Letterbox the source into a box: scale + offset of the drawn image.
      view(srcW, srcH, boxW, boxH) {
        const scale = Math.min(boxW / srcW, boxH / srcH);
        const w = srcW * scale, h = srcH * scale;
        return { scale, ox: (boxW - w) / 2, oy: (boxH - h) / 2, w, h };
      },
      toView(r, v) { return { x: v.ox + r.x * v.scale, y: v.oy + r.y * v.scale, w: r.w * v.scale, h: r.h * v.scale }; },
      toSource(px, py, v) { return { x: (px - v.ox) / v.scale, y: (py - v.oy) / v.scale }; },
      // Which handle (or 'move' inside the box) is under a point in view px.
      hit(r, v, px, py, tol) {
        tol = tol == null ? 8 : tol;
        const q = crop.toView(r, v);
        const xs = { w: q.x, c: q.x + q.w / 2, e: q.x + q.w };
        const ys = { n: q.y, c: q.y + q.h / 2, s: q.y + q.h };
        for (const hd of HANDLES) {
          const hx = hd.indexOf('w') >= 0 ? xs.w : hd.indexOf('e') >= 0 ? xs.e : xs.c;
          const hy = hd.indexOf('n') >= 0 ? ys.n : hd.indexOf('s') >= 0 ? ys.s : ys.c;
          if (Math.abs(px - hx) <= tol && Math.abs(py - hy) <= tol) return hd;
        }
        if (px >= q.x && px <= q.x + q.w && py >= q.y && py <= q.y + q.h) return 'move';
        return null;
      },
      // Output size for a crop and a requested width: never upscale, even numbers.
      outputSize(r, width) {
        const down = (v) => Math.max(2, Math.floor(v / 2) * 2);   // even, never above v
        const w = down(Math.min(width || r.w, r.w));
        return { w, h: Math.min(even(w * r.h / r.w), down(r.h)) };
      },
    };

    /* ---------------- dithering (on top of gifenc's nearestColorIndex) ----- */
    const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    // Nearest-palette lookup cached on an RGB565 key, like gifenc's applyPalette.
    // Same squared-RGB distance as gifenc's nearestColorIndex, but without an
    // array allocation per miss. Memoized per palette, so a global palette
    // shares one cache across every frame.
    const lookups = new WeakMap();
    function makeLookup(palette) {
      const hit = lookups.get(palette);
      if (hit) return hit;
      const n = palette.length, pr = new Int32Array(n), pg = new Int32Array(n), pb = new Int32Array(n);
      for (let j = 0; j < n; j++) { pr[j] = palette[j][0]; pg[j] = palette[j][1]; pb[j] = palette[j][2]; }
      const cache = new Int16Array(65536).fill(-1);
      const fn = function (r, g, b) {
        const key = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
        let v = cache[key];
        if (v < 0) {
          let best = 1e9;
          for (let j = 0; j < n; j++) {
            const dr = r - pr[j], dg = g - pg[j], db = b - pb[j], d = dr * dr + dg * dg + db * db;
            if (d < best) { best = d; v = j; }
          }
          cache[key] = v;
        }
        return v;
      };
      lookups.set(palette, fn);
      return fn;
    }
    const c8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
    const dither = {
      BAYER4,
      none(rgba, w, h, palette) {
        const look = makeLookup(palette), n = w * h, out = new Uint8Array(n);
        for (let i = 0, p = 0; i < n; i++, p += 4) out[i] = look(rgba[p], rgba[p + 1], rgba[p + 2]);
        return out;
      },
      // Bayer 4x4. The spread is the gap between palette levels per channel,
      // so a 2-colour palette dithers the full range and 256 colours dither gently.
      ordered(rgba, w, h, palette) {
        const look = makeLookup(palette), out = new Uint8Array(w * h);
        const spread = Math.min(255, 255 / (Math.max(2, Math.cbrt(palette.length)) - 1));
        for (let y = 0, i = 0; y < h; y++) {
          for (let x = 0; x < w; x++, i++) {
            const d = ((BAYER4[((y & 3) << 2) | (x & 3)] + 0.5) / 16 - 0.5) * spread;
            const p = i * 4;
            out[i] = look(c8(rgba[p] + d), c8(rgba[p + 1] + d), c8(rgba[p + 2] + d));
          }
        }
        return out;
      },
      // Floyd-Steinberg error diffusion.
      fs(rgba, w, h, palette) {
        const look = makeLookup(palette), n = w * h, out = new Uint8Array(n);
        const buf = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { buf[i * 3] = rgba[i * 4]; buf[i * 3 + 1] = rgba[i * 4 + 1]; buf[i * 3 + 2] = rgba[i * 4 + 2]; }
        const add = (x, y, er, eg, eb, f) => {
          if (x < 0 || x >= w || y >= h) return;
          const j = (y * w + x) * 3; buf[j] += er * f; buf[j + 1] += eg * f; buf[j + 2] += eb * f;
        };
        for (let y = 0, i = 0; y < h; y++) {
          for (let x = 0; x < w; x++, i++) {
            const r = c8(buf[i * 3] + 0.5), g = c8(buf[i * 3 + 1] + 0.5), b = c8(buf[i * 3 + 2] + 0.5);
            const k = look(r, g, b); out[i] = k;
            const pc = palette[k], er = buf[i * 3] - pc[0], eg = buf[i * 3 + 1] - pc[1], eb = buf[i * 3 + 2] - pc[2];
            add(x + 1, y, er, eg, eb, 7 / 16); add(x - 1, y + 1, er, eg, eb, 3 / 16);
            add(x, y + 1, er, eg, eb, 5 / 16); add(x + 1, y + 1, er, eg, eb, 1 / 16);
          }
        }
        return out;
      },
      apply(mode, rgba, w, h, palette) {
        if (mode === 'ordered') return dither.ordered(rgba, w, h, palette);
        if (mode === 'fs') return dither.fs(rgba, w, h, palette);
        return dither.none(rgba, w, h, palette);
      },
    };

    /* ---------------- GIF writer ------------------------------------------ */
    // GIF delays are hundredths of a second; under 2 browsers treat as 10.
    function delayCs(outFps, speed) { return Math.max(2, Math.round(100 / outFps / (speed || 1))); }
    function effectiveFps(outFps, speed) { return 100 / delayCs(outFps, speed); }
    // gifenc repeat: 0 = forever, -1 = play once, N = N extra plays.
    function loopToRepeat(loop) {
      if (loop === 'once' || loop === 1 || loop === '1') return -1;
      const n = parseInt(loop, 10);
      if (!(n >= 2)) return 0;
      return n - 1;
    }
    function evenlySpaced(n, k) {
      if (n <= 0) return [];
      if (n <= k) return Array.from({ length: n }, (_, i) => i);
      const out = [];
      for (let i = 0; i < k; i++) out.push(Math.round(i * (n - 1) / (k - 1)));
      return out;
    }
    // Grid-subsample a frame to <= maxW px wide for palette building.
    function samplePixels(rgba, w, h, maxW) {
      const step = Math.max(1, Math.ceil(w / (maxW || 160)));
      const sw = Math.ceil(w / step), sh = Math.ceil(h / step);
      const out = new Uint8Array(sw * sh * 4);
      let o = 0;
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const p = (y * w + x) * 4;
          out[o++] = rgba[p]; out[o++] = rgba[p + 1]; out[o++] = rgba[p + 2]; out[o++] = 255;
        }
      }
      return out.subarray(0, o);
    }
    function quantize(rgba) {
      // gifenc reads rgba.buffer as Uint32, so hand it a tight copy.
      const tight = (rgba.byteOffset === 0 && rgba.byteLength === rgba.buffer.byteLength) ? rgba : new Uint8Array(rgba);
      return gifenc.quantize(tight, 256, { format: 'rgb565' });
    }
    // Streaming writer. opts: {width, height, loop, dither, palette:'global'|'frame'}
    function createWriter(opts) {
      const W = opts.width, Hh = opts.height;
      const enc = gifenc.GIFEncoder();
      const samples = [];
      let globalPal = null, first = true, frames = 0;
      const repeat = loopToRepeat(opts.loop);
      return {
        addSample(rgba, w, h) { samples.push(samplePixels(rgba, w, h, 160)); },
        addFrame(rgba, dCs) {
          let pal;
          if (opts.palette === 'frame') pal = quantize(rgba);
          else {
            if (!globalPal) {
              if (!samples.length) samples.push(samplePixels(rgba, W, Hh, 160));
              let len = 0; for (const s of samples) len += s.length;
              const all = new Uint8Array(len); let o = 0;
              for (const s of samples) { all.set(s, o); o += s.length; }
              globalPal = quantize(all);
              samples.length = 0;
            }
            pal = globalPal;
          }
          const index = dither.apply(opts.dither, rgba, W, Hh, pal);
          const fo = { delay: dCs * 10, repeat };
          if (first || opts.palette === 'frame') fo.palette = pal;
          enc.writeFrame(index, W, Hh, fo);
          first = false; frames++;
        },
        finish() { enc.finish(); return enc.bytes(); },
        get frames() { return frames; },
      };
    }
    // Convenience for tests: frames = [{data, width, height}] all the same size.
    function encodeGif(frames, opts) {
      const w = frames[0].width, h = frames[0].height;
      const wr = createWriter({ width: w, height: h, loop: opts.loop, dither: opts.dither || 'none', palette: opts.palette || 'global' });
      if ((opts.palette || 'global') === 'global') {
        for (const i of evenlySpaced(frames.length, 12)) wr.addSample(frames[i].data, w, h);
      }
      const d = opts.delayCs || delayCs(opts.fps || 15, opts.speed || 1);
      for (const f of frames) wr.addFrame(f.data, d);
      return wr.finish();
    }

    /* ---------------- small helpers --------------------------------------- */
    function fmtTime(ms) {
      ms = Math.max(0, ms || 0);
      const t = Math.floor(ms / 100);           // tenths
      const m = Math.floor(t / 600), s = Math.floor((t % 600) / 10), d = t % 10;
      return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + d;
    }
    function fmtBytes(b) {
      if (b < 1024) return b + ' B';
      if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
      return (b / 1024 / 1024).toFixed(1) + ' MB';
    }
    function stamp(d) {
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }
    function fileName(pattern, channel, date) {
      let n = String(pattern || 'kick_{channel}_{date}.gif')
        .split('{channel}').join(channel || 'kick')
        .split('{date}').join(stamp(date));
      n = n.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'kick_clip';
      if (!/\.gif$/i.test(n)) n += '.gif';
      return n;
    }
    // Thin a frame list to a lower fps by timestamp (used when capture steps down).
    function decimateByTime(frames, fps) {
      if (!frames.length) return frames;
      const iv = 1000 / fps, out = [];
      let next = frames[0].t;
      for (const f of frames) if (f.t >= next - 1) { out.push(f); next = Math.max(next + iv, f.t + iv * 0.5); }
      return out;
    }

    return {
      gifenc, timeline, crop, dither, createWriter, encodeGif, delayCs, effectiveFps,
      loopToRepeat, evenlySpaced, samplePixels, fmtTime, fmtBytes, fileName, stamp, decimateByTime, even, clamp,
    };
  }

  // Worker / inline-encoder message loop. Only uses its arguments.
  function workerMain(CORE, scope) {
    let writer = null, done = 0, total = 0;
    scope.onmessage = function (e) {
      const m = e.data;
      try {
        if (m.type === 'init') { writer = CORE.createWriter(m.opts); total = m.total; done = 0; }
        else if (m.type === 'sample') writer.addSample(new Uint8ClampedArray(m.buf), m.w, m.h);
        else if (m.type === 'frame') {
          writer.addFrame(new Uint8ClampedArray(m.buf), m.delayCs);
          done++;
          scope.postMessage({ type: 'progress', done, total });
        } else if (m.type === 'finish') {
          const bytes = writer.finish();
          scope.postMessage({ type: 'done', bytes }, [bytes.buffer]);
        }
      } catch (err) {
        scope.postMessage({ type: 'error', message: String((err && err.message) || err) });
      }
    };
  }

  const CORE = makeCore();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = Object.assign({ makeCore, workerMain }, CORE);
    return;
  }
  if (typeof document === 'undefined') return;

  const { timeline, crop, fmtTime, fmtBytes } = CORE;
  const clampN = CORE.clamp;

  /* ==================================================================== *
   * store                                                                 *
   * ==================================================================== */
  const CHOICES = {
    captureFps: [10, 12, 15, 20, 24],
    captureWidth: [480, 640, 854],
    bufferSeconds: [10, 15, 30],
    outWidth: [320, 480, 640, 0],          // 0 = capture width
    outFps: [5, 8, 10, 12, 15, 20, 24],
    speed: [0.5, 1, 1.5, 2],
    loop: ['forever', 'once', '2', '3', '5'],
    palette: ['global', 'frame'],
    dither: ['none', 'ordered', 'fs'],
  };
  const LABELS = {
    loop: { forever: 'forever', once: 'once', 2: '2 times', 3: '3 times', 5: '5 times' },
    palette: { global: 'global (12 frames)', frame: 'per frame' },
    dither: { none: 'none', ordered: 'ordered (Bayer 4x4)', fs: 'Floyd-Steinberg' },
  };
  const DEFAULTS = {
    captureFps: 15, captureWidth: 640, maxSeconds: 30, bufferSeconds: 15, armOnLoad: false,
    hotkeys: { record: 'Alt+Shift+KeyR', last: 'Alt+Shift+KeyL', toggle: 'Alt+Shift+KeyG' },
    outWidth: 480, outFps: 15, speed: 1, loop: 'forever', palette: 'global', dither: 'ordered',
    filePattern: 'kick_{channel}_{date}.gif', showCounter: true,
  };
  // dy 56 keeps the pill above Kick's control bar (its fullscreen / theater / settings
  // buttons sit in the bottom ~48 px of the player).
  const PILL_DEFAULT = { dx: 12, dy: 56 };
  const UI_DEFAULTS = { pill: PILL_DEFAULT, collapsed: false, hidden: false, editor: { x: null, y: null, w: 880, h: 620, min: false } };

  const gm = {
    get(k) { try { return GM_getValue(k, null); } catch (_) { return null; } },
    set(k, v) { try { GM_setValue(k, v); } catch (_) {} },
  };
  function readJSON(key) {
    const raw = gm.get(key);
    if (raw == null) return {};
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return {}; }
  }
  function pick(v, list, d) { return list.indexOf(v) >= 0 ? v : d; }
  function sanitizeSettings(v) {
    v = v && typeof v === 'object' ? v : {};
    const s = {};
    s.captureFps = pick(Number(v.captureFps), CHOICES.captureFps, DEFAULTS.captureFps);
    s.captureWidth = pick(Number(v.captureWidth), CHOICES.captureWidth, DEFAULTS.captureWidth);
    s.maxSeconds = clampN(Math.round(Number(v.maxSeconds) || DEFAULTS.maxSeconds), 10, 60);
    s.bufferSeconds = pick(Number(v.bufferSeconds), CHOICES.bufferSeconds, DEFAULTS.bufferSeconds);
    s.armOnLoad = typeof v.armOnLoad === 'boolean' ? v.armOnLoad : DEFAULTS.armOnLoad;
    const hk = v.hotkeys && typeof v.hotkeys === 'object' ? v.hotkeys : {};
    s.hotkeys = {};
    for (const k of Object.keys(DEFAULTS.hotkeys)) s.hotkeys[k] = typeof hk[k] === 'string' && hk[k] ? hk[k] : DEFAULTS.hotkeys[k];
    s.outWidth = pick(Number(v.outWidth), CHOICES.outWidth, DEFAULTS.outWidth);
    s.outFps = pick(Number(v.outFps), CHOICES.outFps, DEFAULTS.outFps);
    s.speed = pick(Number(v.speed), CHOICES.speed, DEFAULTS.speed);
    s.loop = pick(String(v.loop), CHOICES.loop, DEFAULTS.loop);
    s.palette = pick(v.palette, CHOICES.palette, DEFAULTS.palette);
    s.dither = pick(v.dither, CHOICES.dither, DEFAULTS.dither);
    s.filePattern = typeof v.filePattern === 'string' && v.filePattern.trim() ? v.filePattern.trim().slice(0, 120) : DEFAULTS.filePattern;
    s.showCounter = typeof v.showCounter === 'boolean' ? v.showCounter : DEFAULTS.showCounter;
    return s;
  }
  const settings = sanitizeSettings(readJSON('kgc:settings'));
  const ui = (function () {
    const v = readJSON('kgc:ui');
    const o = JSON.parse(JSON.stringify(UI_DEFAULTS));
    if (v.pill && isFinite(v.pill.dx) && isFinite(v.pill.dy)) o.pill = { dx: +v.pill.dx, dy: +v.pill.dy };
    o.collapsed = !!v.collapsed; o.hidden = !!v.hidden;
    if (v.editor && typeof v.editor === 'object') Object.assign(o.editor, v.editor);
    return o;
  })();
  const saveSettings = () => gm.set('kgc:settings', JSON.stringify(settings));
  const saveUi = () => gm.set('kgc:ui', JSON.stringify(ui));

  /* ==================================================================== *
   * DOM helper (DOM APIs only, never HTML strings)                                  *
   * ==================================================================== */
  function el(tag, props, kids) {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids || []) if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
  }
  const isEditable = (t) => !!(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ==================================================================== *
   * CSS - direction B "Graphite Calm"                                     *
   * ==================================================================== */
  const css = `
  .kgc{--bg:#1b1d20;--surface:#1f2124;--raised:#26292d;--border:#34383d;--text:#eceef0;--muted:#9aa2aa;
    --accent:#c6ff3d;--ink:#131509;--rec:#ff4d4d;--warn:#ffb454;--r:10px;--rs:7px;--sel:rgba(198,255,61,.16);
    --film:#16181b;--input:#16181b;--shadow:0 14px 40px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.03) inset;
    font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--text);
    letter-spacing:normal;text-transform:none;text-align:left}
  .kgc *,.kgc *::before,.kgc *::after{box-sizing:border-box;font-family:inherit;letter-spacing:normal}
  .kgc[popover]{margin:0;padding:0;border:0;background:transparent;overflow:visible;inset:auto;color:var(--text)}
  .kgc[popover]::backdrop{background:transparent}
  .kgc button{font:inherit;font-size:12px;cursor:pointer;color:inherit;background:none;border:0;margin:0;line-height:1}
  .kgc button:disabled{opacity:.45;cursor:default}
  .kgc :focus-visible{outline:2px solid rgba(198,255,61,.6);outline-offset:1px}
  .kgc select,.kgc input[type=text],.kgc input[type=number]{height:28px;min-width:0;border-radius:var(--rs);background:var(--input);
    border:1px solid var(--border);color:var(--text);padding:0 7px;font-size:12px;font-variant-numeric:tabular-nums;margin:0}
  .kgc select{padding-right:4px}
  .kgc input[type=checkbox]{accent-color:#c6ff3d;width:16px;height:16px;margin:0}
  .kgc-btn{height:28px;padding:0 10px;border-radius:var(--rs);display:inline-flex;align-items:center;justify-content:center;gap:6px;
    font-weight:600;background:var(--raised)!important;border:1px solid var(--border)!important;white-space:nowrap}
  .kgc-btn.rec{background:var(--rec)!important;border-color:var(--rec)!important;color:#fff}
  .kgc-btn.go,.kgc-btn.acc{background:var(--accent)!important;border-color:var(--accent)!important;color:var(--ink)}
  .kgc-btn.dim{opacity:.55}
  .kgc-btn.on{border-color:var(--accent)!important;color:var(--accent);background:var(--sel)!important}
  .kgc-btn.warn{color:var(--rec);border-color:var(--rec)!important}
  .kgc-btn.ic{width:28px;padding:0;font-weight:700}
  .kgc-btn.grow{flex:1 1 0}

  /* launcher pill */
  #kgc-pill{position:fixed;left:0;top:0;z-index:2147483646}
  .kgc-pillbox{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:5px 6px;max-width:calc(100vw - 16px);
    background:var(--surface);border:1px solid var(--border);border-radius:var(--r);box-shadow:var(--shadow);font-size:12px}
  .kgc-grip{width:10px;height:20px;cursor:move;border-left:2px dotted var(--muted);border-right:2px dotted var(--muted);opacity:.7;margin:0 2px;touch-action:none}
  .kgc-dot{width:8px;height:8px;border-radius:50%;background:#fff;display:inline-block}
  .kgc-rec .kgc-dot{background:var(--rec);animation:kgcpulse 1s infinite}
  @keyframes kgcpulse{0%,100%{opacity:1}50%{opacity:.25}}
  .kgc-tc{font-weight:700;font-variant-numeric:tabular-nums;color:var(--rec);display:inline-flex;align-items:center;gap:6px}
  .kgc-meta{color:var(--muted);font-size:11px;white-space:nowrap}
  .kgc-meta.warn{color:var(--warn)}
  .kgc-chip{height:22px;padding:0 4px 0 8px;border-radius:999px;display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;
    background:var(--sel);color:var(--accent);border:1px solid var(--accent);white-space:nowrap}
  .kgc-chip button{width:16px;height:16px;border-radius:50%;color:var(--accent);font-size:12px}
  .kgc-mini{width:36px;height:36px;border-radius:50%;background:var(--surface)!important;border:1px solid var(--border)!important;box-shadow:var(--shadow);
    font-weight:900!important;font-size:11px!important;color:var(--accent)!important;position:relative;display:flex;align-items:center;justify-content:center}
  .kgc-mini i{position:absolute;right:-2px;top:-2px;width:10px;height:10px;border-radius:50%;background:var(--rec);border:2px solid var(--surface)}
  .kgc-pill-none .kgc-pillbox{opacity:.8}

  /* toast */
  #kgc-toast{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none}
  .kgc-toast{padding:7px 12px;border-radius:var(--r);background:var(--surface);border:1px solid var(--border);box-shadow:var(--shadow);font-size:12px;max-width:min(560px,90vw);overflow-wrap:anywhere}
  .kgc-toast b{color:var(--accent)}
  .kgc-toast.warn b{color:var(--warn)}

  /* panels (editor, settings, modal) */
  .kgc-panel,.kgc-panel[popover]{position:fixed;display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--border)!important;border-radius:var(--r);
    box-shadow:var(--shadow);overflow:hidden}
  .kgc-title{height:36px;flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:0 8px 0 12px;background:var(--surface);
    border-bottom:1px solid var(--border);cursor:move;user-select:none;min-width:0}
  .kgc-title b{font-weight:800;white-space:nowrap}
  .kgc-title .v{color:var(--muted);font-size:11px;white-space:nowrap}
  .kgc-title .info{color:var(--text);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;font-variant-numeric:tabular-nums}
  .kgc-title .wb{margin-left:auto;display:flex;gap:4px;flex:0 0 auto}
  .kgc-title .wb button{width:24px;height:24px;border-radius:var(--rs);background:var(--raised);border:1px solid var(--border);font-size:13px}

  #kgc-editor{resize:both;min-width:640px;min-height:480px;max-width:96vw;max-height:92vh;container-type:inline-size}
  #kgc-editor.min{resize:none;min-height:0;height:auto!important}
  #kgc-editor.min .kgc-ebody,#kgc-editor.min .kgc-foot{display:none}
  .kgc-ebody{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 248px;overflow:hidden}
  @container (max-width:700px){
    .kgc-ebody{grid-template-columns:minmax(0,1fr);grid-auto-rows:auto;overflow-y:auto}
    .kgc-eleft{min-height:0}
    .kgc-preview{flex:none!important;aspect-ratio:16/9}
    .kgc-side{border-left:0!important;border-top:1px solid var(--border);overflow:visible!important}
  }
  .kgc-eleft{display:flex;flex-direction:column;min-width:0;min-height:0;padding:10px}
  .kgc-preview{position:relative;flex:1;min-height:120px;background:#000;border-radius:var(--rs);overflow:hidden;border:1px solid var(--border)}
  .kgc-preview canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
  .kgc-transport{display:flex;align-items:center;gap:8px;min-height:34px;margin-top:8px;flex-wrap:wrap}
  .kgc-transport .tb{width:28px;height:28px;border-radius:var(--rs);background:var(--raised);border:1px solid var(--border);font-size:11px}
  .kgc-transport .tb.play{background:var(--accent);border-color:var(--accent);color:var(--ink);font-weight:800}
  .kgc-transport .tc{font-variant-numeric:tabular-nums}
  .kgc-transport .mut{color:var(--muted)}
  .kgc-transport label{margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--muted);font-size:11px;cursor:pointer}
  .kgc-tl{position:relative;height:58px;margin-top:6px;background:var(--film);border:1px solid var(--border);border-radius:var(--rs);flex:0 0 auto}
  .kgc-tl canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:pointer;touch-action:none}
  .kgc-kept{display:flex;gap:4px 10px;margin-top:6px;font-size:11px;color:var(--muted);flex-wrap:wrap;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
  .kgc-kept b{color:var(--text);font-weight:600}
  .kgc-side{border-left:1px solid var(--border);background:var(--surface);display:flex;flex-direction:column;min-height:0;overflow-y:auto;overflow-x:hidden}
  .kgc-sec{padding:9px 12px;border-bottom:1px solid var(--border)}
  .kgc-sec.active{background:var(--raised)}
  .kgc-sec h4{margin:0 0 7px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);display:flex;align-items:center;gap:6px}
  .kgc-sec h4 .pin{margin-left:auto;font-size:9px;padding:1px 6px;border-radius:999px;background:var(--sel);color:var(--accent);border:1px solid var(--accent);text-transform:none;letter-spacing:0;display:none}
  .kgc-sec.active h4 .pin{display:inline-block}
  .kgc-tip{display:inline-block;width:14px;height:14px;border-radius:50%;border:1px solid var(--muted);color:var(--muted);font-size:9px;text-align:center;line-height:12px;cursor:help;text-transform:none}
  .kgc-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
  .kgc-row:last-child{margin-bottom:0}
  .kgc-lab{font-size:11px;color:var(--muted);min-width:34px}
  .kgc-grid2{display:grid;grid-template-columns:auto minmax(0,1fr) auto minmax(0,1fr);gap:6px;align-items:center;margin-bottom:6px}
  .kgc-grid2 select,.kgc-grid2 input{width:100%}
  .kgc-out{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 8px;align-items:center}
  .kgc-out select{width:100%}
  .kgc-fld{height:28px;min-width:0;border-radius:var(--rs);background:var(--input);border:1px solid var(--border);display:flex;align-items:center;padding:0 7px;font-size:11px;font-variant-numeric:tabular-nums}
  .kgc-est{font-size:11px;color:var(--muted);margin-top:6px}
  .kgc-est b{color:var(--text);font-weight:600}
  .kgc-est.warn,.kgc-est.warn b{color:var(--warn)}
  .kgc-aspects{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px}
  .kgc-aspects .kgc-btn{height:26px;padding:0 8px;font-size:11px}
  .kgc-prog{height:8px;border-radius:999px;background:var(--input);border:1px solid var(--border);overflow:hidden;margin:8px 0}
  .kgc-prog i{display:block;height:100%;width:0;background:var(--accent)}
  .kgc-result{margin:0 12px;border-radius:var(--rs);overflow:hidden;border:1px solid var(--border);background:#000;display:flex;align-items:center;justify-content:center}
  .kgc-result img{max-width:100%;max-height:260px;display:block}
  .kgc-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 10px;font-size:11px;color:var(--muted);padding:8px 12px}
  .kgc-kv b{color:var(--text);font-weight:600;overflow-wrap:anywhere}
  .kgc-link{color:var(--muted)!important;font-size:11px;text-decoration:underline!important;padding:0!important;height:auto!important}
  .kgc-foot{height:46px;flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:0 10px;border-top:1px solid var(--border);background:var(--surface)}
  .kgc-foot .right{margin-left:auto;display:flex;gap:8px}
  .kgc-foot .kgc-btn{height:30px}

  #kgc-settings{width:320px;max-width:calc(100vw - 16px);max-height:calc(100vh - 24px)}
  #kgc-settings .kgc-sbody{overflow-y:auto;overflow-x:hidden;min-height:0}
  #kgc-settings .kgc-sec:nth-child(odd){background:var(--surface)}
  .kgc-hk{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:center;margin-bottom:6px}
  .kgc-hk .kgc-btn{font-size:11px;min-width:96px}
  .kgc-hk .kgc-btn.listen{border-color:var(--accent)!important;color:var(--accent)}

  #kgc-modal{left:50%;top:50%;transform:translate(-50%,-50%);width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 32px)}
  .kgc-mbody{padding:14px 14px 4px;overflow:auto;overflow-wrap:anywhere}
  .kgc-mbody p{margin:0 0 10px}
  .kgc-mbody textarea{width:100%;height:150px;resize:vertical;background:var(--input);color:var(--text);border:1px solid var(--border);border-radius:var(--rs);padding:6px;font:11px/1.4 Consolas,monospace}
  .kgc-mfoot{display:flex;justify-content:flex-end;gap:8px;padding:10px 14px 14px;flex-wrap:wrap}
  `;

  /* ==================================================================== *
   * popover / top-layer plumbing                                          *
   * ==================================================================== */
  const roots = new Set();   // root elements that should currently be visible
  function popover(node) { node.setAttribute('popover', 'manual'); return node; }
  function show(node) {
    roots.add(node);
    const host = document.fullscreenElement || document.body;
    if (node.parentElement !== host) { try { host.appendChild(node); } catch (_) {} }
    try { if (node.matches(':popover-open')) node.hidePopover(); node.showPopover(); } catch (_) {}
  }
  function hide(node) {
    roots.delete(node);
    try { if (node.matches(':popover-open')) node.hidePopover(); } catch (_) {}
    node.remove();
  }
  // Self-heal: Kick's SPA renders and other extensions can detach or close us.
  function heal() {
    const host = document.fullscreenElement || document.body;
    for (const n of roots) {
      if (n.parentElement !== host) { try { host.appendChild(n); } catch (_) {} }
      try { if (!n.matches(':popover-open')) n.showPopover(); } catch (_) {}
    }
  }
  // Keep the stacking order sensible after fullscreen: pill, editor, settings, modal, toast.
  function restack() {
    const order = [pill.root, editor && editor.root, settingsUi && settingsUi.root, modalRoot, toastRoot];
    for (const n of order) if (n && roots.has(n)) show(n);
  }

  // Drag a fixed-position element by a handle.
  function makeDraggable(node, handle, onEnd) {
    let sx, sy, ox, oy, on = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target.closest && e.target.closest('button,input,select,a'))) return;
      on = true;
      const r = node.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      node.style.transform = 'none'; node.style.left = ox + 'px'; node.style.top = oy + 'px';
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!on) return;
      const r = node.getBoundingClientRect();
      const nx = clampN(ox + e.clientX - sx, 0, Math.max(0, innerWidth - Math.min(r.width, 60)));
      const ny = clampN(oy + e.clientY - sy, 0, Math.max(0, innerHeight - 30));
      node.style.left = nx + 'px'; node.style.top = ny + 'px';
    });
    const end = () => { if (!on) return; on = false; if (onEnd) onEnd(node.getBoundingClientRect()); };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // Keep Kick's own shortcuts from reacting to typing inside our panels.
  function shield(node) {
    node.addEventListener('keydown', (e) => e.stopPropagation());
    node.addEventListener('keyup', (e) => e.stopPropagation());
    node.addEventListener('keypress', (e) => e.stopPropagation());
  }

  /* ==================================================================== *
   * toast + modal                                                         *
   * ==================================================================== */
  const toastRoot = popover(el('div', { id: 'kgc-toast', class: 'kgc', role: 'status', 'aria-live': 'polite' }));
  function toast(strong, rest, warn) {
    const t = el('div', { class: 'kgc-toast' + (warn ? ' warn' : '') }, [el('b', { text: strong }), rest ? ' ' + rest : null]);
    toastRoot.appendChild(t);
    show(toastRoot);
    setTimeout(() => { t.remove(); if (!toastRoot.childElementCount) hide(toastRoot); }, warn ? 5200 : 3400);
  }

  const modalRoot = popover(el('div', { id: 'kgc-modal', class: 'kgc kgc-panel', role: 'dialog', 'aria-modal': 'true' }));
  shield(modalRoot);
  let modalResolve = null;
  // Never closes on outside click; Esc = cancel.
  function modal(opts) {
    if (modalResolve) modalResolve(false);
    modalRoot.textContent = '';
    return new Promise((resolve) => {
      modalResolve = resolve;
      const done = (v) => { if (modalResolve !== resolve) return; modalResolve = null; hide(modalRoot); resolve(v); };
      const btns = [];
      if (opts.cancel !== false) btns.push(el('button', { class: 'kgc-btn', type: 'button', text: opts.cancel || 'Cancel', 'aria-label': opts.cancel || 'Cancel', onclick: () => done(false) }));
      btns.push(el('button', { class: 'kgc-btn ' + (opts.danger ? 'warn' : 'acc'), type: 'button', text: opts.ok || 'OK', 'aria-label': opts.ok || 'OK', onclick: () => done(true) }));
      const title = el('div', { class: 'kgc-title' }, [el('b', { text: opts.title || 'GIF Clipper' }),
        el('div', { class: 'wb' }, [el('button', { type: 'button', text: '×', title: 'Close', 'aria-label': 'Close dialog', onclick: () => done(false) })])]);
      modalRoot.append(title, el('div', { class: 'kgc-mbody' }, [].concat(opts.body || []).map((b) => (typeof b === 'string' ? el('p', { text: b }) : b))),
        el('div', { class: 'kgc-mfoot' }, btns));
      modalRoot.onkeydown = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        else if (e.key === 'Tab') trapTab(e, modalRoot);
      };
      makeDraggable(modalRoot, title);
      modalRoot.style.left = ''; modalRoot.style.top = ''; modalRoot.style.transform = '';
      show(modalRoot);
      // Destructive dialogs start on Cancel so Enter never discards by accident.
      setTimeout(() => btns[opts.danger ? 0 : btns.length - 1].focus(), 0);
    });
  }
  function focusables(root) {
    return Array.from(root.querySelectorAll('button,select,input,textarea,a[href],[tabindex="0"]'))
      .filter((n) => !n.disabled && n.offsetParent !== null);
  }
  function trapTab(e, root) {
    const f = focusables(root);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    e.preventDefault();
    const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i >= f.length - 1 ? 0 : i + 1);
    f[next].focus();
  }

  /* ==================================================================== *
   * player                                                                *
   * ==================================================================== */
  // Largest on-screen <video> that has frames. Never chosen by src: Kick keeps
  // a hidden 0x0 static <video> that would taint the canvas.
  function findVideo() {
    let best = null, bestA = 0;
    for (const v of document.querySelectorAll('video')) {
      if (!v.videoWidth || !v.isConnected) continue;
      const r = v.getBoundingClientRect();
      const a = r.width * r.height;
      if (a < CFG.minVideoArea) continue;
      if (a > bestA) { best = v; bestA = a; }
    }
    return best;
  }
  function channelName() {
    const seg = location.pathname.split('/').filter(Boolean)[0] || 'kick';
    return seg.replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'kick';
  }

  /* ==================================================================== *
   * sampler                                                               *
   * ==================================================================== */
  const S = {
    video: null, timer: 0, fps: settings.captureFps, busy: false, lastCT: -1, lastTick: 0,
    canvas: null, ctx: null, ring: null, ringCap: 0, rec: null,
    overruns: 0, cpuStep: false, lastErr: '', rvfc: 0, rvfcOn: false, avgBlob: 0, avgTick: 0, lastAchieved: null,
    hiddenAt: 0,
  };
  const recording = () => !!S.rec;
  const armed = () => !!S.ring;

  function needSampler() { return recording() || armed(); }
  function startTimer() {
    clearInterval(S.timer);
    S.timer = setInterval(tick, 1000 / S.fps);
    hookRvfc();
  }
  function ensureSampler() {
    if (needSampler()) { if (!S.timer) startTimer(); }
    else { clearInterval(S.timer); S.timer = 0; }
  }
  // rVFC never fired on Kick's player when measured; if it ever does, it
  // triggers ticks too - whichever fires first wins for that interval.
  function hookRvfc() {
    const v = S.video;
    if (!v || S.rvfcOn || typeof v.requestVideoFrameCallback !== 'function') return;
    S.rvfcOn = true;
    const cb = () => {
      if (S.video !== v || !needSampler()) { S.rvfcOn = false; return; }
      S.rvfc++;
      if (performance.now() - S.lastTick >= 1000 / S.fps * 0.9) tick();
      v.requestVideoFrameCallback(cb);
    };
    try { v.requestVideoFrameCallback(cb); } catch (_) { S.rvfcOn = false; }
  }

  async function tick() {
    const v = S.video;
    if (!v || !v.isConnected || !needSampler()) return;
    const now = performance.now();
    if (now - S.lastTick < 1000 / S.fps * 0.5) return;  // timer + rVFC both fired
    S.lastTick = now;
    if (S.rec && now - S.rec.t0 >= settings.maxSeconds * 1000) { stopRecording('max'); return; }
    if (document.hidden) { if (S.rec) S.rec.dropped++; return; }
    if (S.busy) { if (S.rec) S.rec.dropped++; return; }
    const ct = v.currentTime;
    if (ct === S.lastCT || v.readyState < 2 || !v.videoWidth) { if (S.rec) S.rec.dropped++; return; }
    S.lastCT = ct;
    S.busy = true;
    const t0 = performance.now();
    try {
      const w = CORE.even(Math.min(settings.captureWidth, v.videoWidth));
      const h = CORE.even(w * v.videoHeight / v.videoWidth);
      if (!S.canvas) { S.canvas = new OffscreenCanvas(w, h); S.ctx = S.canvas.getContext('2d', { alpha: false }); }
      if (S.canvas.width !== w || S.canvas.height !== h) { S.canvas.width = w; S.canvas.height = h; }
      S.ctx.drawImage(v, 0, 0, w, h);
      const blob = await S.canvas.convertToBlob({ type: 'image/webp', quality: CFG.webpQuality });
      const f = { t: t0, blob, w, h };
      S.avgBlob = S.avgBlob ? S.avgBlob * 0.9 + blob.size * 0.1 : blob.size;
      if (S.ring) {
        S.ring.push(f);
        while (S.ring.length > S.ringCap) S.ring.shift();
      }
      if (S.rec) { S.rec.frames.push(f); S.rec.bytes += blob.size; }
    } catch (e) {
      S.lastErr = (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e));
      if (e && e.name === 'SecurityError') {
        const was = recording();
        disarm(true);
        if (was) stopRecording('taint');
        toast('Cannot read this player.', 'The video is cross-origin here, so its pixels are locked.', true);
      }
    } finally {
      S.busy = false;
      const dt = performance.now() - t0;
      S.avgTick = S.avgTick ? S.avgTick * 0.9 + dt * 0.1 : dt;
      // 1.5x so a single GC pause or React render on Kick's side does not count.
      if (needSampler() && dt > 1500 / S.fps) { if (++S.overruns >= 2) stepDown(); } else S.overruns = 0;
    }
  }
  // Capture cannot keep up: lower the fps one step instead of stalling the player.
  function stepDown() {
    S.overruns = 0;
    const i = CFG.fpsSteps.indexOf(S.fps);
    const next = CFG.fpsSteps[i + 1] || (i < 0 ? CFG.fpsSteps.find((f) => f < S.fps) : null);
    if (!next) return;
    S.fps = next; S.cpuStep = true;
    if (S.rec) { S.rec.frames = CORE.decimateByTime(S.rec.frames, next); S.rec.fps = next; S.rec.bytes = S.rec.frames.reduce((a, f) => a + f.blob.size, 0); }
    if (S.ring) { S.ring = CORE.decimateByTime(S.ring, next); S.ringCap = next * settings.bufferSeconds; }
    startTimer();
    renderPill();
  }
  function resetFps() { if (!needSampler()) { S.fps = settings.captureFps; S.cpuStep = false; } }

  function arm() {
    const v = findVideo();
    if (!v) { toast('No player.', 'Open a live channel (and pass any 18+ gate) first.', true); return; }
    S.video = v; resetFps();
    S.ring = []; S.ringCap = S.fps * settings.bufferSeconds;
    ensureSampler(); renderPill();
  }
  function disarm(silent) {
    S.ring = null; ensureSampler(); resetFps(); renderPill();
    if (!silent) toast('Rewind buffer off.', '');
  }
  function startRecording() {
    if (recording()) return;
    const v = findVideo();
    if (!v) { toast('No player on this page.', 'Pass the 18+ gate or open a live channel.', true); return; }
    if (S.video !== v) { S.video = v; S.rvfcOn = false; if (S.ring) S.ring = []; }
    if (!S.ring) resetFps();
    S.lastCT = -1;
    S.rec = { frames: [], t0: performance.now(), startedAt: new Date(), channel: channelName(), path: location.pathname, fps: S.fps, dropped: 0, bytes: 0 };
    ensureSampler(); renderPill();
    pill.timer = setInterval(renderPillLive, 200);
  }
  function stopRecording(reason) {
    const r = S.rec;
    if (!r) return;
    S.rec = null;
    clearInterval(pill.timer);
    ensureSampler(); resetFps();
    const secs = (performance.now() - r.t0) / 1000;
    const achieved = r.frames.length / Math.max(0.001, secs);
    S.lastAchieved = { fps: achieved, frames: r.frames.length, dropped: r.dropped, secs };
    console.log(TAG, `recorded ${r.frames.length} frames in ${secs.toFixed(1)} s (${achieved.toFixed(1)} fps achieved, target ${r.fps}, ${r.dropped} dropped, ${fmtBytes(r.bytes)} WebP)`);
    if (reason === 'max') toast('Max length reached.', 'Recording stopped at ' + fmtTime(secs * 1000) + '.');
    else if (reason === 'player') toast('Player changed', '- recording stopped at ' + fmtTime(secs * 1000) + '.', true);
    else if (reason === 'nav') toast('Channel changed', '- recording stopped at ' + fmtTime(secs * 1000) + '.', true);
    renderPill();
    if (reason === 'taint') return;
    if (r.frames.length < 2) {
      modal({ title: 'Nothing to edit', body: ['Nothing moved - was the stream paused?', 'Only ' + r.frames.length + (r.frames.length === 1 ? ' frame was' : ' frames were') + ' captured. The video has to be playing and the tab visible while recording.'], cancel: false, ok: 'OK' });
      return;
    }
    openEditor({ frames: r.frames, fps: r.fps, channel: r.channel, startedAt: r.startedAt, dropped: r.dropped });
  }
  function toggleRecord() { if (recording()) stopRecording('user'); else startRecording(); }
  function clipLast() {
    if (!armed()) { arm(); if (armed()) toast('Rewind buffer armed.', '"Last ' + settings.bufferSeconds + ' s" fills as the stream plays.'); return; }
    if (S.ring.length < 2) { toast('Buffer still empty.', 'Give it a second while the stream plays.', true); return; }
    const frames = S.ring.slice();
    const secs = (frames[frames.length - 1].t - frames[0].t) / 1000;
    console.log(TAG, `froze rewind buffer: ${frames.length} frames, ${secs.toFixed(1)} s`);
    openEditor({ frames, fps: S.fps, channel: channelName(), startedAt: new Date(Date.now() - secs * 1000), dropped: 0 });
  }

  // Watchdog: player swaps, SPA navigation, hidden tab.
  let lastPath = location.pathname;
  setInterval(() => {
    const v = findVideo();
    if (recording()) {
      if (location.pathname !== S.rec.path && channelName() !== S.rec.channel) stopRecording('nav');
      else if (!S.video || !S.video.isConnected || (v && v !== S.video)) stopRecording('player');
    } else if (armed() && v !== S.video) {
      if (v) { S.video = v; S.ring = []; S.rvfcOn = false; hookRvfc(); } else disarm(true);
    }
    if (location.pathname !== lastPath) { lastPath = location.pathname; if (armed() && channelName() !== lastPath) { /* ring follows the new player above */ } }
    renderPillState(v);
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { S.hiddenAt = performance.now(); renderPill(); return; }
    if (S.hiddenAt && recording()) {
      const gone = (performance.now() - S.hiddenAt) / 1000;
      if (gone > 0.3) toast('Tab was hidden ' + gone.toFixed(1) + ' s', '- those frames are missing from the recording.', true);
    }
    S.hiddenAt = 0; renderPill();
  });

  /* ==================================================================== *
   * launcher pill                                                         *
   * ==================================================================== */
  const pill = { root: null, timer: 0, state: '' };
  function buildPill() {
    const P = pill;
    P.root = popover(el('div', { id: 'kgc-pill', class: 'kgc', role: 'toolbar', 'aria-label': 'GIF Clipper launcher' }));
    shield(P.root);
    P.grip = el('span', { class: 'kgc-grip', title: 'Drag to move (the position follows the player). Double-click to reset.', 'aria-hidden': 'true' });
    P.none = el('span', { class: 'kgc-meta', text: 'GIF Clipper · no player on this page' });
    P.rec = el('button', { class: 'kgc-btn rec', type: 'button', 'aria-label': 'Start recording', onclick: toggleRecord });
    P.tc = el('span', { class: 'kgc-tc' });
    P.meta = el('span', { class: 'kgc-meta' });
    P.note = el('span', { class: 'kgc-meta warn' });
    P.last = el('button', { class: 'kgc-btn', type: 'button', onclick: clipLast });
    P.chipTxt = el('span');
    P.chip = el('span', { class: 'kgc-chip', title: 'Rewind buffer is running: it keeps the last few seconds so you can clip a moment after it happens.' }, [P.chipTxt,
      el('button', { type: 'button', text: '×', title: 'Turn the rewind buffer off (frees its memory)', 'aria-label': 'Turn rewind buffer off', onclick: () => disarm() })]);
    P.gear = el('button', { class: 'kgc-btn ic', type: 'button', text: '⚙', title: 'Settings: capture fps / width, rewind buffer, hotkeys, output defaults', 'aria-label': 'Settings', onclick: () => toggleSettings() });
    P.min = el('button', { class: 'kgc-btn ic', type: 'button', text: '−', title: 'Collapse to a small GIF button (hotkeys keep working)', 'aria-label': 'Collapse launcher', onclick: () => setCollapsed(true) });
    P.box = el('div', { class: 'kgc-pillbox' }, [P.grip, P.none, P.rec, P.tc, P.meta, P.note, P.last, P.chip, P.gear, P.min]);
    P.miniDot = el('i', { hidden: true });
    P.mini = el('button', { class: 'kgc-mini', type: 'button', text: 'GIF', title: 'GIF Clipper - click to expand', 'aria-label': 'Expand GIF Clipper launcher', onclick: () => setCollapsed(false) }, [P.miniDot]);
    P.root.append(P.box, P.mini);
    P.grip.addEventListener('dblclick', () => { ui.pill = Object.assign({}, PILL_DEFAULT); saveUi(); placePill(); });
    pillDrag(P.grip);
    renderPill();
    if (!ui.hidden) show(P.root);
    placePill();
    addEventListener('resize', placePill);
    addEventListener('scroll', () => requestAnimationFrame(placePill), { passive: true, capture: true });
    setInterval(placePill, 500);
  }
  function anchorRect() {
    const v = S.video && S.video.isConnected ? S.video : findVideo();
    if (v) { const r = v.getBoundingClientRect(); if (r.width > 0) return r; }
    return { right: innerWidth, bottom: innerHeight };
  }
  // The pill is stored as an offset from the player's bottom-right corner, so
  // theater / fullscreen / window resizes keep it on the video.
  function placePill() {
    const R = pill.root;
    if (!R || !roots.has(R) || pill.dragging) return;
    const a = anchorRect(), r = R.getBoundingClientRect();
    const left = clampN(a.right - ui.pill.dx - r.width, 4, Math.max(4, innerWidth - r.width - 4));
    const top = clampN(a.bottom - ui.pill.dy - r.height, 4, Math.max(4, innerHeight - r.height - 4));
    R.style.left = Math.round(left) + 'px'; R.style.top = Math.round(top) + 'px';
  }
  function pillDrag(handle) {
    const R = () => pill.root;
    let sx, sy, ox, oy;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = R().getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top; pill.dragging = true;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!pill.dragging) return;
      const r = R().getBoundingClientRect();
      R().style.left = clampN(ox + e.clientX - sx, 4, innerWidth - r.width - 4) + 'px';
      R().style.top = clampN(oy + e.clientY - sy, 4, innerHeight - r.height - 4) + 'px';
    });
    const end = () => {
      if (!pill.dragging) return;
      pill.dragging = false;
      const r = R().getBoundingClientRect(), a = anchorRect();
      ui.pill = { dx: Math.round(a.right - r.right), dy: Math.round(a.bottom - r.bottom) };
      saveUi();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
  function setCollapsed(v) { ui.collapsed = v; saveUi(); renderPill(); placePill(); }
  function setHidden(v) { ui.hidden = v; saveUi(); if (v) { hide(pill.root); if (settingsUi) closeSettings(); } else { show(pill.root); renderPill(); placePill(); } }
  function hkLabel(combo) { return String(combo).replace(/Key([A-Z])/, '$1').replace(/Digit(\d)/, '$1'); }

  function renderPillState(v) {
    const state = recording() ? 'rec' : (v || findVideo()) ? 'idle' : 'none';
    if (state !== pill.state) renderPill();
  }
  function renderPill() {
    const P = pill;
    if (!P.root) return;
    const hasVideo = !!findVideo();
    const rec = recording();
    P.state = rec ? 'rec' : hasVideo ? 'idle' : 'none';
    P.root.classList.toggle('kgc-rec', rec);
    P.root.classList.toggle('kgc-pill-none', P.state === 'none');
    P.box.hidden = ui.collapsed; P.mini.hidden = !ui.collapsed;
    P.box.style.display = ui.collapsed ? 'none' : ''; P.mini.style.display = ui.collapsed ? '' : 'none';
    P.miniDot.hidden = !rec;
    P.none.hidden = P.state !== 'none';
    P.rec.hidden = P.state === 'none';
    P.rec.textContent = '';
    if (rec) {
      P.rec.append('■ Stop');
      P.rec.title = 'Stop recording and open the editor (' + hkLabel(settings.hotkeys.record) + ')';
      P.rec.setAttribute('aria-label', 'Stop recording');
    } else {
      P.rec.append(el('span', { class: 'kgc-dot' }), 'Record');
      P.rec.title = 'Record the stream until you press Stop (max ' + settings.maxSeconds + ' s). Hotkey ' + hkLabel(settings.hotkeys.record);
      P.rec.setAttribute('aria-label', 'Start recording');
    }
    P.tc.hidden = !rec; P.meta.hidden = !rec || !settings.showCounter;
    P.last.hidden = rec || P.state === 'none';
    P.last.textContent = '⟲ Last ' + settings.bufferSeconds + ' s';
    P.last.className = 'kgc-btn ' + (armed() ? 'go' : 'dim');
    P.last.title = armed()
      ? 'Turn the last ' + settings.bufferSeconds + ' s into a clip and open the editor (' + hkLabel(settings.hotkeys.last) + ')'
      : 'Rewind buffer is off. Click to arm it: it keeps the last ' + settings.bufferSeconds + ' s in memory so you can clip a moment after it happens.';
    P.last.setAttribute('aria-label', armed() ? 'Clip the last ' + settings.bufferSeconds + ' seconds' : 'Arm the rewind buffer');
    P.chip.hidden = !armed() || rec;
    P.gear.hidden = rec;
    renderPillLive();
  }
  function renderPillLive() {
    const P = pill;
    if (!P.root) return;
    const notes = [];
    if (document.hidden && (recording() || armed())) notes.push('paused - tab hidden');
    if (S.cpuStep && needSampler()) notes.push('capture at ' + S.fps + ' fps (CPU)');
    P.note.textContent = notes.join(' · ');
    P.note.hidden = !notes.length;
    if (recording()) {
      const r = S.rec, ms = performance.now() - r.t0;
      P.tc.textContent = '';
      P.tc.append(el('span', { class: 'kgc-dot' }), fmtTime(ms));
      P.meta.textContent = r.frames.length + ' frames · ~' + fmtBytes(r.bytes);
      P.root.setAttribute('aria-label', 'GIF Clipper recording ' + fmtTime(ms));
    }
    if (armed()) {
      const n = S.ring.length;
      const secs = n ? (S.ring[n - 1].t - S.ring[0].t) / 1000 : 0;
      const full = n >= S.ringCap - 1;
      const mb = fmtBytes(S.ring.reduce((a, f) => a + f.blob.size, 0));
      P.chipTxt.textContent = full ? '⟲ ' + settings.bufferSeconds + ' s ready · ' + mb : '⟲ ' + Math.floor(secs) + ' / ' + settings.bufferSeconds + ' s · ' + mb;
    }
  }
  setInterval(() => { if (armed() && !recording()) renderPillLive(); }, 1000);

  /* ==================================================================== *
   * editor                                                                *
   * ==================================================================== */
  let editor = null;

  function lruGet(E, i) {
    const c = E.cache;
    if (c.has(i)) { const b = c.get(i); c.delete(i); c.set(i, b); return Promise.resolve(b); }
    if (E.pending.has(i)) return E.pending.get(i);
    const f = E.clip.frames[i];
    if (!f) return Promise.resolve(null);
    const p = createImageBitmap(f.blob).then((b) => {
      E.pending.delete(i);
      if (E.closed) { b.close(); return null; }
      c.set(i, b);
      while (c.size > CFG.decodeCache) { const k = c.keys().next().value; const old = c.get(k); c.delete(k); try { old.close(); } catch (_) {} }
      return b;
    }).catch(() => { E.pending.delete(i); return null; });
    E.pending.set(i, p);
    return p;
  }

  function openEditor(clip) {
    if (editor) {
      // One clip at a time: the old editor is replaced only after a confirm.
      modal({ title: 'Replace clip?', body: ['The editor already has a clip open. Discard it and open the new one?'], ok: 'Discard and open', danger: true })
        .then((ok) => { if (ok) { closeEditor(); openEditor(clip); } else clip.frames.length = 0; });
      return;
    }
    if (settingsUi) closeSettings();
    const f0 = clip.frames[0];
    clip.w = f0.w; clip.h = f0.h;
    const n = clip.frames.length;
    const E = editor = {
      clip, n, segs: timeline.reset(n), sel: { from: 0, to: n }, play: 0, playing: false, playTimer: 0,
      mode: 'trim', crop: null, aspect: null, loopPreview: true,
      out: { width: settings.outWidth, fps: Math.min(settings.outFps, clip.fps), speed: settings.speed, loop: settings.loop, palette: settings.palette, dither: settings.dither },
      cache: new Map(), pending: new Map(), thumbs: [], closed: false, view: 'edit', job: null, result: null, downloaded: false,
      memBefore: performance.memory ? performance.memory.usedJSHeapSize : 0,
    };
    buildEditorDom(E);
    renderEditor();
    show(E.root);
    placeEditor(E);
    makeThumbs(E);
    drawPreview();
    setTimeout(() => E.prevCanvas.focus(), 0);
  }

  function placeEditor(E) {
    const R = E.root, s = ui.editor;
    const w = clampN(s.w || 880, 640, innerWidth * 0.96), h = clampN(s.h || 620, 480, innerHeight * 0.92);
    R.style.width = Math.round(w) + 'px';
    if (!s.min) R.style.height = Math.round(h) + 'px';
    const x = s.x == null ? (innerWidth - w) / 2 : clampN(s.x, 0, Math.max(0, innerWidth - 120));
    const y = s.y == null ? (innerHeight - h) / 2 : clampN(s.y, 0, Math.max(0, innerHeight - 40));
    R.style.left = Math.round(x) + 'px'; R.style.top = Math.round(y) + 'px';
  }

  function tip(text) { return el('span', { class: 'kgc-tip', text: '?', title: text, 'aria-label': text, tabindex: '0', role: 'note' }); }
  function select(opts, value, label, title, onchange) {
    const s = el('select', { 'aria-label': label, title });
    for (const [v, t] of opts) s.appendChild(el('option', { value: String(v), text: t }));
    s.value = String(value);
    s.addEventListener('change', () => onchange(s.value));
    return s;
  }
  function btn(text, cls, title, onclick, aria) { return el('button', { class: 'kgc-btn ' + (cls || ''), type: 'button', text, title, 'aria-label': aria || title || text, onclick }); }

  function buildEditorDom(E) {
    const R = E.root = popover(el('div', { id: 'kgc-editor', class: 'kgc kgc-panel' + (ui.editor.min ? ' min' : ''), role: 'dialog', 'aria-label': 'GIF Clipper editor' }));
    shield(R);
    // title
    E.info = el('span', { class: 'info' });
    E.minBtn = el('button', { type: 'button', text: ui.editor.min ? '+' : '−', title: 'Collapse / expand the editor', 'aria-label': 'Collapse editor', onclick: () => {
      ui.editor.min = !ui.editor.min; saveUi(); R.classList.toggle('min', ui.editor.min); E.minBtn.textContent = ui.editor.min ? '+' : '−';
      if (!ui.editor.min) R.style.height = clampN(ui.editor.h || 620, 480, innerHeight * 0.92) + 'px';
    } });
    const title = el('div', { class: 'kgc-title' }, [el('b', { text: 'GIF Clipper' }), el('span', { class: 'v', text: 'v' + VERSION }), E.info,
      el('div', { class: 'wb' }, [E.minBtn, el('button', { type: 'button', text: '×', title: 'Close the editor (asks before discarding an unsaved clip)', 'aria-label': 'Close editor', onclick: () => askDiscard() })])]);
    makeDraggable(R, title, (r) => { ui.editor.x = Math.round(r.left); ui.editor.y = Math.round(r.top); saveUi(); });

    // preview
    E.prevCanvas = el('canvas', { tabindex: '0', 'aria-label': 'Preview. Space plays, arrow keys step a frame, I and O set in and out. In crop mode drag to draw the crop.' });
    E.prevWrap = el('div', { class: 'kgc-preview' }, [E.prevCanvas]);
    // transport
    E.playBtn = el('button', { class: 'tb play', type: 'button', text: '▶', title: 'Play / pause the kept frames at the output fps (Space)', 'aria-label': 'Play', onclick: togglePlay });
    E.tcCur = el('span', { class: 'tc' }); E.tcTot = el('span', { class: 'mut' });
    E.loopChk = el('input', { type: 'checkbox', checked: true, 'aria-label': 'Loop the preview', title: 'Loop the preview playback (does not change the GIF loop setting)' });
    E.loopChk.addEventListener('change', () => { E.loopPreview = E.loopChk.checked; });
    const transport = el('div', { class: 'kgc-transport' }, [
      el('button', { class: 'tb', type: 'button', text: '|<', title: 'Go to the first kept frame', 'aria-label': 'First kept frame', onclick: () => { stopPlay(); setPlay(firstKept()); } }),
      E.playBtn,
      el('button', { class: 'tb', type: 'button', text: '>|', title: 'Go to the last kept frame', 'aria-label': 'Last kept frame', onclick: () => { stopPlay(); setPlay(lastKept()); } }),
      E.tcCur, E.tcTot,
      el('label', { title: 'Loop the preview playback (does not change the GIF loop setting)' }, ['Loop', E.loopChk]),
    ]);
    // timeline
    E.tlCanvas = el('canvas', { tabindex: '0', 'aria-label': 'Timeline. Drag the green handles to set in and out; click to move the playhead. Removed ranges are hatched.' });
    E.tlWrap = el('div', { class: 'kgc-tl' }, [E.tlCanvas]);
    E.kept = el('div', { class: 'kgc-kept' });
    const left = el('div', { class: 'kgc-eleft' }, [E.prevWrap, transport, E.tlWrap, E.kept]);

    // side: crop
    E.aspectBtns = [];
    const aspects = [['Free', null], ['16:9', 16 / 9], ['1:1', 1], ['4:5', 4 / 5], ['9:16', 9 / 16]];
    const aspWrap = el('div', { class: 'kgc-aspects' });
    for (const [lab, a] of aspects) {
      const b = btn(lab, '', a ? 'Lock the crop to ' + lab + ' (good for ' + (a > 1 ? 'chat embeds' : a === 1 ? 'avatars and square posts' : 'phone-shaped posts') + ')' : 'Free crop: any shape', () => setAspect(a), 'Aspect ' + lab);
      b.dataset.a = String(a); E.aspectBtns.push(b); aspWrap.appendChild(b);
    }
    E.cx = numInput('x', 'Crop left edge in source pixels'); E.cy = numInput('y', 'Crop top edge in source pixels');
    E.cw = numInput('w', 'Crop width in source pixels (min 32)'); E.ch = numInput('h', 'Crop height in source pixels (min 32)');
    for (const inp of [E.cx, E.cy, E.cw, E.ch]) inp.addEventListener('change', () => cropFromFields(inp));
    E.secCrop = el('div', { class: 'kgc-sec' }, [
      el('h4', null, ['Crop', tip('Crop keeps only part of the picture, which makes the GIF smaller and focuses on the moment. It is applied at export, so the captured frames are never touched.'), el('span', { class: 'pin', text: 'editing' })]),
      aspWrap,
      el('div', { class: 'kgc-grid2' }, [el('span', { class: 'kgc-lab', text: 'x' }), E.cx, el('span', { class: 'kgc-lab', text: 'y' }), E.cy]),
      el('div', { class: 'kgc-grid2' }, [el('span', { class: 'kgc-lab', text: 'w' }), E.cw, el('span', { class: 'kgc-lab', text: 'h' }), E.ch]),
      el('div', { class: 'kgc-row' }, [btn('Edit crop', '', 'Draw the crop on the preview (drag), or move its 8 handles', () => setMode(E.mode === 'crop' ? 'trim' : 'crop')), btn('Reset crop', '', 'Remove the crop and use the whole picture', () => { E.crop = null; E.aspect = null; renderEditor(); drawPreview(); })]),
    ]);
    E.editCropBtn = E.secCrop.querySelector('.kgc-row:last-child button');
    // side: trim
    E.inFld = el('span', { class: 'kgc-fld', title: 'Selection start. Press I to set it at the playhead, or drag the left handle.' });
    E.outFld = el('span', { class: 'kgc-fld', title: 'Selection end. Press O to set it at the playhead, or drag the right handle.' });
    E.secTrim = el('div', { class: 'kgc-sec' }, [
      el('h4', null, ['Trim / cut', tip('Pick a range with the handles. Keep selection trims the clip to it; Remove selection cuts it out of the middle. Kept ranges are listed under the timeline.'), el('span', { class: 'pin', text: 'editing' })]),
      el('div', { class: 'kgc-grid2' }, [el('span', { class: 'kgc-lab', text: 'in' }), E.inFld, el('span', { class: 'kgc-lab', text: 'out' }), E.outFld]),
      el('div', { class: 'kgc-row' }, [btn('Keep selection', 'acc grow', 'Trim the clip to the selected range', () => applyTrim('keep')), btn('Remove selection', 'warn grow', 'Cut the selected range out of the clip', () => applyTrim('remove'))]),
      el('div', { class: 'kgc-row' }, [btn('Reset', '', 'Bring back every captured frame', () => { E.segs = timeline.reset(E.n); E.sel = { from: 0, to: E.n }; renderEditor(); drawPreview(); }), el('span', { class: 'kgc-est', text: 'I / O set in / out at playhead', style: 'margin-top:0' })]),
    ]);
    E.secCrop.addEventListener('pointerdown', (e) => { if (E.mode !== 'crop' && e.target !== E.editCropBtn) setMode('crop'); });
    E.secTrim.addEventListener('pointerdown', () => { if (E.mode !== 'trim') setMode('trim'); });
    // side: output
    const o = E.out;
    E.widthSel = select([], o.width, 'Output width', 'GIF width in pixels. Height follows the crop shape. Smaller = much smaller file.', (v) => { o.width = +v; renderEditor(); });
    E.fpsSel = select([], o.fps, 'Output fps', 'Frames per second in the GIF. Lower fps drops frames evenly and shrinks the file. Cannot exceed the capture fps.', (v) => { o.fps = +v; renderEditor(); });
    E.speedSel = select(CHOICES.speed.map((s) => [s, s + 'x']), o.speed, 'Playback speed', 'Plays the GIF faster or slower by changing the frame delay; the frames stay the same.', (v) => { o.speed = +v; renderEditor(); });
    E.loopSel = select(CHOICES.loop.map((l) => [l, LABELS.loop[l]]), o.loop, 'GIF loop', 'How many times the GIF plays. Forever is what chat apps expect.', (v) => { o.loop = v; renderEditor(); });
    E.palSel = select(CHOICES.palette.map((p) => [p, LABELS.palette[p]]), o.palette, 'Palette', 'Global: one 256-colour table for the whole GIF (smaller, no colour flicker). Per frame: each frame gets its own table (better colour on fast-changing clips, bigger file).', (v) => { o.palette = v; renderEditor(); });
    E.dithSel = select(CHOICES.dither.map((d) => [d, LABELS.dither[d]]), o.dither, 'Dither', 'Dithering hides colour banding with a fine pattern. Ordered is steady between frames; Floyd-Steinberg looks smoother on stills but shimmers and compresses worse; none is smallest.', (v) => { o.dither = v; renderEditor(); });
    E.est = el('div', { class: 'kgc-est' });
    E.secOut = el('div', { class: 'kgc-sec' }, [
      el('h4', null, ['Output', tip('These settings only affect the exported GIF. The estimate updates as you change them.')]),
      el('div', { class: 'kgc-out' }, [
        el('span', { class: 'kgc-lab', text: 'width' }), E.widthSel, el('span', { class: 'kgc-lab', text: 'fps' }), E.fpsSel,
        el('span', { class: 'kgc-lab', text: 'speed' }), E.speedSel, el('span', { class: 'kgc-lab', text: 'loop' }), E.loopSel,
        el('span', { class: 'kgc-lab', text: 'palette' }), E.palSel, el('span', { class: 'kgc-lab', text: 'dither' }), E.dithSel,
      ]),
      E.est,
    ]);
    E.vEdit = el('div', null, [E.secCrop, E.secTrim, E.secOut]);
    // side: exporting
    E.progTxt = el('div', { class: 'kgc-est' }); E.progBar = el('i');
    E.vExp = el('div', { hidden: true }, [el('div', { class: 'kgc-sec' }, [el('h4', { text: 'Exporting' }), E.progTxt, el('div', { class: 'kgc-prog' }, [E.progBar]),
      el('div', { class: 'kgc-est', text: 'Encoding runs in a background worker; the stream keeps playing.' })])]);
    // side: done
    E.resImg = el('img', { alt: 'Exported GIF' });
    E.resKv = el('div', { class: 'kgc-kv' });
    E.vDone = el('div', { hidden: true }, [el('div', { class: 'kgc-sec', style: 'border-bottom:0' }, [el('h4', { text: 'Result' })]), el('div', { class: 'kgc-result' }, [E.resImg]), E.resKv,
      el('div', { class: 'kgc-sec' }, [el('div', { class: 'kgc-row' }, [btn('Back to editor', 'grow', 'Change trim / crop / output and export again', () => setView('edit')), btn('New clip', 'grow', 'Close this clip and go back to the launcher', () => closeEditor())]),
        el('div', { class: 'kgc-row' }, [el('button', { class: 'kgc-link', type: 'button', text: 'Download did not start?', title: 'Shows a link you can right-click and save', onclick: manualSave })])])]);
    const side = el('div', { class: 'kgc-side' }, [E.vEdit, E.vExp, E.vDone]);
    const body = el('div', { class: 'kgc-ebody' }, [left, side]);
    // footer
    E.exportBtn = btn('Export GIF', 'acc', 'Encode the GIF with the current trim, crop and output settings', () => startExport());
    E.cancelBtn = btn('Cancel export', '', 'Stop encoding; nothing is saved', () => cancelExport());
    E.dlBtn = btn('Download GIF', 'acc', 'Save the GIF to your downloads folder', () => download());
    const foot = el('div', { class: 'kgc-foot' }, [btn('Discard', 'warn', 'Throw this clip away (asks first)', () => askDiscard()), el('div', { class: 'right' }, [E.cancelBtn, E.exportBtn, E.dlBtn])]);
    R.append(title, body, foot);

    // resizing: persist size; redraw canvases
    let st;
    E.ro = new ResizeObserver(() => {
      sizeCanvas(E.prevCanvas, E.prevWrap); sizeCanvas(E.tlCanvas, E.tlWrap); drawPreview(true); drawTimeline();
      clearTimeout(st);
      st = setTimeout(() => { if (ui.editor.min || E.closed) return; const r = R.getBoundingClientRect(); ui.editor.w = Math.round(r.width); ui.editor.h = Math.round(r.height); saveUi(); }, 350);
    });
    E.ro.observe(R); E.ro.observe(E.prevWrap); E.ro.observe(E.tlWrap);

    // keyboard: only while focus is inside the editor
    R.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { trapTab(e, R); return; }
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target;
      if (isEditable(t)) return;
      const k = e.key;
      if (k === ' ' && !(t && t.tagName === 'BUTTON')) { e.preventDefault(); togglePlay(); }
      else if (k === 'ArrowRight' || k === 'ArrowLeft') { e.preventDefault(); stopPlay(); setPlay(clampN(E.play + (k === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? E.clip.fps : 1), 0, E.n - 1)); }
      else if (k === 'i' || k === 'I') { E.sel = timeline.sel(E.play, Math.max(E.sel.to, E.play + 1)); renderEditor(); drawTimeline(); }
      else if (k === 'o' || k === 'O') { E.sel = timeline.sel(Math.min(E.sel.from, E.play), E.play + 1); renderEditor(); drawTimeline(); }
    });
    wirePreview(E);
    wireTimeline(E);
  }
  function numInput(lab, title) { return el('input', { type: 'number', min: '0', step: '1', 'aria-label': 'Crop ' + lab, title }); }
  function sizeCanvas(c, wrap) {
    const r = wrap.getBoundingClientRect(), d = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }

  function setView(v) {
    const E = editor; if (!E) return;
    E.view = v;
    E.vEdit.hidden = v !== 'edit'; E.vExp.hidden = v !== 'exp'; E.vDone.hidden = v !== 'done';
    E.exportBtn.hidden = v !== 'edit'; E.cancelBtn.hidden = v !== 'exp'; E.dlBtn.hidden = v !== 'done';
  }
  function setMode(m) { const E = editor; E.mode = m; renderEditor(); drawPreview(); }
  function setAspect(a) {
    const E = editor;
    E.aspect = a; E.mode = 'crop';
    if (a) E.crop = E.crop ? crop.fitAspect(E.crop, a, E.clip.w, E.clip.h) : crop.centered(a, E.clip.w, E.clip.h);
    renderEditor(); drawPreview();
  }
  function cropFromFields(changed) {
    const E = editor, W = E.clip.w, H = E.clip.h;
    const cur = E.crop || crop.full(W, H);
    let r = { x: +E.cx.value || 0, y: +E.cy.value || 0, w: +E.cw.value || cur.w, h: +E.ch.value || cur.h };
    if (E.aspect) { if (changed === E.ch) r.w = r.h * E.aspect; else r.h = r.w / E.aspect; }
    r = crop.clamp(r, W, H);
    if (E.aspect) r = crop.fitAspect(r, E.aspect, W, H);
    E.crop = r; renderEditor(); drawPreview();
  }
  const keptIdx = () => timeline.keptIndices(editor.segs);
  const outIdx = () => timeline.resample(keptIdx(), editor.clip.fps, editor.out.fps);
  const firstKept = () => (editor.segs[0] ? editor.segs[0].from : 0);
  const lastKept = () => { const s = editor.segs[editor.segs.length - 1]; return s ? s.to - 1 : 0; };

  function applyTrim(kind) {
    const E = editor;
    const next = kind === 'keep' ? timeline.keep(E.segs, E.sel) : timeline.remove(E.segs, E.sel);
    if (!timeline.count(next)) { toast('That would remove every frame.', 'Pick a smaller selection.', true); return; }
    if (timeline.count(next) < 2) { toast('A GIF needs at least 2 frames.', '', true); return; }
    E.segs = next;
    if (!timeline.isKept(E.segs, E.play)) setPlay(firstKept());
    renderEditor(); drawTimeline();
  }

  function renderEditor() {
    const E = editor; if (!E) return;
    const fps = E.clip.fps;
    const kept = timeline.count(E.segs);
    E.info.textContent = '· ' + E.clip.channel + ' · ' + fmtTime(E.n * 1000 / fps) + ' · ' + E.n + ' frames';
    E.tcCur.textContent = fmtTime(E.play * 1000 / fps);
    E.tcTot.textContent = '/ ' + fmtTime(E.n * 1000 / fps);
    E.secCrop.classList.toggle('active', E.mode === 'crop');
    E.secTrim.classList.toggle('active', E.mode === 'trim');
    E.editCropBtn.classList.toggle('on', E.mode === 'crop');
    E.editCropBtn.textContent = E.mode === 'crop' ? 'Done cropping' : 'Edit crop';
    for (const b of E.aspectBtns) b.classList.toggle('on', String(E.aspect) === b.dataset.a);
    const c = E.crop || crop.full(E.clip.w, E.clip.h);
    for (const [inp, k, max] of [[E.cx, 'x', E.clip.w], [E.cy, 'y', E.clip.h], [E.cw, 'w', E.clip.w], [E.ch, 'h', E.clip.h]]) {
      inp.max = String(max);
      if (document.activeElement !== inp) inp.value = String(c[k]);
    }
    E.inFld.textContent = fmtTime(E.sel.from * 1000 / fps);
    E.outFld.textContent = fmtTime(E.sel.to * 1000 / fps);
    // kept readout
    E.kept.textContent = '';
    E.kept.append('kept:');
    for (const s of E.segs) E.kept.append(el('b', { text: fmtTime(s.from * 1000 / fps) + '-' + fmtTime(s.to * 1000 / fps) }));
    E.kept.append('· ' + kept + ' frames');
    // output options that depend on the clip
    const capW = E.clip.w;
    const widths = CHOICES.outWidth.filter((w) => w === 0 || w < capW).map((w) => [w, w === 0 ? capW + ' (capture)' : String(w)]);
    if (!widths.some(([w]) => w === E.out.width)) E.out.width = widths.some(([w]) => w === 480) ? 480 : 0;
    refill(E.widthSel, widths, E.out.width);
    const fpsList = CHOICES.outFps.filter((f) => f <= fps).map((f) => [f, String(f)]);
    if (!fpsList.some(([f]) => f === E.out.fps)) E.out.fps = fpsList.length ? fpsList[fpsList.length - 1][0] : fps;
    refill(E.fpsSel, fpsList, E.out.fps);
    // estimate
    const frames = outIdx().length;
    const sz = crop.outputSize(c, E.out.width || capW);
    const bpp = CFG.bytesPerPixel[E.out.dither] || 0.45;
    const bytes = frames * sz.w * sz.h * bpp;
    const eff = CORE.effectiveFps(E.out.fps, E.out.speed);
    E.est.textContent = '';
    E.est.append(el('b', { text: frames + ' frames' }), ' · ' + sz.w + ' x ' + sz.h + ' · ' + eff.toFixed(1) + ' fps · est ', el('b', { text: fmtBytes(Math.round(bytes)) }));
    const big = bytes > CFG.sizeWarnBytes;
    E.est.classList.toggle('warn', big);
    if (big) E.est.append(el('div', { text: 'over 10 MB - lower width or fps' }));
    if (frames > CFG.maxEditorFrames) E.est.append(el('div', { text: 'over ' + CFG.maxEditorFrames + ' frames - slow to encode and play' }));
    E.est.title = 'Estimate = frames x width x height x ' + bpp + ' bytes (measured on live camera footage with this dither). Static scenes come out smaller. The real size shows after export. 10 MB is a common chat upload limit.';
    E.prevCanvas.style.cursor = E.mode === 'crop' ? 'crosshair' : 'pointer';
    setView(E.view);
  }
  function refill(sel, opts, value) {
    const key = opts.map((o) => o.join(':')).join('|');
    if (sel.dataset.k !== key) {
      sel.textContent = '';
      for (const [v, t] of opts) sel.appendChild(el('option', { value: String(v), text: t }));
      sel.dataset.k = key;
    }
    sel.value = String(value);
  }

  /* ---- preview ---- */
  let lastBitmap = null;
  function drawPreview(sync) {
    const E = editor; if (!E || E.closed) return;
    const i = E.play;
    const paint = (bmp) => {
      if (!editor || editor !== E || E.closed) return;
      if (bmp) lastBitmap = bmp;
      const c = E.prevCanvas, g = c.getContext('2d'), d = devicePixelRatio || 1;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
      const v = crop.view(E.clip.w, E.clip.h, c.width, c.height);
      E.pv = { scale: v.scale / d, ox: v.ox / d, oy: v.oy / d };   // in CSS px for pointer math
      const b = bmp || lastBitmap;
      if (b) { try { g.drawImage(b, v.ox, v.oy, v.w, v.h); } catch (_) {} }
      if (!timeline.isKept(E.segs, i)) {
        g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(v.ox, v.oy, v.w, v.h);
        g.fillStyle = '#ffb454'; g.font = (12 * d) + 'px sans-serif'; g.fillText('removed from the clip', v.ox + 10 * d, v.oy + 20 * d);
      }
      if (E.crop || E.mode === 'crop') {
        const r = crop.toView(E.crop || crop.full(E.clip.w, E.clip.h), v);
        g.fillStyle = 'rgba(0,0,0,.55)';
        g.fillRect(v.ox, v.oy, v.w, r.y - v.oy);
        g.fillRect(v.ox, r.y + r.h, v.w, v.oy + v.h - r.y - r.h);
        g.fillRect(v.ox, r.y, r.x - v.ox, r.h);
        g.fillRect(r.x + r.w, r.y, v.ox + v.w - r.x - r.w, r.h);
        g.strokeStyle = '#c6ff3d'; g.lineWidth = 1.5 * d; g.setLineDash([6 * d, 4 * d]);
        g.strokeRect(r.x, r.y, r.w, r.h); g.setLineDash([]);
        if (E.mode === 'crop') {
          const hs = 9 * d;
          for (const hd of crop.HANDLES) {
            const hx = hd.indexOf('w') >= 0 ? r.x : hd.indexOf('e') >= 0 ? r.x + r.w : r.x + r.w / 2;
            const hy = hd.indexOf('n') >= 0 ? r.y : hd.indexOf('s') >= 0 ? r.y + r.h : r.y + r.h / 2;
            g.fillStyle = '#c6ff3d'; g.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
            g.strokeStyle = '#000'; g.lineWidth = d; g.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
          }
          const cc = E.crop || crop.full(E.clip.w, E.clip.h);
          g.font = (11 * d) + 'px sans-serif'; g.fillStyle = '#c6ff3d';
          const label = cc.w + ' x ' + cc.h + (E.aspect ? '' : ' · free');
          const ly = r.y + r.h + 16 * d > v.oy + v.h ? r.y - 6 * d : r.y + r.h + 15 * d;
          g.fillText(label, r.x, ly);
        }
      }
    };
    const cached = E.cache.get(i);
    if (cached) paint(cached);
    else { if (sync) paint(null); lruGet(E, i).then(paint); }
    // prefetch ahead
    for (let k = 1; k <= 3; k++) if (i + k < E.n && !E.cache.has(i + k)) lruGet(E, i + k);
  }
  function setPlay(i) {
    const E = editor; if (!E) return;
    E.play = clampN(i, 0, E.n - 1);
    E.tcCur.textContent = fmtTime(E.play * 1000 / E.clip.fps);
    drawPreview(); drawTimeline();
  }
  function togglePlay() { const E = editor; if (!E) return; if (E.playing) stopPlay(); else startPlay(); }
  function stopPlay() {
    const E = editor; if (!E) return;
    E.playing = false; clearTimeout(E.playTimer);
    E.playBtn.textContent = '▶'; E.playBtn.setAttribute('aria-label', 'Play');
  }
  function startPlay() {
    const E = editor; if (!E) return;
    const seq = outIdx();
    if (seq.length < 2) return;
    E.playing = true; E.playBtn.textContent = '❚❚'; E.playBtn.setAttribute('aria-label', 'Pause');
    let k = seq.findIndex((x) => x >= E.play);
    if (k < 0 || k >= seq.length - 1) k = 0;
    const delay = CORE.delayCs(E.out.fps, E.out.speed) * 10;
    const step = () => {
      if (!E.playing || E.closed) return;
      const t0 = performance.now();
      setPlay(seq[k]);
      k++;
      if (k >= seq.length) { if (!E.loopPreview) { stopPlay(); return; } k = 0; }
      lruGet(E, seq[k]);
      E.playTimer = setTimeout(step, Math.max(0, delay - (performance.now() - t0)));
    };
    step();
  }
  function wirePreview(E) {
    const c = E.prevCanvas;
    let drag = null;
    const pt = (e) => { const r = c.getBoundingClientRect(); return { px: e.clientX - r.left, py: e.clientY - r.top }; };
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !E.pv) return;
      c.focus();
      const { px, py } = pt(e);
      const s = crop.toSource(px, py, E.pv);
      // Handles only grab in crop mode; a drag anywhere draws a new crop (and
      // switches to crop mode), a plain click in trim mode plays / pauses.
      const h = E.crop && E.mode === 'crop' ? crop.hit(E.crop, E.pv, px, py) : null;
      drag = h ? { kind: 'handle', h, start: E.crop, sx: s.x, sy: s.y } : { kind: 'draw', sx: s.x, sy: s.y, prev: E.crop, moved: false, click: E.mode !== 'crop' };
      try { c.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      if (!E.pv) return;
      const { px, py } = pt(e);
      if (!drag) {
        if (E.mode === 'crop') {
          const h = E.crop ? crop.hit(E.crop, E.pv, px, py) : null;
          const cur = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize', move: 'move' };
          c.style.cursor = h ? cur[h] : 'crosshair';
        }
        return;
      }
      const s = crop.toSource(px, py, E.pv);
      const W = E.clip.w, H = E.clip.h;
      if (drag.kind === 'handle') E.crop = crop.drag(drag.start, drag.h, s.x - drag.sx, s.y - drag.sy, W, H, E.aspect);
      else {
        if (!drag.moved && Math.hypot(s.x - drag.sx, s.y - drag.sy) * E.pv.scale < 4) return;
        if (!drag.moved) { drag.moved = true; stopPlay(); E.mode = 'crop'; }
        E.crop = crop.fromPoints(drag.sx, drag.sy, s.x, s.y, W, H, E.aspect);
      }
      renderEditor(); drawPreview();
    });
    c.addEventListener('pointerup', () => { const d = drag; drag = null; if (d && d.click && !d.moved) togglePlay(); });
    c.addEventListener('pointercancel', () => { drag = null; });
  }

  /* ---- timeline ---- */
  async function makeThumbs(E) {
    const k = Math.min(CFG.thumbs, E.n);
    for (let j = 0; j < k; j++) {
      if (E.closed) return;
      const idx = Math.floor((j + 0.5) * E.n / k);
      try {
        const b = await createImageBitmap(E.clip.frames[idx].blob, { resizeHeight: 96, resizeQuality: 'low' });
        if (E.closed) { b.close(); return; }
        E.thumbs[j] = b;
      } catch (_) {}
      if (j % 4 === 3 || j === k - 1) drawTimeline();
    }
  }
  function drawTimeline() {
    const E = editor; if (!E || E.closed) return;
    const c = E.tlCanvas, g = c.getContext('2d'), d = devicePixelRatio || 1;
    const W = c.width, H = c.height, pad = 6 * d, x0 = pad, x1 = W - pad, y0 = 5 * d, y1 = H - 5 * d;
    const fx = (i) => x0 + (x1 - x0) * i / E.n;
    g.clearRect(0, 0, W, H);
    const k = Math.min(CFG.thumbs, E.n), tw = (x1 - x0) / k, gap = 2 * d;
    for (let j = 0; j < k; j++) {
      const x = x0 + j * tw;
      const b = E.thumbs[j];
      g.save(); g.beginPath(); g.rect(x, y0, Math.max(1, tw - gap), y1 - y0); g.clip();
      if (b) {
        const s = Math.max((tw - gap) / b.width, (y1 - y0) / b.height);
        g.drawImage(b, x + (tw - gap - b.width * s) / 2, y0 + (y1 - y0 - b.height * s) / 2, b.width * s, b.height * s);
      } else { g.fillStyle = '#232a33'; g.fillRect(x, y0, tw - gap, y1 - y0); }
      g.restore();
    }
    // removed ranges: dim + hatch
    let prev = 0;
    const gaps = [];
    for (const s of E.segs) { if (s.from > prev) gaps.push([prev, s.from]); prev = s.to; }
    if (prev < E.n) gaps.push([prev, E.n]);
    for (const [a, b] of gaps) {
      const xa = fx(a), xb = fx(b);
      g.fillStyle = 'rgba(15,19,23,.78)'; g.fillRect(xa, y0, xb - xa, y1 - y0);
      g.save(); g.beginPath(); g.rect(xa, y0, xb - xa, y1 - y0); g.clip();
      g.strokeStyle = 'rgba(154,162,170,.35)'; g.lineWidth = d;
      for (let x = xa - (y1 - y0); x < xb; x += 6 * d) { g.beginPath(); g.moveTo(x, y1); g.lineTo(x + (y1 - y0), y0); g.stroke(); }
      g.restore();
    }
    // selection band + handles
    const sa = fx(E.sel.from), sb = fx(E.sel.to);
    g.fillStyle = 'rgba(198,255,61,.16)'; g.fillRect(sa, 0, sb - sa, H);
    for (const x of [sa, sb]) {
      g.fillStyle = '#c6ff3d'; g.fillRect(x - 4 * d, 0, 8 * d, H);
      g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(x - d, H / 2 - 7 * d, 2 * d, 14 * d);
    }
    // playhead
    const px = fx(E.play + 0.5);
    g.fillStyle = '#fff'; g.fillRect(px - d, 0, 2 * d, H);
    g.beginPath(); g.moveTo(px - 5 * d, 0); g.lineTo(px + 5 * d, 0); g.lineTo(px, 6 * d); g.closePath(); g.fill();
  }
  function wireTimeline(E) {
    const c = E.tlCanvas;
    let drag = null;
    const idxAt = (e) => {
      const r = c.getBoundingClientRect(), pad = 6;
      return clampN(Math.round((e.clientX - r.left - pad) / Math.max(1, r.width - 2 * pad) * E.n), 0, E.n);
    };
    const xOf = (i) => { const r = c.getBoundingClientRect(); return 6 + (r.width - 12) * i / E.n; };
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      c.focus(); stopPlay();
      const r = c.getBoundingClientRect(), x = e.clientX - r.left;
      if (Math.abs(x - xOf(E.sel.from)) <= 8) drag = 'in';
      else if (Math.abs(x - xOf(E.sel.to)) <= 8) drag = 'out';
      else { drag = 'play'; setPlay(Math.min(idxAt(e), E.n - 1)); }
      try { c.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) {
        const r = c.getBoundingClientRect(), x = e.clientX - r.left;
        c.style.cursor = Math.abs(x - xOf(E.sel.from)) <= 8 || Math.abs(x - xOf(E.sel.to)) <= 8 ? 'ew-resize' : 'pointer';
        return;
      }
      const i = idxAt(e);
      if (drag === 'in') { E.sel = { from: Math.min(i, E.sel.to - 1), to: E.sel.to }; setPlay(E.sel.from); }
      else if (drag === 'out') { E.sel = { from: E.sel.from, to: Math.max(i, E.sel.from + 1) }; setPlay(E.sel.to - 1); }
      else setPlay(Math.min(i, E.n - 1));
      renderEditor();
    });
    const end = () => { drag = null; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  /* ---- export ---- */
  let workerUrl = null, workerBroken = false;
  function makeWorker() {
    if (!workerBroken) {
      try {
        if (!workerUrl) {
          const src = '"use strict";const CORE=(' + makeCore.toString() + ')();(' + workerMain.toString() + ')(CORE,self);';
          workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        }
        const w = new Worker(workerUrl);
        w.kind = 'worker';
        return w;
      } catch (e) { workerBroken = true; S.lastErr = 'Worker: ' + (e && e.message); }
    }
    return makeInlineWorker();
  }
  // Same message protocol on the main thread, one message per macrotask so
  // the page stays responsive.
  function makeInlineWorker() {
    const w = { kind: 'inline', onmessage: null, onerror: null, dead: false, terminate() { this.dead = true; } };
    const scope = { onmessage: null, postMessage(data) { setTimeout(() => { if (!w.dead && w.onmessage) w.onmessage({ data }); }, 0); } };
    workerMain(CORE, scope);
    w.postMessage = (data) => { setTimeout(() => { if (!w.dead) scope.onmessage({ data }); }, 0); };
    return w;
  }

  async function startExport(forceInline) {
    const E = editor; if (!E || E.job) return;
    stopPlay();
    const seq = outIdx();
    if (seq.length < 2) { toast('Nothing to export.', 'Keep at least 2 frames.', true); return; }
    if (seq.length > CFG.maxEditorFrames && !forceInline) {
      const ok = await modal({ title: 'Long GIF', body: ['This GIF has ' + seq.length + ' frames. GIFs that long are slow to encode and slow to play in chat apps.', 'Lower the fps or trim the clip to make it lighter, or export anyway.'], ok: 'Export anyway' });
      if (!ok || editor !== E) return;
    }
    const c = E.crop || crop.full(E.clip.w, E.clip.h);
    const { w, h } = crop.outputSize(c, E.out.width || E.clip.w);
    const dCs = CORE.delayCs(E.out.fps, E.out.speed);
    const opts = { width: w, height: h, loop: E.out.loop, dither: E.out.dither, palette: E.out.palette };
    const job = E.job = { worker: forceInline ? makeInlineWorker() : makeWorker(), cancelled: false, inFlight: 0, done: 0, total: seq.length, t0: performance.now(), opts, w, h, dCs, count: seq.length };
    if (E.result) { URL.revokeObjectURL(E.result.url); E.result = null; E.resImg.removeAttribute('src'); }
    setView('exp');
    progress(0, 'preparing');
    const canvas = new OffscreenCanvas(w, h), g = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    g.imageSmoothingQuality = 'high';
    const rgbaOf = async (i) => {
      const f = E.clip.frames[i];
      const b = await createImageBitmap(f.blob);
      const k = b.width / E.clip.w;
      g.drawImage(b, c.x * k, c.y * k, c.w * k, c.h * k, 0, 0, w, h);
      b.close();
      return g.getImageData(0, 0, w, h).data.buffer;
    };
    let wake = null;
    const finished = new Promise((resolve, reject) => {
      job.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') { job.inFlight--; job.done = m.done; progress(m.done, 'encoding'); if (wake) { const f = wake; wake = null; f(); } }
        else if (m.type === 'done') resolve(m.bytes);
        else if (m.type === 'error') reject(new Error(m.message));
      };
      job.worker.onerror = (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); reject(new Error('worker failed' + (ev && ev.message ? ': ' + ev.message : ''))); };
    });
    finished.catch(() => {});
    try {
      job.worker.postMessage({ type: 'init', opts, total: seq.length });
      if (opts.palette === 'global') {
        const picks = CORE.evenlySpaced(seq.length, CFG.paletteSampleFrames);
        for (const p of picks) {
          if (job.cancelled) return;
          const buf = await rgbaOf(seq[p]);
          job.worker.postMessage({ type: 'sample', buf, w, h }, [buf]);
        }
      }
      for (let k = 0; k < seq.length; k++) {
        if (job.cancelled) return;
        while (job.inFlight >= 3 && !job.cancelled) await Promise.race([new Promise((r) => { wake = r; }), finished.then(() => {}, () => {})]);
        if (job.cancelled) return;
        const buf = await rgbaOf(seq[k]);
        job.inFlight++;
        job.worker.postMessage({ type: 'frame', buf, delayCs: dCs }, [buf]);
        if (job.done === 0 && k === 0) progress(0, 'encoding');
      }
      job.worker.postMessage({ type: 'finish' });
      const bytes = await finished;
      if (job.cancelled || editor !== E) return;
      job.worker.terminate();
      E.job = null;
      const blob = new Blob([bytes], { type: 'image/gif' });
      const url = URL.createObjectURL(blob);
      const secs = (performance.now() - job.t0) / 1000;
      E.result = { blob, url, bytes: blob.size, frames: seq.length, w, h, eff: 100 / dCs, len: seq.length * dCs * 10, palette: opts.palette, name: CORE.fileName(settings.filePattern, E.clip.channel, E.clip.startedAt), encoder: job.worker.kind, secs };
      console.log(TAG, `exported ${seq.length} frames ${w}x${h} -> ${fmtBytes(blob.size)} in ${secs.toFixed(1)} s (${job.worker.kind})`);
      showResult();
    } catch (err) {
      if (job.cancelled || editor !== E) return;
      job.worker.terminate();
      E.job = null;
      if (job.worker.kind === 'worker' && job.done === 0) {
        // The Worker never produced anything (blocked or crashed): run the same code inline.
        workerBroken = true; S.lastErr = String(err && err.message);
        console.warn(TAG, 'worker failed, encoding on the main thread instead', err);
        startExport(true);
        return;
      }
      S.lastErr = String(err && err.message);
      setView('edit');
      modal({ title: 'Export failed', body: ['The GIF could not be encoded: ' + S.lastErr, 'Try a smaller width or fps. Settings > Diagnostics copies details for a bug report.'], cancel: false });
    }
  }
  function progress(done, phase) {
    const E = editor; if (!E || !E.job) return;
    const j = E.job;
    E.progTxt.textContent = '';
    E.progTxt.append('Frame ', el('b', { text: String(done) }), ' / ' + j.total + ' · ' + j.w + ' x ' + j.h + ' · ' + phase + (j.worker.kind === 'inline' ? ' (main thread)' : ''));
    E.progBar.style.width = Math.round(done / j.total * 100) + '%';
  }
  function cancelExport() {
    const E = editor; if (!E || !E.job) return;
    E.job.cancelled = true;
    try { E.job.worker.terminate(); } catch (_) {}
    E.job = null;
    setView('edit');
    toast('Export cancelled.', '');
  }
  function showResult() {
    const E = editor, r = E.result;
    E.resImg.src = r.url;
    E.resImg.alt = 'Exported GIF ' + r.w + ' x ' + r.h;
    E.resKv.textContent = '';
    const kv = [['file', fmtBytes(r.bytes)], ['size', r.w + ' x ' + r.h], ['frames', r.frames + ' @ ' + r.eff.toFixed(1) + ' fps'], ['length', fmtTime(r.len)], ['palette', r.palette === 'global' ? 'global 256' : 'per frame'], ['name', r.name]];
    for (const [k, v] of kv) E.resKv.append(el('span', { text: k }), el('b', { text: v }));
    setView('done');
    E.dlBtn.focus();
  }
  function download() {
    const E = editor; if (!E || !E.result) return;
    const r = E.result;
    try {
      const a = el('a', { href: r.url, download: r.name, style: 'display:none' });
      document.body.appendChild(a); a.click(); a.remove();
      E.downloaded = true;
      toast('Saved', r.name + ' · ' + fmtBytes(r.bytes));
    } catch (_) { manualSave(); }
  }
  function manualSave() {
    const E = editor; if (!E || !E.result) return;
    const a = el('a', { href: E.result.url, download: E.result.name, target: '_blank', rel: 'noopener', text: E.result.name, style: 'color:#c6ff3d' });
    modal({ title: 'Save the GIF', body: ['If the download was blocked, right-click the link below and choose "Save link as...".', a], cancel: false, ok: 'Done' });
  }

  async function askDiscard() {
    const E = editor; if (!E) return;
    if (!E.downloaded) {
      const ok = await modal({ title: 'Discard clip?', body: ['This clip has not been downloaded. Discard it and free its memory?'], ok: 'Discard', danger: true });
      if (!ok) return;
    }
    closeEditor();
  }
  // Frees everything the clip holds: bitmaps, blobs, the result URL, the worker.
  function closeEditor() {
    const E = editor; if (!E) return;
    E.closed = true;
    stopPlay();
    if (E.job) { E.job.cancelled = true; try { E.job.worker.terminate(); } catch (_) {} E.job = null; }
    for (const b of E.cache.values()) { try { b.close(); } catch (_) {} }
    E.cache.clear();
    for (const b of E.thumbs) { try { b && b.close(); } catch (_) {} }
    E.thumbs.length = 0;
    if (E.result) { URL.revokeObjectURL(E.result.url); E.result = null; }
    if (E.ro) E.ro.disconnect();
    E.clip.frames.length = 0;
    lastBitmap = null;
    hide(E.root);
    editor = null;
    if (performance.memory) {
      const before = E.memBefore;
      setTimeout(() => console.log(TAG, `editor closed; JS heap ${fmtBytes(before)} at open -> ${fmtBytes(performance.memory.usedJSHeapSize)} now`), 1500);
    }
  }

  /* ==================================================================== *
   * settings                                                              *
   * ==================================================================== */
  let settingsUi = null;
  function toggleSettings() { if (settingsUi) closeSettings(); else openSettings(); }
  function closeSettings() { if (!settingsUi) return; stopListening(); hide(settingsUi.root); settingsUi = null; }
  let listening = null;
  function stopListening() { if (listening) { listening.btn.classList.remove('listen'); listening.btn.textContent = hkLabel(settings.hotkeys[listening.key]); listening = null; } }

  function openSettings() {
    const U = settingsUi = {};
    const R = U.root = popover(el('div', { id: 'kgc-settings', class: 'kgc kgc-panel', role: 'dialog', 'aria-label': 'GIF Clipper settings' }));
    shield(R);
    const set = (k, v) => { settings[k] = v; saveSettings(); renderPill(); updateCost(); };
    const title = el('div', { class: 'kgc-title' }, [el('b', { text: 'GIF Clipper' }), el('span', { class: 'v', text: 'settings · v' + VERSION }),
      el('div', { class: 'wb' }, [el('button', { type: 'button', text: '×', title: 'Close settings', 'aria-label': 'Close settings', onclick: closeSettings })])]);
    makeDraggable(R, title);

    const capFps = select(CHOICES.captureFps.map((f) => [f, f + ' fps']), settings.captureFps, 'Capture fps', 'How many frames per second are sampled from the stream. Higher = smoother but more memory and CPU. The GIF can use fewer.', (v) => set('captureFps', +v));
    const capW = select(CHOICES.captureWidth.map((w) => [w, w + ' px']), settings.captureWidth, 'Capture width', 'Width of the stored frames. 640 is plenty for GIFs; 854 costs about 1.8x the memory and CPU.', (v) => set('captureWidth', +v));
    const maxS = el('input', { type: 'number', min: '10', max: '60', step: '1', value: String(settings.maxSeconds), 'aria-label': 'Max record length in seconds', title: 'Recording stops by itself after this many seconds, so a forgotten recording cannot eat all your memory.' });
    maxS.addEventListener('change', () => { const v = clampN(Math.round(+maxS.value || 30), 10, 60); maxS.value = String(v); set('maxSeconds', v); });
    const bufS = select(CHOICES.bufferSeconds.map((s) => [s, s + ' s']), settings.bufferSeconds, 'Rewind buffer length', 'How far back "Last N s" can reach. Longer costs more memory while the buffer is armed.', (v) => { set('bufferSeconds', +v); if (armed()) { S.ringCap = S.fps * settings.bufferSeconds; } });
    const armChk = el('input', { type: 'checkbox', checked: settings.armOnLoad, 'aria-label': 'Arm rewind buffer on page load', title: 'Start the rewind buffer automatically on channel pages. Off by default because it uses memory and a little CPU all the time.' });
    armChk.addEventListener('change', () => set('armOnLoad', armChk.checked));
    U.armBtn = btn(armed() ? 'Disarm now' : 'Arm now', '', 'Start or stop the rewind buffer right now', () => { if (armed()) disarm(); else arm(); U.armBtn.textContent = armed() ? 'Disarm now' : 'Arm now'; });
    U.cost = el('div', { class: 'kgc-est' });

    const hkRow = (key, label, why) => {
      const b = btn(hkLabel(settings.hotkeys[key]), '', why + ' Click, then press the new key combination (needs Ctrl or Alt). Esc cancels.', () => {
        if (listening && listening.btn === b) { stopListening(); return; }
        stopListening();
        listening = { key, btn: b }; b.classList.add('listen'); b.textContent = 'Press keys...';
      }, label + ' hotkey');
      return el('div', { class: 'kgc-hk' }, [el('span', { class: 'kgc-lab', text: label }), b]);
    };
    const oW = select(CHOICES.outWidth.map((w) => [w, w === 0 ? 'capture' : w + ' px']), settings.outWidth, 'Default output width', 'Starting GIF width in the editor. 480 is a good size/quality balance for chat.', (v) => set('outWidth', +v));
    const oF = select(CHOICES.outFps.map((f) => [f, f + ' fps']), settings.outFps, 'Default output fps', 'Starting GIF fps in the editor (capped at the capture fps).', (v) => set('outFps', +v));
    const oD = select(CHOICES.dither.map((d) => [d, LABELS.dither[d]]), settings.dither, 'Default dither', 'Starting dither in the editor. Ordered is the safe default for video.', (v) => set('dither', v));
    const oP = select(CHOICES.palette.map((p) => [p, LABELS.palette[p]]), settings.palette, 'Default palette', 'Starting palette mode. Global is smaller and does not flicker.', (v) => set('palette', v));
    const oL = select(CHOICES.loop.map((l) => [l, LABELS.loop[l]]), settings.loop, 'Default loop', 'Starting GIF loop setting.', (v) => set('loop', v));
    const fp = el('input', { type: 'text', value: settings.filePattern, 'aria-label': 'File name pattern', title: 'Name of the downloaded file. {channel} becomes the channel name, {date} the clip time (YYYYMMDD-HHMMSS).' });
    fp.addEventListener('change', () => { const v = fp.value.trim() || DEFAULTS.filePattern; fp.value = v; set('filePattern', v); });
    const cnt = el('input', { type: 'checkbox', checked: settings.showCounter, 'aria-label': 'Show frame counter on the launcher', title: 'Show frames and size on the launcher while recording, so you can see how big the clip is getting.' });
    cnt.addEventListener('change', () => set('showCounter', cnt.checked));

    const fileIn = el('input', { type: 'file', accept: 'application/json,.json', hidden: true, 'aria-label': 'Restore settings file' });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files && fileIn.files[0]; if (!f) return;
      try {
        const v = JSON.parse(await f.text());
        Object.assign(settings, sanitizeSettings(v.settings || v)); saveSettings();
        closeSettings(); openSettings(); renderPill();
        toast('Settings restored.', '');
      } catch (e) { toast('Could not read that file.', String(e && e.message), true); }
    });
    const body = el('div', { class: 'kgc-sbody' }, [
      el('div', { class: 'kgc-sec' }, [el('h4', null, ['Capture', tip('How frames are sampled from the stream while recording or while the rewind buffer runs.')]),
        el('div', { class: 'kgc-grid2' }, [el('span', { class: 'kgc-lab', text: 'fps' }), capFps, el('span', { class: 'kgc-lab', text: 'width' }), capW]),
        el('div', { class: 'kgc-row' }, [el('span', { class: 'kgc-lab', text: 'max' }), maxS, el('span', { class: 'kgc-est', text: 's, then auto-stop', style: 'margin-top:0' })])]),
      el('div', { class: 'kgc-sec' }, [el('h4', null, ['Rewind buffer', tip('Keeps the last few seconds in memory so you can clip a moment after it happened. Off by default.')]),
        el('div', { class: 'kgc-row' }, [el('span', { class: 'kgc-lab', text: 'keep' }), bufS, el('label', { class: 'kgc-lab', style: 'display:flex;gap:6px;align-items:center;cursor:pointer', title: armChk.title }, [armChk, 'arm on load'])]),
        el('div', { class: 'kgc-row' }, [U.armBtn]), U.cost]),
      el('div', { class: 'kgc-sec' }, [el('h4', null, ['Hotkeys', tip('Work anywhere on Kick, even while typing in chat, because they need Alt or Ctrl.')]),
        hkRow('record', 'Start / stop record', 'Starts or stops a recording.'), hkRow('last', 'Clip last N s', 'Turns the rewind buffer into a clip (arms it if off).'), hkRow('toggle', 'Show / hide launcher', 'Hides or shows the launcher pill.')]),
      el('div', { class: 'kgc-sec' }, [el('h4', null, ['Output defaults', tip('What the editor starts with for each new clip. You can still change them per clip.')]),
        el('div', { class: 'kgc-out' }, [el('span', { class: 'kgc-lab', text: 'width' }), oW, el('span', { class: 'kgc-lab', text: 'fps' }), oF, el('span', { class: 'kgc-lab', text: 'dither' }), oD,
          el('span', { class: 'kgc-lab', text: 'palette' }), oP, el('span', { class: 'kgc-lab', text: 'loop' }), oL, el('span', { class: 'kgc-lab', text: 'file' }), fp])]),
      el('div', { class: 'kgc-sec' }, [el('label', { class: 'kgc-row', style: 'cursor:pointer', title: cnt.title }, [cnt, el('span', { text: 'Show frame counter on the launcher' })])]),
      el('div', { class: 'kgc-sec' }, [el('div', { class: 'kgc-row' }, [
        btn('Backup', '', 'Download your settings as a JSON file', backupSettings, 'Backup settings'),
        btn('Restore', '', 'Load settings from a backup JSON file', () => fileIn.click(), 'Restore settings'),
        btn('Diagnostics', '', 'Copy a short report (version, player, capture rate, last error) to paste into a bug report', copyDiagnostics),
        fileIn])]),
    ]);
    R.append(title, body);
    R.addEventListener('keydown', (e) => {
      if (listening) return;
      if (e.key === 'Escape') { e.preventDefault(); closeSettings(); }
    });
    show(R);
    // above the pill, right-aligned with it
    const pr = pill.root.getBoundingClientRect(), r = R.getBoundingClientRect();
    R.style.left = clampN(pr.right - r.width, 8, innerWidth - r.width - 8) + 'px';
    R.style.top = clampN(pr.top - r.height - 8, 8, Math.max(8, innerHeight - r.height - 8)) + 'px';
    updateCost();
    setTimeout(() => capFps.focus(), 0);
  }
  function updateCost() {
    if (!settingsUi) return;
    const fps = settings.captureFps, w = settings.captureWidth, secs = settings.bufferSeconds;
    const perFrame = S.avgBlob && armed() ? S.avgBlob : 19000 * Math.pow(w / 480, 1.6);
    const mb = fps * secs * perFrame;
    const cpu = S.avgTick && armed() ? S.avgTick * fps * 0.35 : fps * 1.4 * Math.pow(w / 640, 2);
    settingsUi.cost.textContent = '~' + fmtBytes(Math.round(mb)) + ' RAM, ~' + Math.round(cpu) + ' ms/s main-thread CPU while armed' + (armed() ? ' (measured)' : '');
  }
  function backupSettings() {
    const blob = new Blob([JSON.stringify({ app: 'kick-gif-clipper', version: VERSION, settings }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'kick-gif-clipper-settings.json', style: 'display:none' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Settings saved', 'as kick-gif-clipper-settings.json');
  }
  function diagnostics() {
    const v = findVideo();
    const src = v ? (v.srcObject ? (v.srcObject.constructor && v.srcObject.constructor.name) || 'object' : v.currentSrc ? (v.currentSrc.indexOf('blob:') === 0 ? 'blob URL' : 'URL') : 'none') : '-';
    const r = v ? v.getBoundingClientRect() : null;
    const a = S.lastAchieved;
    return [
      'Kick GIF Clipper v' + VERSION,
      'page: ' + location.pathname,
      'player found: ' + (v ? 'yes' : 'no') + (v ? ' (' + v.videoWidth + 'x' + v.videoHeight + ', on screen ' + Math.round(r.width) + 'x' + Math.round(r.height) + ')' : ''),
      'video source: ' + src + ', videos on page: ' + document.querySelectorAll('video').length,
      'capture: target ' + settings.captureFps + ' fps @ ' + settings.captureWidth + ' px, current ' + S.fps + ' fps' + (S.cpuStep ? ' (stepped down for CPU)' : ''),
      'last recording: ' + (a ? a.frames + ' frames in ' + a.secs.toFixed(1) + ' s = ' + a.fps.toFixed(1) + ' fps, ' + a.dropped + ' dropped ticks' : 'none'),
      'avg capture tick: ' + (S.avgTick ? S.avgTick.toFixed(1) + ' ms' : '-') + ', avg frame: ' + (S.avgBlob ? fmtBytes(Math.round(S.avgBlob)) : '-'),
      'rewind buffer: ' + (armed() ? 'armed, ' + S.ring.length + ' frames' : 'off') + ', rVFC callbacks: ' + S.rvfc,
      'encoder: ' + (workerBroken ? 'main-thread fallback' : 'worker'),
      'last error: ' + (S.lastErr || 'none'),
      'browser: ' + navigator.userAgent,
    ].join('\n');
  }
  async function copyDiagnostics() {
    const text = diagnostics();
    try { await navigator.clipboard.writeText(text); toast('Diagnostics copied.', 'Paste them into the bug report.'); }
    catch (_) {
      const ta = el('textarea', { readonly: true, 'aria-label': 'Diagnostics text' }); ta.value = text;
      modal({ title: 'Diagnostics', body: ['Copy this text (Ctrl+A, Ctrl+C):', ta], cancel: false, ok: 'Done' });
    }
  }

  /* ==================================================================== *
   * hotkeys                                                               *
   * ==================================================================== */
  function comboOf(e) {
    const m = [];
    if (e.ctrlKey) m.push('Ctrl'); if (e.altKey) m.push('Alt'); if (e.shiftKey) m.push('Shift'); if (e.metaKey) m.push('Meta');
    return m.concat(e.code).join('+');
  }
  window.addEventListener('keydown', (e) => {
    if (listening) {
      if (/^(Control|Alt|Shift|Meta)/.test(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { stopListening(); return; }
      if (!(e.ctrlKey || e.altKey || e.metaKey)) { toast('Add Ctrl or Alt', 'so the hotkey never fires while typing in chat.', true); return; }
      const combo = comboOf(e);
      const clash = Object.keys(settings.hotkeys).find((k) => k !== listening.key && settings.hotkeys[k] === combo);
      if (clash) { toast('Already used', 'by another GIF Clipper hotkey.', true); return; }
      settings.hotkeys[listening.key] = combo; saveSettings();
      stopListening(); renderPill();
      return;
    }
    if (e.repeat || !(e.altKey || e.ctrlKey || e.metaKey)) return;
    const combo = comboOf(e), hk = settings.hotkeys;
    let fn = null;
    if (combo === hk.record) fn = () => { if (!recording() && !findVideo()) { toast('No player on this page.', '', true); return; } toggleRecord(); };
    else if (combo === hk.last) fn = clipLast;
    else if (combo === hk.toggle) fn = () => setHidden(!ui.hidden);
    if (!fn) return;
    e.preventDefault(); e.stopPropagation();
    fn();
  }, true);

  /* ==================================================================== *
   * boot                                                                  *
   * ==================================================================== */
  function boot() {
    document.head.appendChild(el('style', { id: 'kgc-style', text: css }));
    buildPill();
    try {
      new MutationObserver(() => { for (const n of roots) if (!n.isConnected) { heal(); break; } }).observe(document.body, { childList: true });
    } catch (_) {}
    setInterval(heal, 1000);
    document.addEventListener('fullscreenchange', () => { restack(); placePill(); });
    if (settings.armOnLoad) {
      let tries = 0;
      const t = setInterval(() => { if (findVideo()) { clearInterval(t); arm(); } else if (++tries > 60) clearInterval(t); }, 1000);
    }
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Show / hide launcher', () => setHidden(!ui.hidden));
      GM_registerMenuCommand('Settings', () => { if (ui.hidden) setHidden(false); openSettings(); });
      GM_registerMenuCommand('Reset panel positions', () => { ui.pill = Object.assign({}, PILL_DEFAULT); ui.editor = JSON.parse(JSON.stringify(UI_DEFAULTS.editor)); ui.collapsed = false; saveUi(); renderPill(); placePill(); });
    }
    console.log(TAG, 'v' + VERSION + ' active');
  }
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
