"use client";

import { useEffect, useRef, type CSSProperties, type MouseEventHandler, type ReactNode } from "react";
import { Color, Mesh, Program, Renderer, Triangle } from "ogl";

type SpecularButtonSize = "sm" | "md" | "lg";

type SpecularButtonProps = {
  children?: ReactNode;
  size?: SpecularButtonSize;
  radius?: number;
  tint?: string;
  tintOpacity?: number;
  blur?: number;
  textColor?: string;
  lineColor?: string;
  baseColor?: string;
  intensity?: number;
  shineSize?: number;
  shineFade?: number;
  thickness?: number;
  speed?: number;
  followMouse?: boolean;
  proximity?: number;
  autoAnimate?: boolean;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  className?: string;
  type?: "button" | "submit" | "reset";
};

const PAD = 20;

const VERTEX_SHADER = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec2 uCenter;
uniform vec2 uHalfSize;
uniform float uRadius;
uniform float uAngle;
uniform float uPx;
uniform vec3 uLineColor;
uniform vec3 uBaseColor;
uniform float uIntensity;
uniform float uShineSize;
uniform float uShineFade;
uniform float uThickness;
uniform float uBaseWidth;
out vec4 fragColor;

float roundedRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float lineGlow(float distanceToEdge, float sigma) {
  float x = distanceToEdge / (sigma + 0.000001);
  return exp(-mix(1.0, 1.6, smoothstep(0.0, 1.5, x)) * x * x);
}

