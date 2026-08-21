# Third-party notices

The native fmx executable embeds Bun 1.4.0, OpenTUI, and their runtime
dependencies. The release packaging process appends the exact license, author,
and patent notices shipped by the installed OpenTUI dependency packages for
each target platform to this file.

## Bun 1.4.0

Bun itself is MIT-licensed.

### JavaScriptCore

Bun statically links JavaScriptCore (and WebKit), which is LGPL-2 licensed.
WebCore files from WebKit are also licensed under LGPL2. Per LGPL2:

> If you statically link against an LGPL'd library, you must also provide your
> application in an object (not necessarily source) format, so that a user has
> the opportunity to modify the library and relink the application.

The patched WebKit used by Bun is available at
<https://github.com/oven-sh/webkit>. Instructions and sources for rebuilding
Bun 1.4.0 are available at <https://github.com/oven-sh/bun/tree/bun-v1.4.0>.

### Linked libraries

| Library | License |
| --- | --- |
| [BoringSSL](https://boringssl.googlesource.com/boringssl/) | [Several licenses](https://boringssl.googlesource.com/boringssl/+/refs/heads/master/LICENSE) |
| [Brotli](https://github.com/google/brotli) | MIT |
| [libarchive](https://github.com/libarchive/libarchive) | [Several licenses](https://github.com/libarchive/libarchive/blob/master/COPYING) |
| [lol-html](https://github.com/cloudflare/lol-html/tree/master/c-api) | BSD 3-Clause |
| [ls-hpack](https://github.com/litespeedtech/ls-hpack) | MIT |
| [ls-qpack](https://github.com/litespeedtech/ls-qpack) | MIT |
| [lsquic](https://github.com/litespeedtech/lsquic) | MIT and BSD 3-Clause |
| [mimalloc](https://github.com/microsoft/mimalloc) | MIT |
| [picohttpparser](https://github.com/h2o/picohttpparser) | Perl License or MIT |
| [zstd](https://github.com/facebook/zstd) | BSD or GPLv2 |
| [simdutf](https://github.com/simdutf/simdutf) | Apache 2.0 |
| [tinycc](https://github.com/tinycc/tinycc) | LGPL v2.1 |
| [uSockets](https://github.com/uNetworking/uSockets) | Apache 2.0 |
| [zlib-ng](https://github.com/zlib-ng/zlib-ng) | zlib |
| [c-ares](https://github.com/c-ares/c-ares) | MIT |
| [ICU](https://github.com/unicode-org/icu) | ICU license |
| [libbase64](https://github.com/aklomp/base64) | BSD 2-Clause |
| [libdeflate](https://github.com/ebiggers/libdeflate) | MIT |
| [libjpeg-turbo](https://github.com/libjpeg-turbo/libjpeg-turbo) | BSD 3-Clause, IJG, and zlib |
| [libspng](https://github.com/randy408/libspng) | BSD 2-Clause |
| [libwebp](https://github.com/webmproject/libwebp) | BSD 3-Clause |
| [highway](https://github.com/google/highway) | Apache 2.0 |
| [uucode](https://github.com/jacobsandlund/uucode) | MIT |
| [uWebSockets fork](https://github.com/jarred-sumner/uwebsockets) | Apache 2.0 |
| LLVM libc++abi `__cxa_thread_atexit` fallback | Apache 2.0 with LLVM exception |

### Embedded polyfills

Bun embeds compatibility polyfills from acorn, acorn-walk, assert,
browserify-zlib, buffer, constants-browserify, crypto-browserify,
domain-browser, events, https-browserify, os-browserify, path-browserify,
process, punycode, querystring-es3, stream-browserify, stream-http,
string_decoder, timers-browserify, tty-browserify, url, util, and vm-browserify.
These packages are MIT-licensed.

The complete upstream Bun 1.4.0 notice is available at
<https://github.com/oven-sh/bun/blob/bun-v1.4.0/LICENSE.md>.
