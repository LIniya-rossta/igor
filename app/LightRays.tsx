"use client";

import { useEffect, useRef } from "react";

type RaysOrigin =
  | "top-center"
  | "top-left"
  | "top-right"
  | "right"
  | "left"
  | "bottom-center"
  | "bottom-right"
  | "bottom-left";

type LightRaysProps = {
  raysOrigin?: RaysOrigin;
  raysColor?: string;
  raysSpeed?: number;
  lightSpread?: number;
  rayLength?: number;
  pulsating?: boolean;
  fadeDistance?: number;
  followMouse?: boolean;
  mouseInfluence?: number;
  className?: string;
};

const vertexShader = `
  attribute vec2 position;
  void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const fragmentShader = `
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
  uniform vec2 mousePos;
  uniform float mouseInfluence;

  float noise(vec2 point) {
    return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453);
  }

  float rayStrength(vec2 source, vec2 direction, vec2 coord, float seedA, float seedB, float speed) {
    vec2 sourceToCoord = coord - source;
    float distanceToSource = length(sourceToCoord);
    vec2 directionToCoord = normalize(sourceToCoord);
    float angle = dot(directionToCoord, direction);
    float spread = pow(max(angle, 0.0), 1.0 / max(lightSpread, 0.001));
    float maxDistance = iResolution.x * rayLength;
    float lengthFade = clamp((maxDistance - distanceToSource) / maxDistance, 0.0, 1.0);
    float distanceFade = clamp((iResolution.x * fadeDistance - distanceToSource) / (iResolution.x * fadeDistance), 0.32, 1.0);
    float pulse = pulsating > 0.5 ? 0.82 + 0.18 * sin(iTime * speed * 3.0) : 1.0;
    float texture = (0.45 + 0.15 * sin(angle * seedA + iTime * speed))
      + (0.3 + 0.2 * cos(-angle * seedB + iTime * speed));
    float grain = 0.94 + noise(coord * 0.008 + iTime * 0.08) * 0.06;
    return clamp(texture, 0.0, 1.0) * spread * lengthFade * distanceFade * pulse * grain;
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
    gl_FragColor = vec4(color, clamp(rays * 0.72, 0.0, 0.65));
  }
