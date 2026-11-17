"""Optional hardware OpenGL composition for image montages.

Images are fitted once by the reference renderer, then retained only while active.
The shader performs Ken Burns sampling and alpha/transitions on the GPU. The
framebuffer bytes are BGR, with the same row order expected by the FFmpeg pipe.
"""
import contextlib
import numpy as np


class GpuUnavailable(RuntimeError):
    pass


def unsupported_reason(project, settings):
    """Keep the reference renderer for effects not implemented by this shader."""
    if settings.get("acceleration") == "cpu":
        return "CPU requested"
    if project.get("overlays") or settings.get("framePng"):
        return "Timed overlays or frame"
    if project.get("mirror") or project.get("protectedArea"):
        return "Global mirroring"
    assets = {asset["id"]: asset for asset in project.get("assets", [])}
    for clip in project.get("clips", []):
        if assets.get(clip["assetId"], {}).get("kind") != "image":
            return "Video source"
        if (clip.get("filter", "none") != "none" or clip.get("brightness", 0) != 0
                or clip.get("contrast", 1) != 1 or clip.get("saturation", 1) != 1
                or clip.get("warmth", 0) != 0):
            return "Color correction"
        if clip.get("mirror") or (clip.get("title") or {}).get("text", "").strip():
            return "Clip mirror or title"
        placement = clip.get("placement") or {}
        if any(placement.get(key, default) != default for key, default in
               (("x", .5), ("y", .5), ("scale", 1), ("opacity", 1))):
            return "Clip placement"
        if clip.get("zoom", "none") not in ("none", "in", "out"):
            return "Unknown zoom"
        if clip.get("transition", "none") not in ("none", "fade", "black", "white"):
            return "Unsupported transition"
    return None


_VERTEX = """#version 330
void main() {
    vec2 positions[3] = vec2[3](vec2(-1,-1), vec2(3,-1), vec2(-1,3));
    gl_Position = vec4(positions[gl_VertexID], 0, 1);
}
"""

_FRAGMENT = """#version 330
uniform sampler2D pixels0;
uniform sampler2D alpha0;
uniform sampler2D pixels1;
uniform sampler2D alpha1;
uniform vec2 size;
uniform float scale0;
uniform float scale1;
uniform float opacity0;
uniform float opacity1;
uniform float beta;
uniform int transition;
out vec4 result;

vec4 fetchPixel(sampler2D rgb, sampler2D mask, ivec2 p) {
    if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, ivec2(size))))
        return vec4(0);
    return vec4(texelFetch(rgb, p, 0).rgb, texelFetch(mask, p, 0).r);
}

vec4 layer(sampler2D rgb, sampler2D mask, float scale, float opacity) {
    // OpenCV warpAffine samples at integer pixel centers with a 1/32-pixel
    // interpolation table. Reproduce that grid instead of hardware texture
    // filtering, which can blur small lettering differently.
    vec2 source = (gl_FragCoord.xy - vec2(.5) - size * .5) / scale + size * .5;
    source = floor(source * 32.0 + .5) / 32.0;
    ivec2 origin = ivec2(floor(source));
    vec2 f = fract(source);
    vec4 a = mix(fetchPixel(rgb, mask, origin), fetchPixel(rgb, mask, origin + ivec2(1,0)), f.x);
    vec4 b = mix(fetchPixel(rgb, mask, origin + ivec2(0,1)), fetchPixel(rgb, mask, origin + ivec2(1,1)), f.x);
    vec4 value = mix(a, b, f.y);
    value.rgb = floor(value.rgb * 255.0 + .5) / 255.0;
    value.a *= opacity;
    return value;
}

void main() {
    vec4 current = layer(pixels0, alpha0, scale0, opacity0);
    vec3 color = current.rgb;
    float alpha = current.a;
    if (transition != 0) {
        vec4 incoming = layer(pixels1, alpha1, scale1, opacity1);
        if (transition == 1) {
            vec3 p0 = floor(current.rgb * current.a * 255.0) / 255.0;
            vec3 p1 = floor(incoming.rgb * incoming.a * 255.0) / 255.0;
            vec3 premultiplied = floor(mix(p0, p1, beta) * 255.0 + .5) / 255.0;
            float a0 = floor(current.a * 255.0) / 255.0;
            float a1 = floor(incoming.a * 255.0) / 255.0;
            alpha = floor(mix(a0, a1, beta) * 255.0 + .5) / 255.0;
            color = alpha > .000001 ? floor(premultiplied / alpha * 255.0) / 255.0 : vec3(0);
        } else {
            alpha = max(current.a, incoming.a);
            if (transition == 2)
                color = beta < .5 ? current.rgb * (1.0 - beta * 2.0) : incoming.rgb * ((beta - .5) * 2.0);
            else
                color = beta < .5 ? mix(current.rgb, vec3(1), beta * 2.0) : mix(vec3(1), incoming.rgb, (beta - .5) * 2.0);
            color = floor(color * 255.0) / 255.0;
        }
    }
    // Premultiplied blending keeps transparent image margins and empty lanes.
    result = vec4(color * alpha, alpha);
}
"""


