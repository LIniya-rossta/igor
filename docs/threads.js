/* Static GitHub Pages adaptation of React Bits' Threads. */
(function () {
  "use strict";

  const VERTEX_SHADER = `
    attribute vec2 position;
    void main() { gl_Position = vec4(position, 0.0, 1.0); }
  `;

  const FRAGMENT_SHADER = `
    precision mediump float;
    uniform float iTime;
    uniform vec3 iResolution;
    uniform vec3 uColor;
    uniform float uAmplitude;
    uniform float uDistance;
    uniform vec2 uMouse;

    float noise(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    float pixel(float count) {
      return (1.0 / max(iResolution.x, iResolution.y)) * count;
    }

    float lineFn(vec2 st, float width, float percent, vec2 mouse, float time, float amplitude, float distance) {
      float splitPoint = 0.1 + percent * 0.4;
      float amplitudeNormal = smoothstep(splitPoint, 0.7, st.x);
      float finalAmplitude = amplitudeNormal * 0.5 * amplitude * (1.0 + (mouse.y - 0.5) * 0.2);
      float timeScaled = time / 10.0 + (mouse.x - 0.5);
      float blur = smoothstep(splitPoint, splitPoint + 0.05, st.x) * percent;
      float xNoise = mix(
        noise(vec2(timeScaled, st.x + percent) * 2.5),
        noise(vec2(timeScaled, st.x + timeScaled) * 3.5) / 1.5,
        st.x * 0.3
      );
      float y = 0.5 + (percent - 0.5) * distance + xNoise / 2.0 * finalAmplitude;
      float lineStart = smoothstep(y + width / 2.0 + 10.0 * pixel(1.0) * blur, y, st.y);
      float lineEnd = smoothstep(y, y - width / 2.0 - 10.0 * pixel(1.0) * blur, st.y);
      return clamp((lineStart - lineEnd) * (1.0 - smoothstep(0.0, 1.0, pow(percent, 0.3))), 0.0, 1.0);
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / iResolution.xy;
      float lineStrength = 1.0;
      for (int i = 0; i < 40; i++) {
        float percent = float(i) / 40.0;
        lineStrength *= 1.0 - lineFn(
          uv,
          7.0 * pixel(1.0) * (1.0 - percent),
          percent,
          uMouse,
          iTime,
          uAmplitude,
          uDistance
        );
      }
      float value = 1.0 - lineStrength;
      gl_FragColor = vec4(uColor * value, value * 0.72);
    }
  `;

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
      color: [1, 0.74, 0.12],
      amplitude: 0.42,
      distance: 0.02,
      enableMouseInteraction: true,
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
    const getUniform = (name) => gl.getUniformLocation(program, name);
    const uniforms = {
      time: getUniform("iTime"), resolution: getUniform("iResolution"), color: getUniform("uColor"),
      amplitude: getUniform("uAmplitude"), distance: getUniform("uDistance"), mouse: getUniform("uMouse"),
    };
    const targetMouse = [0.5, 0.5];
    const currentMouse = [0.5, 0.5];
    let frame = null;
    let visible = true;
    let lastTime = 0;

    function resize() {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      const baseDpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const longest = Math.max(width, height) * baseDpr;
      const dpr = longest > 1400 ? (baseDpr * 1400) / longest : baseDpr;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.uniform3f(uniforms.resolution, canvas.width, canvas.height, canvas.width / canvas.height);
    }

    function render(time) {
      frame = null;
      if (!visible || document.hidden) return;
      const delta = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;
      const smoothing = Math.min(1, delta * 4);
      currentMouse[0] += (targetMouse[0] - currentMouse[0]) * smoothing;
      currentMouse[1] += (targetMouse[1] - currentMouse[1]) * smoothing;
      gl.useProgram(program);
      gl.uniform1f(uniforms.time, time * 0.001);
      gl.uniform3fv(uniforms.color, settings.color);
      gl.uniform1f(uniforms.amplitude, settings.amplitude);
      gl.uniform1f(uniforms.distance, settings.distance);
      gl.uniform2f(uniforms.mouse, settings.enableMouseInteraction ? currentMouse[0] : 0.5, settings.enableMouseInteraction ? currentMouse[1] : 0.5);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
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
    const onPointerMove = (event) => {
      const rect = container.getBoundingClientRect();
      targetMouse[0] = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      targetMouse[1] = Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / rect.height));
    };
    const onPointerLeave = () => { targetMouse[0] = 0.5; targetMouse[1] = 0.5; };
    if (settings.enableMouseInteraction) {
      container.addEventListener("pointermove", onPointerMove, { passive: true });
      container.addEventListener("pointerleave", onPointerLeave, { passive: true });
    }
    resize();
    frame = window.requestAnimationFrame(render);

    return function cleanup() {
      visible = false;
      if (frame !== null) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      if (settings.enableMouseInteraction) {
        container.removeEventListener("pointermove", onPointerMove);
        container.removeEventListener("pointerleave", onPointerLeave);
      }
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      canvas.remove();
    };
  }

  window.Threads = { mount: mount };
})();