void main() {
  vec2 point = gl_FragCoord.xy - uCenter;
  float distanceToEdge = roundedRect(point, uHalfSize, uRadius);
  vec2 lightDirection = vec2(cos(uAngle), sin(uAngle));
  float base = (1.0 - smoothstep(0.0, uBaseWidth, abs(distanceToEdge))) * 0.45;
  vec2 normal = normalize(point / (uHalfSize * uHalfSize) + 0.000001);
  float angle = acos(clamp(abs(dot(normal, lightDirection)), 0.0, 1.0));
  float rim = 1.0 - smoothstep(uShineSize - uShineFade, uShineSize + uShineFade + 0.0001, angle);
  float edge = 1.0 - smoothstep(0.5 * uPx, 3.0 * uPx, abs(distanceToEdge));
  float highlight = lineGlow(distanceToEdge, uThickness) * rim * edge * uIntensity;
  vec3 color = uBaseColor * base + uLineColor * highlight;
  fragColor = vec4(color, clamp(base + highlight, 0.0, 1.0));
}
`;

type SpecularProps = {
  radius: number;
  lineColor: string;
  baseColor: string;
  intensity: number;
  shineSize: number;
  shineFade: number;
  thickness: number;
  speed: number;
  followMouse: boolean;
  proximity: number;
  autoAnimate: boolean;
};

export default function SpecularButton({
  children = "Get Started",
  size = "lg",
  radius = 18,
  tint = "#ffffff",
  tintOpacity = 0,
  blur = 0,
  textColor = "#f5f5f5",
  lineColor = "#ffffff",
  baseColor = "#525252",
  intensity = 1,
  shineSize = 10,
  shineFade = 40,
  thickness = 1,
  speed = 0.35,
  followMouse = true,
  proximity = 250,
  autoAnimate = false,
  disabled = false,
  onClick,
  className = "",
  type = "button",
}: SpecularButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const effectRef = useRef<HTMLSpanElement>(null);
  const propsRef = useRef<SpecularProps>({
    radius, lineColor, baseColor, intensity, shineSize, shineFade,
    thickness, speed, followMouse, proximity, autoAnimate,
  });

  useEffect(() => {
    propsRef.current = {
      radius, lineColor, baseColor, intensity, shineSize, shineFade,
      thickness, speed, followMouse, proximity, autoAnimate,
    };
  }, [radius, lineColor, baseColor, intensity, shineSize, shineFade, thickness, speed, followMouse, proximity, autoAnimate]);

  useEffect(() => {
    const button = buttonRef.current;
    const effect = effectRef.current;
    if (!button || !effect || typeof window === "undefined") return;

    let renderer: Renderer | null = null;
    let frame: number | null = null;
    try {
      renderer = new Renderer({ alpha: true, premultipliedAlpha: true, antialias: true, dpr: Math.min(window.devicePixelRatio || 1, 2) });
      const gl = renderer.gl;
      gl.clearColor(0, 0, 0, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      const geometry = new Triangle(gl);
      if (geometry.attributes.uv) delete geometry.attributes.uv;
      const program = new Program(gl, {
        vertex: VERTEX_SHADER,
        fragment: FRAGMENT_SHADER,
        uniforms: {
          uCenter: { value: [0, 0] }, uHalfSize: { value: [1, 1] }, uRadius: { value: 0 },
          uAngle: { value: 2.4 }, uPx: { value: renderer.dpr }, uLineColor: { value: [1, 1, 1] },
          uBaseColor: { value: [0.32, 0.32, 0.32] }, uIntensity: { value: 1 },
          uShineSize: { value: 0.17 }, uShineFade: { value: 0.7 }, uThickness: { value: 1 },
          uBaseWidth: { value: renderer.dpr },
        },
      });
      const mesh = new Mesh(gl, { geometry, program });
      effect.appendChild(gl.canvas);

      const size = { width: 1, height: 1 };
      const resize = () => {
        const rect = button.getBoundingClientRect();
        size.width = rect.width;
        size.height = rect.height;
        renderer?.setSize(rect.width + PAD * 2, rect.height + PAD * 2);
        program.uniforms.uCenter.value = [(PAD + rect.width / 2) * (renderer?.dpr ?? 1), (PAD + rect.height / 2) * (renderer?.dpr ?? 1)];
        program.uniforms.uHalfSize.value = [(rect.width / 2) * (renderer?.dpr ?? 1), (rect.height / 2) * (renderer?.dpr ?? 1)];
      };
      const resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(button);
      resize();

      let pointerAngle: number | null = null;
      let proximityValue = 0;
      const handlePointerMove = (event: PointerEvent) => {
        const rect = button.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const distanceX = Math.max(rect.left - event.clientX, 0, event.clientX - rect.right);
        const distanceY = Math.max(rect.top - event.clientY, 0, event.clientY - rect.bottom);
        const distance = Math.hypot(distanceX, distanceY);
        if (distance === 0) {
          const nx = (event.clientX - centerX) / (rect.width / 2);
          const ny = (centerY - event.clientY) / (rect.height / 2);
          pointerAngle = Math.atan2(2 / rect.height, -2 / rect.width) + nx * 0.3 + ny * 0.15;
        } else {
          pointerAngle = Math.atan2(centerY - event.clientY, event.clientX - centerX);
        }
        const t = Math.max(0, 1 - distance / Math.max(propsRef.current.proximity, 1));
        proximityValue = t * t * (3 - 2 * t);
      };
      window.addEventListener("pointermove", handlePointerMove, { passive: true });

      let angle = 2.4;
      let idleAngle = 2.4;
      let brightness = 0;
      let last = performance.now();
      const line = new Color();
      const base = new Color();
      let lineKey = "";
      let baseKey = "";
      let lineValue = [1, 1, 1];
      let baseValue = [0.32, 0.32, 0.32];
      let isVisible = true;
      let schedule = () => undefined;
      const update = (now: number) => {
        const currentRenderer = renderer;
        frame = null;
        if (!currentRenderer || !isVisible || document.hidden) return;
        const delta = Math.min((now - last) / 1000, 0.05);
        last = now;
        const props = propsRef.current;
        idleAngle += props.speed * delta;
        const steer = props.followMouse && pointerAngle !== null && (!props.autoAnimate || proximityValue > 0);
        const target = steer ? pointerAngle ?? idleAngle : idleAngle;
        const difference = ((target - angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        angle += difference * (1 - Math.exp(-delta * 7));
        const targetBrightness = props.autoAnimate ? 1 : proximityValue;
        brightness += (targetBrightness - brightness) * (1 - Math.exp(-delta * 8));
        if (props.lineColor !== lineKey) {
          lineKey = props.lineColor;
          line.set(lineKey);
          lineValue = [line.r, line.g, line.b];
        }
        if (props.baseColor !== baseKey) {
          baseKey = props.baseColor;
          base.set(baseKey);
          baseValue = [base.r, base.g, base.b];
        }
        program.uniforms.uAngle.value = angle;
        program.uniforms.uRadius.value = Math.min(props.radius, Math.min(size.width, size.height) / 2) * currentRenderer.dpr;
        program.uniforms.uLineColor.value = lineValue;
        program.uniforms.uBaseColor.value = baseValue;
        program.uniforms.uIntensity.value = props.intensity * brightness;
        program.uniforms.uShineSize.value = (props.shineSize * Math.PI) / 180;
        program.uniforms.uShineFade.value = (props.shineFade * Math.PI) / 180;
        program.uniforms.uThickness.value = props.thickness * currentRenderer.dpr;
        currentRenderer.render({ scene: mesh });
        schedule();
      };
      schedule = () => {
        if (frame === null && isVisible && !document.hidden) frame = window.requestAnimationFrame(update);
      };
      const visibilityObserver = new IntersectionObserver((entries) => {
        isVisible = entries[0]?.isIntersecting !== false;
        if (isVisible) schedule();
      }, { threshold: 0.05 });
      visibilityObserver.observe(button);
      const handleVisibilityChange = () => {
        if (document.hidden) {
          if (frame !== null) window.cancelAnimationFrame(frame);
          frame = null;
          return;
        }
        last = performance.now();
        schedule();
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);
      schedule();

      return () => {
        if (frame !== null) window.cancelAnimationFrame(frame);
        resizeObserver.disconnect();
        visibilityObserver.disconnect();
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        window.removeEventListener("pointermove", handlePointerMove);
        if (gl.canvas.parentNode === effect) effect.removeChild(gl.canvas);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      };
    } catch {
      // Keep the button fully usable when WebGL is unavailable.
      renderer?.gl.getExtension("WEBGL_lose_context")?.loseContext();
      return undefined;
    }
  }, []);

  return (
    <button
      ref={buttonRef}
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`specular-button specular-button--${size}${className ? ` ${className}` : ""}`}
      style={{
        "--sb-radius": `${radius}px`,
        "--sb-tint": tint,
        "--sb-tint-opacity": tintOpacity,
        "--sb-blur": `${blur}px`,
        "--sb-text-color": textColor,
      } as CSSProperties}
    >
      <span ref={effectRef} className="specular-button__fx" aria-hidden="true" />
      <span className="specular-button__label">{children}</span>
    </button>
  );
}