`;

function hexToRgb(hex: string) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return match
    ? [Number.parseInt(match[1], 16) / 255, Number.parseInt(match[2], 16) / 255, Number.parseInt(match[3], 16) / 255]
    : [1, 1, 1];
}

function getAnchorAndDirection(origin: RaysOrigin, width: number, height: number) {
  const outside = 0.2;
  switch (origin) {
    case "top-left": return { anchor: [0, -outside * height], direction: [0, 1] };
    case "top-right": return { anchor: [width, -outside * height], direction: [0, 1] };
    case "left": return { anchor: [-outside * width, 0.5 * height], direction: [1, 0] };
    case "right": return { anchor: [(1 + outside) * width, 0.5 * height], direction: [-1, 0] };
    case "bottom-left": return { anchor: [0, (1 + outside) * height], direction: [0, -1] };
    case "bottom-center": return { anchor: [0.5 * width, (1 + outside) * height], direction: [0, -1] };
    case "bottom-right": return { anchor: [width, (1 + outside) * height], direction: [0, -1] };
    default: return { anchor: [0.5 * width, -outside * height], direction: [0, 1] };
  }
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export default function LightRays({
  raysOrigin = "top-center",
  raysColor = "#ffbd1f",
  raysSpeed = 0.55,
  lightSpread = 0.82,
  rayLength = 1.35,
  pulsating = true,
  fadeDistance = 1.1,
  followMouse = true,
  mouseInfluence = 0.08,
  className = "",
}: LightRaysProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef({ raysOrigin, raysColor, raysSpeed, lightSpread, rayLength, pulsating, fadeDistance, followMouse, mouseInfluence });

  useEffect(() => {
    propsRef.current = { raysOrigin, raysColor, raysSpeed, lightSpread, rayLength, pulsating, fadeDistance, followMouse, mouseInfluence };
  }, [raysOrigin, raysColor, raysSpeed, lightSpread, rayLength, pulsating, fadeDistance, followMouse, mouseInfluence]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    container.replaceChildren(canvas);
    const gl = canvas.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: true });
    if (!gl) return () => canvas.remove();

    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexShader);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShader);
    if (!vertex || !fragment) return () => canvas.remove();
    const program = gl.createProgram();
    if (!program) return () => canvas.remove();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return () => canvas.remove();

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "position");
    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const uniforms = {
      time: uniform("iTime"), resolution: uniform("iResolution"), rayPos: uniform("rayPos"), rayDir: uniform("rayDir"),
      color: uniform("raysColor"), speed: uniform("raysSpeed"), spread: uniform("lightSpread"), length: uniform("rayLength"),
      pulse: uniform("pulsating"), fade: uniform("fadeDistance"), mouse: uniform("mousePos"), mouseInfluence: uniform("mouseInfluence"),
    };
    const targetMouse = { x: 0.5, y: 0.5 };
    const smoothMouse = { x: 0.5, y: 0.5 };
    let frame: number | null = null;
    let visible = true;
    let lastTime = performance.now();
    let placementOrigin = "";
    let colorKey = "";
    let rayColor = [1, 1, 1];

    const applyPlacement = () => {
      const placement = getAnchorAndDirection(propsRef.current.raysOrigin, canvas.width, canvas.height);
      placementOrigin = propsRef.current.raysOrigin;
      gl.useProgram(program);
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform2f(uniforms.rayPos, placement.anchor[0], placement.anchor[1]);
      gl.uniform2f(uniforms.rayDir, placement.direction[0], placement.direction[1]);
    };

    const resize = () => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      const baseDpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const longest = Math.max(width, height) * baseDpr;
      const dpr = longest > 1600 ? (baseDpr * 1600) / longest : baseDpr;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      gl.viewport(0, 0, canvas.width, canvas.height);
      applyPlacement();
    };

    let schedule = () => undefined;

    const render = (time: number) => {
      frame = null;
      if (!visible || document.hidden) return;
      const delta = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;
      smoothMouse.x += (targetMouse.x - smoothMouse.x) * Math.min(1, delta * 4);
      smoothMouse.y += (targetMouse.y - smoothMouse.y) * Math.min(1, delta * 4);
      const props = propsRef.current;
      if (props.raysOrigin !== placementOrigin) applyPlacement();
      if (props.raysColor !== colorKey) {
        colorKey = props.raysColor;
        rayColor = hexToRgb(colorKey);
      }
      gl.useProgram(program);
      gl.uniform1f(uniforms.time, time * 0.001);
      gl.uniform3fv(uniforms.color, rayColor);
      gl.uniform1f(uniforms.speed, props.raysSpeed);
      gl.uniform1f(uniforms.spread, props.lightSpread);
      gl.uniform1f(uniforms.length, props.rayLength);
      gl.uniform1f(uniforms.pulse, props.pulsating ? 1 : 0);
      gl.uniform1f(uniforms.fade, props.fadeDistance);
      gl.uniform1f(uniforms.mouseInfluence, props.followMouse ? props.mouseInfluence : 0);
      gl.uniform2f(uniforms.mouse, smoothMouse.x, smoothMouse.y);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      schedule();
    };

    schedule = () => {
      if (frame === null && visible && !document.hidden) frame = window.requestAnimationFrame(render);
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const visibilityObserver = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting !== false;
      if (visible && frame === null) {
        lastTime = performance.now();
        schedule();
      }
    }, { threshold: 0.05 });
    visibilityObserver.observe(container);
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (frame !== null) window.cancelAnimationFrame(frame);
        frame = null;
        return;
      }
      lastTime = performance.now();
      schedule();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const handleMouseMove = (event: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      targetMouse.x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      targetMouse.y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    };
    const handleMouseLeave = () => { targetMouse.x = 0.5; targetMouse.y = 0.5; };
    if (followMouse) {
      window.addEventListener("mousemove", handleMouseMove, { passive: true });
      container.addEventListener("mouseleave", handleMouseLeave);
    }
    resize();
    schedule();

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("mousemove", handleMouseMove);
      container.removeEventListener("mouseleave", handleMouseLeave);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    };
  }, [followMouse]);

  return <div ref={containerRef} className={`light-rays-container${className ? ` ${className}` : ""}`} aria-hidden="true" />;
}
