/*
 * Static GitHub Pages adaptation of React Bits' LightRays.
 * It uses the same shader idea without adding a runtime dependency to the
 * static site, so Railway's React bundle remains untouched.
 */
(function () {
  "use strict";

  const VERTEX_SHADER = `
    attribute vec2 position;
    void main() { gl_Position = vec4(position, 0.0, 1.0); }
  `;

  const FRAGMENT_SHADER = `
    precision mediump float;
    uniform float iTime;
    uniform vec2 iResolution;
    uniform vec2 rayPos;
    uniform vec2 rayDir;
    uniform vec3 raysColor;
    uniform float raysSpeed;
    uniform float lightSpread;
    uniform float rayLength;
    uniform float pulsating;
    uniform float fadeDistance;
    uniform float mouseInfluence;
    uniform vec2 mousePos;

    float rayStrength(vec2 source, vec2 direction, vec2 coord, float seedA, float seedB, float speed) {
      vec2 sourceToCoord = coord - source;
      float distanceToSource = length(sourceToCoord);
      vec2 directionToCoord = normalize(sourceToCoord);
      float angle = dot(directionToCoord, direction);
      float spread = pow(max(angle, 0.0), 1.0 / max(lightSpread, 0.001));
      float maxDistance = iResolution.x * rayLength;
      float lengthFade = clamp((maxDistance - distanceToSource) / maxDistance, 0.0, 1.0);
      float distanceFade = clamp((iResolution.x * fadeDistance - distanceToSource) / (iResolution.x * fadeDistance), 0.35, 1.0);
      float pulse = pulsating > 0.5 ? 0.84 + 0.16 * sin(iTime * speed * 3.0) : 1.0;
      float texture = (0.45 + 0.15 * sin(angle * seedA + iTime * speed))
        + (0.3 + 0.2 * cos(-angle * seedB + iTime * speed));
      return clamp(texture, 0.0, 1.0) * spread * lengthFade * distanceFade * pulse;
    }

    void main() {
      vec2 coord = vec2(gl_FragCoord.x, iResolution.y - gl_FragCoord.y);
      vec2 direction = rayDir;
      if (mouseInfluence > 0.0) {
        vec2 mouseDirection = normalize(mousePos * iResolution - rayPos);
        direction = normalize(mix(rayDir, mouseDirection, mouseInfluence));
      }
      float rays = rayStrength(rayPos, direction, coord, 36.2, 21.1, 1.5 * raysSpeed) * 0.5;
      rays += rayStrength(rayPos, direction, coord, 22.4, 18.0, 1.1 * raysSpeed) * 0.4;
      float brightness = 1.0 - coord.y / iResolution.y;
      vec3 color = raysColor * rays;
      color.r *= 0.1 + brightness * 0.8;
      color.g *= 0.3 + brightness * 0.6;
      color.b *= 0.5 + brightness * 0.5;
      gl_FragColor = vec4(color, clamp(rays * 0.9, 0.0, 0.8));
    }
  `;

  function hexToRgb(hex) {
    const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "#ffffff");
    return match
      ? [parseInt(match[1], 16) / 255, parseInt(match[2], 16) / 255, parseInt(match[3], 16) / 255]
      : [1, 1, 1];
  }

  function getAnchorAndDirection(origin, width, height) {
    const outside = 0.2;
    switch (origin) {
      case "top-left": return { anchor: [0, -outside * height], direction: [0, 1] };
      case "top-right": return { anchor: [width, -outside * height], direction: [0, 1] };
      case "left": return { anchor: [-outside * width, 0.5 * height], direction: [1, 0] };
      case "right": return { anchor: [(1 + outside) * width, 0.5 * height], direction: [-1, 0] };
      case "bottom-left": return { anchor: [0, (1 + outside) * height], direction: [0, -1] };
      case "bottom-right": return { anchor: [width, (1 + outside) * height], direction: [0, -1] };
      case "bottom-center": return { anchor: [0.5 * width, (1 + outside) * height], direction: [0, -1] };
      default: return { anchor: [0.5 * width, -outside * height], direction: [0, 1] };
    }
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function mount(container, options) {
    if (!container || !window.WebGLRenderingContext) return function () {};
    const settings = Object.assign({
      raysOrigin: "top-center",
      raysColor: "#ffbd1f",
      raysSpeed: 0.45,
      lightSpread: 0.8,
      rayLength: 1.35,
      pulsating: true,
      fadeDistance: 1.1,
      followMouse: true,
      mouseInfluence: 0.08,
    }, options || {});
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    container.replaceChildren(canvas);
    const gl = canvas.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: true });
    if (!gl) return function () { canvas.remove(); };

    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vertex || !fragment) return function () { canvas.remove(); };
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return function () { canvas.remove(); };

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "position");
    const uniform = (name) => gl.getUniformLocation(program, name);
    const uniforms = {
      time: uniform("iTime"), resolution: uniform("iResolution"), rayPos: uniform("rayPos"),
      rayDir: uniform("rayDir"), color: uniform("raysColor"), speed: uniform("raysSpeed"),
      spread: uniform("lightSpread"), length: uniform("rayLength"), pulse: uniform("pulsating"),
      fade: uniform("fadeDistance"), mouseInfluence: uniform("mouseInfluence"), mouse: uniform("mousePos"),
    };
    const mouse = { x: 0.5, y: 0.5 };
    const smoothMouse = { x: 0.5, y: 0.5 };
    let frame = null;
    let visible = true;
    let width = 1;
    let height = 1;
    let dpr = 1;
    let lastTime = 0;

    function resize() {
      width = Math.max(1, container.clientWidth);
      height = Math.max(1, container.clientHeight);
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      gl.viewport(0, 0, canvas.width, canvas.height);
      const placement = getAnchorAndDirection(settings.raysOrigin, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform2f(uniforms.rayPos, placement.anchor[0], placement.anchor[1]);
      gl.uniform2f(uniforms.rayDir, placement.direction[0], placement.direction[1]);
    }

    function render(time) {
      frame = null;
      if (!visible) return;
      const delta = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;
      smoothMouse.x += (mouse.x - smoothMouse.x) * Math.min(1, delta * 5);
      smoothMouse.y += (mouse.y - smoothMouse.y) * Math.min(1, delta * 5);
      gl.useProgram(program);
      gl.uniform1f(uniforms.time, time * 0.001);
      gl.uniform3fv(uniforms.color, hexToRgb(settings.raysColor));
      gl.uniform1f(uniforms.speed, settings.raysSpeed);
      gl.uniform1f(uniforms.spread, settings.lightSpread);
      gl.uniform1f(uniforms.length, settings.rayLength);
      gl.uniform1f(uniforms.pulse, settings.pulsating ? 1 : 0);
      gl.uniform1f(uniforms.fade, settings.fadeDistance);
      gl.uniform1f(uniforms.mouseInfluence, settings.followMouse ? settings.mouseInfluence : 0);
      gl.uniform2f(uniforms.mouse, smoothMouse.x, smoothMouse.y);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      frame = window.requestAnimationFrame(render);
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const visibilityObserver = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting !== false;
      if (visible && frame === null) {
        lastTime = performance.now();
        frame = window.requestAnimationFrame(render);
      }
    }, { threshold: 0.05 });
    visibilityObserver.observe(container);
    const onMouseMove = (event) => {
      const rect = container.getBoundingClientRect();
      mouse.x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      mouse.y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    };
    if (settings.followMouse) window.addEventListener("mousemove", onMouseMove, { passive: true });
    resize();
    frame = window.requestAnimationFrame(render);

    return function cleanup() {
      visible = false;
      if (frame !== null) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      if (settings.followMouse) window.removeEventListener("mousemove", onMouseMove);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      canvas.remove();
    };
  }

  window.LightRays = { mount: mount };
})();