class ImageCompositor:
    def __init__(self, width, height):
        self.width, self.height = width, height
        self.textures = {}
        self._resources = []
        self.context = None
        try:
            import moderngl
            self.gl = moderngl
            self.context = moderngl.create_standalone_context(require=330)
            renderer = self.context.info.get("GL_RENDERER", "")
            if not renderer or any(name in renderer.lower() for name in
                                   ("llvmpipe", "softpipe", "software", "gdi generic")):
                raise GpuUnavailable("No hardware OpenGL renderer")
            self.label = renderer
            self.program = self.context.program(vertex_shader=_VERTEX, fragment_shader=_FRAGMENT)
            self._resources.append(self.program)
            self.vertex_array = self.context.vertex_array(self.program, [])
            self._resources.append(self.vertex_array)
            self.framebuffer = self.context.simple_framebuffer((width, height), components=3)
            self._resources.append(self.framebuffer)
            self.program["size"].value = (width, height)
            for index, name in enumerate(("pixels0", "alpha0", "pixels1", "alpha1")):
                self.program[name].value = index
            self.context.enable(moderngl.BLEND)
            self.context.blend_func = (moderngl.ONE, moderngl.ONE_MINUS_SRC_ALPHA)
        except Exception as error:
            # A lost driver may also fail during cleanup. Preserve the public
            # unavailable error so the renderer can always retry on the CPU.
            with contextlib.suppress(Exception):
                self.close()
            raise GpuUnavailable(str(error)) from error

    def add(self, key, bgr, alpha):
        if key in self.textures:
            return
        if bgr.shape != (self.height, self.width, 3) or alpha.shape != (self.height, self.width):
            raise ValueError("GPU source dimensions do not match the output")
        pixels = self.context.texture((self.width, self.height), 3,
            data=memoryview(np.ascontiguousarray(bgr, dtype=np.uint8)), alignment=1)
        try:
            mask = self.context.texture((self.width, self.height), 1,
                data=memoryview(np.ascontiguousarray(alpha, dtype=np.float32)), dtype="f4", alignment=1)
        except Exception:
            pixels.release()
            raise
        self.textures[key] = (pixels, mask)

    def render(self, layers):
        self.framebuffer.use()
        self.framebuffer.clear(0, 0, 0, 1)
        for layer in layers:
            incoming = layer.get("incoming") or layer
            for offset, item in ((0, layer), (2, incoming)):
                pixels, alpha = self.textures[item["key"]]
                pixels.use(offset)
                alpha.use(offset + 1)
            self.program["scale0"].value = float(layer.get("scale", 1))
            self.program["scale1"].value = float(incoming.get("scale", 1))
            self.program["opacity0"].value = float(layer.get("opacity", 1))
            self.program["opacity1"].value = float(incoming.get("opacity", 1))
            self.program["transition"].value = ({"fade": 1, "black": 2, "white": 3}[layer.get("transition", "fade")]
                if layer.get("incoming") else 0)
            self.program["beta"].value = float(layer.get("beta", 0))
            self.vertex_array.render(mode=self.gl.TRIANGLES, vertices=3)
        return self.framebuffer.read(components=3, alignment=1)

    def release_unused(self, keys):
        for key in list(self.textures):
            if key not in keys:
                failure = None
                for texture in self.textures.pop(key):
                    try:
                        texture.release()
                    except Exception as error:
                        failure = failure or error
                if failure is not None:
                    raise failure

    def close(self):
        # Clear ownership first: shutdown remains idempotent even when release
        # raises, and one broken resource must not prevent releasing the rest.
        textures, self.textures = self.textures, {}
        resources, self._resources = self._resources, []
        context, self.context = self.context, None
        for pair in textures.values():
            for texture in pair:
                with contextlib.suppress(Exception):
                    texture.release()
        for resource in reversed(resources):
            with contextlib.suppress(Exception):
                resource.release()
        if context is not None:
            with contextlib.suppress(Exception):
                context.release()
