import { useCallback, useEffect, useRef, useState } from "react";

interface Offset {
  x: number;
  y: number;
}

// Drag a floating panel by its header. The caller spreads `headerProps` onto
// the draggable handle and `style` onto the panel container; the panel must be
// `position: absolute` (or fixed) so transform-based offset is meaningful.
//
// initialOffset lets you save+restore a panel's last position if needed.
export function useDraggable(initialOffset: Offset = { x: 0, y: 0 }) {
  const [offset, setOffset] = useState<Offset>(initialOffset);
  const dragging = useRef(false);
  const start = useRef<{ x: number; y: number; ox: number; oy: number }>({
    x: 0,
    y: 0,
    ox: 0,
    oy: 0,
  });

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Ignore clicks on buttons/inputs inside the header.
      const target = e.target as HTMLElement;
      if (target.closest("button, input, a, select, textarea")) return;
      dragging.current = true;
      start.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    },
    [offset.x, offset.y]
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      setOffset({
        x: start.current.ox + (e.clientX - start.current.x),
        y: start.current.oy + (e.clientY - start.current.y),
      });
    };
    const onUp = () => {
      dragging.current = false;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const style: React.CSSProperties = {
    transform: `translate(${offset.x}px, ${offset.y}px)`,
  };

  const headerProps = {
    onPointerDown,
    style: { cursor: "grab", touchAction: "none" as const },
  };

  return { offset, setOffset, style, headerProps };
}
